import type {
  Database,
  ConversationRepository,
  JobRepository,
  EventRepository,
  OutboxRepository,
  SettingsRepository,
  AiConfigRepository,
  JobExecutionContext,
} from "@messenger/db";
import { conversations, messages, jobs } from "@messenger/db";
import { eq, and } from "drizzle-orm";
import type { OutboxBroadcaster } from "../../sse/outbox-broadcaster.js";
import {
  fetchMediaSecurely,
  transcribeAudio,
  generateInternalMediaRef,
  globalMediaCache,
  extractVideoMetadataAndFrames,
  extractFileTextSafely,
  checkResourceQuota,
} from "@messenger/ai";
import type { MessagePart, ContentStatus } from "@messenger/contracts";

export interface MediaEnrichmentJobPayload {
  channelAccountId: string;
  conversationId: string;
  messageId: string;
  externalMessageId?: string;
  inboundVersion: number;
  controlEpoch?: number;
  contentRevision?: number;
  partId?: string;
}

export interface MediaEnrichmentHandlerDeps {
  db: Database;
  convRepo: ConversationRepository;
  jobRepo?: JobRepository;
  eventRepo: EventRepository;
  outboxRepo: OutboxRepository;
  broadcaster: OutboxBroadcaster;
  settingsRepo: SettingsRepository;
  aiConfigRepo?: AiConfigRepository;
  browserBridge?: (blobUrl: string) => Promise<Buffer | Uint8Array | null>;
}

export function createMediaEnrichmentHandler(deps: MediaEnrichmentHandlerDeps) {
  const {
    db,
    convRepo,
    eventRepo,
    outboxRepo,
    broadcaster,
    settingsRepo,
    aiConfigRepo,
    browserBridge,
  } = deps;

  return async function handleMediaEnrichment(context: JobExecutionContext): Promise<void> {
    const payload = context.job.payload as unknown as MediaEnrichmentJobPayload;
    const { channelAccountId, conversationId, messageId, inboundVersion } = payload;

    if (!channelAccountId || !conversationId || !messageId) {
      console.warn("[MediaEnrichmentHandler] Missing required job payload", payload);
      return;
    }

    // 1. Pre-execution fencing check: verify conversation exists and check reply control
    const [conv] = await db
      .select({
        id: conversations.id,
        inboundVersion: conversations.inboundVersion,
        controlEpoch: conversations.controlEpoch,
        replyControlMode: conversations.replyControlMode,
        manualMode: conversations.manualMode,
        isBlocked: conversations.isBlocked,
      })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);

    if (!conv) {
      console.warn(`[MediaEnrichmentHandler] Conversation not found: ${conversationId}`);
      return;
    }

    if (conv.isBlocked) {
      console.log(`[MediaEnrichmentHandler] Conversation ${conversationId} is blocked. Skipping enrichment.`);
      return;
    }

    // 2. Fetch message row to obtain current parts
    const [msgRow] = await db
      .select({
        id: messages.id,
        externalMessageId: messages.externalMessageId,
        contentRevision: messages.contentRevision,
        contentStatus: messages.contentStatus,
        content: messages.content,
        text: messages.text,
      })
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1);

    if (!msgRow) {
      console.warn(`[MediaEnrichmentHandler] Message ${messageId} not found`);
      return;
    }

    const contentObj = (msgRow.content as { parts?: MessagePart[] }) || {};
    const existingParts = contentObj.parts || [];
    if (!Array.isArray(existingParts) || existingParts.length === 0) {
      // No parts to enrich
      return;
    }

    // 3. Load settings and AI config for caps and credentials
    const { settings } = await settingsRepo.getSettings(channelAccountId);
    const aiConfig = aiConfigRepo ? await aiConfigRepo.getConfig(channelAccountId) : undefined;

    const maxImageBytes = settings.mediaImageMaxBytes ?? 10 * 1024 * 1024;
    const maxVoiceBytes = settings.mediaVoiceMaxBytes ?? 15 * 1024 * 1024;
    const maxVideoBytes = settings.mediaVideoMaxBytes ?? 25 * 1024 * 1024;
    const maxVideoDurationSec = settings.mediaVideoMaxDurationSec ?? 60;
    const maxFileBytes = settings.mediaFileMaxBytes ?? 10 * 1024 * 1024;
    const maxFileChars = settings.mediaFileMaxExtractedChars ?? 10000;

    let hasAnyChanges = false;
    let allPartsSuccessful = true;
    const updatedParts: MessagePart[] = [];

    // 4. Process each part requiring enrichment
    for (const part of existingParts) {
      if (part.type === "IMAGE") {
        const media = part.media;
        // If already READY with valid cached bytes, preserve
        if (media.status === "READY" && (media.mediaRefId ? globalMediaCache.has(media.mediaRefId) : false)) {
          updatedParts.push(part);
          continue;
        }

        const sourceUrl = media.sourceUrl;
        if (!sourceUrl) {
          updatedParts.push(part);
          continue;
        }

        // Fetch securely with caps and SSRF checks
        const fetchRes = await fetchMediaSecurely(sourceUrl, {
          expectedCategory: "IMAGE",
          maxBytes: maxImageBytes,
          timeoutMs: 10000,
          browserContextBridge: browserBridge,
        });

        if (fetchRes.success && fetchRes.mediaRefId) {
          hasAnyChanges = true;
          updatedParts.push({
            ...part,
            media: {
              ...media,
              mediaId: fetchRes.mediaRefId,
              mediaRefId: fetchRes.mediaRefId,
              mimeType: fetchRes.mimeType || media.mimeType,
              byteSize: fetchRes.byteSize ?? media.byteSize,
              status: "READY" as ContentStatus,
            },
          });
        } else {
          hasAnyChanges = true;
          allPartsSuccessful = false;
          console.warn(
            `[MediaEnrichmentHandler] Image ${media.mediaRefId || media.mediaId} failed: ${fetchRes.error || fetchRes.status}`
          );
          updatedParts.push({
            ...part,
            media: {
              ...media,
              status: (fetchRes.status as ContentStatus) || "ERROR",
            },
          });
        }
      } else if (part.type === "VOICE" || part.type === "AUDIO") {
        const media = part.media;
        // If already has transcript, preserve
        if (part.transcript?.text) {
          updatedParts.push(part);
          continue;
        }

        const sourceUrl = media.sourceUrl;
        if (!sourceUrl) {
          updatedParts.push(part);
          continue;
        }

        // Fetch audio securely
        const fetchRes = await fetchMediaSecurely(sourceUrl, {
          expectedCategory: "VOICE",
          maxBytes: maxVoiceBytes,
          timeoutMs: 10000,
          browserContextBridge: browserBridge,
        });

        if (fetchRes.success && fetchRes.buffer && fetchRes.mediaRefId) {
          hasAnyChanges = true;
          let derivedTranscript = null;

          // Perform ASR transcription if not in manualMode
          if (!conv.manualMode) {
            try {
              derivedTranscript = await transcribeAudio({
                audioBuffer: fetchRes.buffer,
                mimeType: fetchRes.mimeType,
                apiKey: aiConfig?.apiKey,
                baseUrl: aiConfig?.baseUrl,
                sourceMessageRef: messageId,
                durationMs: media.durationMs,
              });
              globalMediaCache.updateTranscript(fetchRes.mediaRefId, derivedTranscript);
            } catch (asrErr) {
              console.warn(`[MediaEnrichmentHandler] ASR failed for part in msg ${messageId}:`, asrErr);
            }
          }

          updatedParts.push({
            ...part,
            transcript: derivedTranscript ?? undefined,
            transcriptRef: derivedTranscript ? derivedTranscript.provenance : undefined,
            media: {
              ...media,
              mediaId: fetchRes.mediaRefId,
              mediaRefId: fetchRes.mediaRefId,
              mimeType: fetchRes.mimeType || media.mimeType,
              byteSize: fetchRes.byteSize ?? media.byteSize,
              status: derivedTranscript ? ("READY" as ContentStatus) : ("UNAVAILABLE" as ContentStatus),
            },
          });
        } else {
          hasAnyChanges = true;
          allPartsSuccessful = false;
          updatedParts.push({
            ...part,
            media: {
              ...media,
              status: (fetchRes.status as ContentStatus) || "ERROR",
            },
          });
        }
      } else if (part.type === "VIDEO") {
        const media = part.media;
        if (media.status === "READY" && part.coverage && part.coverage.coverageStatus !== "UNSUPPORTED") {
          updatedParts.push(part);
          continue;
        }

        const sourceUrl = media.sourceUrl;
        const posterUrl = part.posterRef || (media as { thumbnailRef?: string })?.thumbnailRef;

        // Check if system resource limits allow video processing
        const quotaCheck = checkResourceQuota(settings);
        if (!quotaCheck.withinLimits) {
          hasAnyChanges = true;
          allPartsSuccessful = false;
          updatedParts.push({
            ...part,
            media: {
              ...media,
              status: "UNAVAILABLE",
            },
            coverage: {
              container: "video/mp4",
              codecs: [],
              hasVideoTrack: true,
              hasAudioTrack: false,
              framesExtracted: 0,
              audioExtracted: false,
              coverageStatus: "UNSUPPORTED",
              limitationReason: quotaCheck.throttledReason || "RESOURCE_CONSTRAINED",
            },
          });
          continue;
        }

        // Fetch poster frame if posterUrl exists
        let posterBuffer: Buffer | undefined;
        if (posterUrl && (posterUrl.startsWith("http://") || posterUrl.startsWith("https://") || posterUrl.startsWith("blob:"))) {
          const posterRes = await fetchMediaSecurely(posterUrl, {
            expectedCategory: "IMAGE",
            maxBytes: maxImageBytes,
            timeoutMs: 8000,
            browserContextBridge: browserBridge,
          });
          if (posterRes.success && posterRes.buffer) {
            posterBuffer = posterRes.buffer;
          }
        }

        if (!sourceUrl) {
          if (posterBuffer) {
            hasAnyChanges = true;
            const posterMediaRefId = generateInternalMediaRef(posterBuffer, "image/jpeg");
            globalMediaCache.set({
              mediaRefId: posterMediaRefId,
              mimeType: "image/jpeg",
              byteSize: posterBuffer.length,
              buffer: posterBuffer,
              base64: posterBuffer.toString("base64"),
              sourceUrl: posterUrl,
            });
            updatedParts.push({
              ...part,
              posterRef: posterMediaRefId,
              coverage: {
                container: media.mimeType || "video/unknown",
                codecs: [],
                hasVideoTrack: true,
                hasAudioTrack: false,
                framesExtracted: 1,
                audioExtracted: false,
                coverageStatus: "POSTER_ONLY",
                limitationReason: "VIDEO_SOURCE_UNAVAILABLE",
              },
              media: {
                ...media,
                status: "READY",
              },
            });
          } else {
            updatedParts.push(part);
          }
          continue;
        }

        // Fetch video stream securely
        const fetchRes = await fetchMediaSecurely(sourceUrl, {
          expectedCategory: "VIDEO",
          maxBytes: maxVideoBytes,
          timeoutMs: 15000,
          browserContextBridge: browserBridge,
        });

        if (fetchRes.success && fetchRes.buffer) {
          hasAnyChanges = true;
          const extractionRes = await extractVideoMetadataAndFrames(
            fetchRes.buffer,
            fetchRes.mimeType || media.mimeType || "video/mp4",
            {
              maxBytes: maxVideoBytes,
              maxDurationSec: maxVideoDurationSec,
              posterBuffer,
              posterUrl,
              transcribeIfAudio: !conv.manualMode,
            }
          );

          if (extractionRes.status === "READY") {
            updatedParts.push({
              ...part,
              durationMs: extractionRes.coverage.durationMs ?? part.durationMs,
              posterRef: extractionRes.posterMediaRefId || part.posterRef,
              coverage: extractionRes.coverage,
              transcript: extractionRes.transcript || part.transcript,
              media: {
                ...media,
                mediaId: fetchRes.mediaRefId || media.mediaId,
                mimeType: fetchRes.mimeType || media.mimeType,
                byteSize: fetchRes.byteSize ?? media.byteSize,
                status: "READY",
              },
            });
          } else {
            allPartsSuccessful = false;
            updatedParts.push({
              ...part,
              coverage: extractionRes.coverage,
              media: {
                ...media,
                status: extractionRes.status,
              },
            });
          }
        } else {
          hasAnyChanges = true;
          allPartsSuccessful = false;
          updatedParts.push({
            ...part,
            media: {
              ...media,
              status: (fetchRes.status as ContentStatus) || "UNAVAILABLE",
            },
          });
        }
      } else if (part.type === "FILE") {
        const media = part.media;
        if (media.status === "READY" && part.extractedText) {
          updatedParts.push(part);
          continue;
        }

        const sourceUrl = media.sourceUrl;
        if (!sourceUrl) {
          updatedParts.push(part);
          continue;
        }

        // Fetch file content securely
        const fetchRes = await fetchMediaSecurely(sourceUrl, {
          expectedCategory: "FILE",
          maxBytes: maxFileBytes,
          timeoutMs: 10000,
          browserContextBridge: browserBridge,
        });

        if (fetchRes.success && fetchRes.buffer) {
          hasAnyChanges = true;
          const extractRes = extractFileTextSafely(
            fetchRes.buffer,
            part.fileName || fetchRes.mimeType || "text/plain",
            {
              maxBytes: maxFileBytes,
              maxExtractedChars: maxFileChars,
            }
          );

          if (extractRes.status === "READY") {
            updatedParts.push({
              ...part,
              extractedText: extractRes.extractedText,
              extractedChars: extractRes.characterCount,
              media: {
                ...media,
                mediaId: fetchRes.mediaRefId || media.mediaId,
                mimeType: extractRes.mimeType,
                byteSize: fetchRes.byteSize ?? media.byteSize,
                status: "READY",
              },
            });
          } else {
            allPartsSuccessful = false;
            updatedParts.push({
              ...part,
              media: {
                ...media,
                status: extractRes.status,
              },
            });
          }
        } else {
          hasAnyChanges = true;
          allPartsSuccessful = false;
          updatedParts.push({
            ...part,
            media: {
              ...media,
              status: (fetchRes.status as ContentStatus) || "UNAVAILABLE",
            },
          });
        }
      } else {
        updatedParts.push(part);
      }
    }

    if (!hasAnyChanges) {
      return;
    }

    // 5. Post-execution fencing check
    const [latestConv] = await db
      .select({
        id: conversations.id,
        inboundVersion: conversations.inboundVersion,
        controlEpoch: conversations.controlEpoch,
        manualMode: conversations.manualMode,
      })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);

    if (!latestConv) return;

    // 6. Update message enrichment in repository (increments contentRevision, does NOT bump inboundVersion)
    const overallStatus: ContentStatus = allPartsSuccessful ? "READY" : "PARTIAL";
    const updateResult = await convRepo.updateMessageEnrichment({
      channelAccountId,
      externalMessageId: msgRow.externalMessageId,
      parts: updatedParts,
      contentStatus: overallStatus,
      contentRevision: (msgRow.contentRevision || 1) + 1,
    });

    if (!updateResult.isUpdated) {
      console.warn(`[MediaEnrichmentHandler] Failed to persist message enrichment for ${messageId}`);
      return;
    }

    // 7. Worker only updates + wakes
    // Broadcast message:updated event
    await broadcaster.broadcast("message:updated", {
      conversationId,
      messageId,
      contentRevision: updateResult.contentRevision,
      eventKind: updateResult.eventKind,
      contentStatus: updateResult.contentStatus,
      parts: updateResult.parts,
      text: updateResult.text,
    });

    // Record audit event
    await eventRepo.recordEvent({
      channelAccountId,
      conversationId,
      type: "MEDIA_ENRICHED",
      inboundVersion: conv.inboundVersion,
      actor: "SYSTEM",
      payload: {
        messageId,
        contentRevision: updateResult.contentRevision,
        contentStatus: overallStatus,
        allPartsSuccessful,
        failedMedia: updatedParts.flatMap((part) => {
          if (!("media" in part) || !part.media || part.media.status === "READY") return [];
          return [{
            mediaRefId: part.media.mediaRefId || part.media.mediaId,
            status: part.media.status,
          }];
        }),
      },
    });

    // Enqueue transactional outbox event
    await outboxRepo.enqueue({
      channelAccountId,
      conversationId,
      eventType: "message:updated",
      payload: {
        messageId,
        conversationId,
        contentRevision: updateResult.contentRevision,
        contentStatus: overallStatus,
        parts: updateResult.parts,
      },
    });

    // If all parts failed or unreadable on a media-only message, record clarification flag with idempotency
    const isMediaOnly = !msgRow.text || !msgRow.text.trim();
    if (isMediaOnly && !allPartsSuccessful && !conv.manualMode) {
      const clarificationKey = `clarification:${conversationId}:${inboundVersion}:UNREADABLE_MEDIA`;
      // Check if already emitted for this turn
      const [existingClarification] = await db
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            eq(jobs.channelAccountId, channelAccountId),
            eq(jobs.idempotencyKey, clarificationKey)
          )
        )
        .limit(1);

      if (!existingClarification) {
        await eventRepo.recordEvent({
          channelAccountId,
          conversationId,
          type: "CLARIFICATION_ENQUEUED",
          inboundVersion,
          actor: "SYSTEM",
          payload: { reason: "UNREADABLE_MEDIA", clarificationKey },
        });
      }
    }
  };
}
