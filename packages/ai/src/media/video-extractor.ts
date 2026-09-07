import type { ContentStatus, VideoCoverage, DerivedTranscript } from "@messenger/contracts";
import { generateInternalMediaRef, globalMediaCache } from "./cache.js";
import { transcribeAudio } from "../asr.js";

export interface VideoExtractionOptions {
  maxBytes?: number;
  maxDurationSec?: number;
  posterBuffer?: Buffer | Uint8Array;
  posterUrl?: string;
  audioBuffer?: Buffer | Uint8Array;
  browserContextBridge?: (blobUrl: string) => Promise<Buffer | Uint8Array | null>;
  transcribeIfAudio?: boolean;
}

export interface VideoExtractionResult {
  success: boolean;
  status: ContentStatus;
  coverage: VideoCoverage;
  posterMediaRefId?: string;
  transcript?: DerivedTranscript;
  error?: string;
}

const ALLOWED_CONTAINERS = new Set(["video/mp4", "video/webm"]);

const ALLOWED_VIDEO_CODECS = new Set([
  "avc1", // H.264 / AVC
  "h264",
  "vp8",
  "vp9",
  "v_vp8",
  "v_vp9",
]);

const ALLOWED_AUDIO_CODECS = new Set([
  "mp4a", // AAC
  "aac",
  "opus",
  "a_opus",
  "vorbis",
  "a_vorbis",
]);

/**
 * Parses basic MP4 ISO BMFF box structure in pure TypeScript.
 * Extracts timescale, duration, and track codecs from ftyp/moov boxes without dependencies.
 */
function parseMp4Metadata(buffer: Buffer): {
  timescale?: number;
  durationMs?: number;
  codecs: string[];
  hasVideoTrack: boolean;
  hasAudioTrack: boolean;
} {
  let timescale = 1000;
  let durationMs: number | undefined;
  const codecs: string[] = [];
  let hasVideoTrack = false;
  let hasAudioTrack = false;

  let offset = 0;
  const len = buffer.length;

  while (offset + 8 <= len) {
    const size = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    const boxSize = size === 1 ? Number(buffer.readBigUInt64BE(offset + 8)) : size === 0 ? len - offset : size;

    if (boxSize < 8 || offset + boxSize > len) {
      break;
    }

    if (type === "moov") {
      // Traverse sub-boxes inside moov
      let subOffset = offset + 8;
      const subEnd = offset + boxSize;

      while (subOffset + 8 <= subEnd) {
        const subSize = buffer.readUInt32BE(subOffset);
        const subType = buffer.toString("latin1", subOffset + 4, subOffset + 8);
        if (subSize < 8 || subOffset + subSize > subEnd) break;

        if (subType === "mvhd") {
          const version = buffer.readUInt8(subOffset + 8);
          if (version === 0 && subOffset + 24 <= subEnd) {
            timescale = buffer.readUInt32BE(subOffset + 20);
            const durationUnits = buffer.readUInt32BE(subOffset + 24);
            if (timescale > 0) {
              durationMs = Math.round((durationUnits / timescale) * 1000);
            }
          } else if (version === 1 && subOffset + 36 <= subEnd) {
            timescale = buffer.readUInt32BE(subOffset + 28);
            const durationUnits = Number(buffer.readBigUInt64BE(subOffset + 32));
            if (timescale > 0) {
              durationMs = Math.round((durationUnits / timescale) * 1000);
            }
          }
        } else if (subType === "trak") {
          // Look for handler type (vide vs soun) and sample format
          const trakBuffer = buffer.slice(subOffset + 8, subOffset + subSize);
          const trakStr = trakBuffer.toString("latin1");

          if (trakStr.includes("vide")) {
            hasVideoTrack = true;
            if (trakStr.includes("avc1")) codecs.push("avc1");
            else if (trakStr.includes("hev1") || trakStr.includes("hvc1") || trakStr.includes("hevc") || trakStr.includes("h265")) codecs.push("hevc");
            else if (trakStr.includes("vp09") || trakStr.includes("vp9")) codecs.push("vp9");
            else if (trakStr.includes("av01") || trakStr.includes("av1")) codecs.push("av1");
          }
          if (trakStr.includes("soun")) {
            hasAudioTrack = true;
            if (trakStr.includes("mp4a")) codecs.push("mp4a");
            else if (trakStr.includes("Opus")) codecs.push("opus");
          }
        }

        subOffset += subSize;
      }
    }

    offset += boxSize;
  }

  return { timescale, durationMs, codecs, hasVideoTrack, hasAudioTrack };
}

/**
 * Basic EBML parser for WebM files.
 */
function parseWebmMetadata(buffer: Buffer): {
  durationMs?: number;
  codecs: string[];
  hasVideoTrack: boolean;
  hasAudioTrack: boolean;
} {
  const bufStr = buffer.slice(0, Math.min(buffer.length, 65536)).toString("latin1");
  const codecs: string[] = [];
  let hasVideoTrack = false;
  let hasAudioTrack = false;

  if (bufStr.includes("V_VP8")) {
    hasVideoTrack = true;
    codecs.push("vp8");
  } else if (bufStr.includes("V_VP9")) {
    hasVideoTrack = true;
    codecs.push("vp9");
  } else if (bufStr.includes("V_AV1")) {
    hasVideoTrack = true;
    codecs.push("av1");
  }

  if (bufStr.includes("A_OPUS")) {
    hasAudioTrack = true;
    codecs.push("opus");
  } else if (bufStr.includes("A_VORBIS")) {
    hasAudioTrack = true;
    codecs.push("vorbis");
  }

  // Default fallback duration estimation or null
  return { durationMs: undefined, codecs, hasVideoTrack, hasAudioTrack };
}

/**
 * Inspects and extracts video metadata, poster frames, and audio transcripts safely
 * with strict codec/container allowlists, duration bounds, and coverage tracking.
 */
export async function extractVideoMetadataAndFrames(
  buffer: Buffer | Uint8Array,
  mimeType: string,
  options: VideoExtractionOptions = {}
): Promise<VideoExtractionResult> {
  const maxBytes = options.maxBytes ?? 25 * 1024 * 1024;
  const maxDurationSec = options.maxDurationSec ?? 60;

  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const cleanMime = mimeType.toLowerCase().trim();

  // 1. Container allowlist check
  if (!ALLOWED_CONTAINERS.has(cleanMime)) {
    return {
      success: false,
      status: "UNSUPPORTED",
      coverage: {
        container: cleanMime,
        codecs: [],
        hasVideoTrack: false,
        hasAudioTrack: false,
        framesExtracted: 0,
        audioExtracted: false,
        coverageStatus: "UNSUPPORTED",
        limitationReason: `UNSUPPORTED_CONTAINER: '${cleanMime}' is outside permitted video containers (mp4, webm).`,
      },
      error: `DISALLOWED_CONTAINER: ${cleanMime}`,
    };
  }

  // 2. Size limit check
  if (buf.length > maxBytes) {
    return {
      success: false,
      status: "UNSUPPORTED",
      coverage: {
        container: cleanMime,
        codecs: [],
        hasVideoTrack: true,
        hasAudioTrack: false,
        framesExtracted: 0,
        audioExtracted: false,
        coverageStatus: "UNSUPPORTED",
        limitationReason: `MAX_SIZE_EXCEEDED: Size ${buf.length} exceeds limit ${maxBytes}.`,
      },
      error: "MAX_SIZE_EXCEEDED",
    };
  }

  // 3. Inspect container metadata and codecs
  let durationMs: number | undefined;
  let codecs: string[] = [];
  let hasVideoTrack = true;
  let hasAudioTrack = false;

  if (cleanMime === "video/mp4") {
    const meta = parseMp4Metadata(buf);
    durationMs = meta.durationMs;
    codecs = meta.codecs;
    hasVideoTrack = meta.hasVideoTrack || true;
    hasAudioTrack = meta.hasAudioTrack;
  } else if (cleanMime === "video/webm") {
    const meta = parseWebmMetadata(buf);
    durationMs = meta.durationMs;
    codecs = meta.codecs;
    hasVideoTrack = meta.hasVideoTrack || true;
    hasAudioTrack = meta.hasAudioTrack;
  }

  // 4. Codec allowlist check
  const disallowedCodecs = codecs.filter((c) => !ALLOWED_VIDEO_CODECS.has(c) && !ALLOWED_AUDIO_CODECS.has(c));
  if (disallowedCodecs.length > 0 || (hasVideoTrack && codecs.length === 0)) {
    const reasonCodecs = disallowedCodecs.length > 0 ? disallowedCodecs.join(", ") : "UNKNOWN_OR_UNSUPPORTED";
    return {
      success: false,
      status: "UNSUPPORTED",
      coverage: {
        container: cleanMime,
        codecs,
        durationMs,
        hasVideoTrack,
        hasAudioTrack,
        framesExtracted: 0,
        audioExtracted: false,
        coverageStatus: "UNSUPPORTED",
        limitationReason: `UNSUPPORTED_CODEC: Codecs [${reasonCodecs}] are not in the approved allowlist.`,
      },
      error: `DISALLOWED_CODEC: ${reasonCodecs}`,
    };
  }

  // 5. Duration limit check
  if (durationMs !== undefined) {
    const durationSec = durationMs / 1000;
    if (durationSec > maxDurationSec) {
      return {
        success: false,
        status: "UNSUPPORTED",
        coverage: {
          container: cleanMime,
          codecs,
          durationMs,
          hasVideoTrack,
          hasAudioTrack,
          framesExtracted: 0,
          audioExtracted: false,
          coverageStatus: "UNSUPPORTED",
          limitationReason: `EXCEEDED_MAX_DURATION: Video duration ${Math.round(durationSec)}s exceeds maximum ${maxDurationSec}s.`,
        },
        error: "EXCEEDED_MAX_DURATION",
      };
    }
  }

  // 6. Poster / Frame extraction
  let posterMediaRefId: string | undefined;
  let framesExtracted = 0;

  if (options.posterBuffer && options.posterBuffer.length > 0) {
    const pBuf = Buffer.isBuffer(options.posterBuffer) ? options.posterBuffer : Buffer.from(options.posterBuffer);
    posterMediaRefId = generateInternalMediaRef(pBuf, "image/jpeg");
    globalMediaCache.set({
      mediaRefId: posterMediaRefId,
      mimeType: "image/jpeg",
      byteSize: pBuf.length,
      buffer: pBuf,
      base64: pBuf.toString("base64"),
      sourceUrl: options.posterUrl,
    });
    framesExtracted = 1;
  }

  // 7. Audio extraction & ASR transcription
  let transcript: DerivedTranscript | undefined;
  let audioExtracted = false;

  if (hasAudioTrack && options.audioBuffer && options.transcribeIfAudio) {
    try {
      const aBuf = Buffer.isBuffer(options.audioBuffer) ? options.audioBuffer : Buffer.from(options.audioBuffer);
      const asrResult = await transcribeAudio({
        audioBuffer: aBuf,
        mimeType: "audio/mp4",
      });
      if (asrResult) {
        transcript = asrResult;
        audioExtracted = true;
      }
    } catch {
      // Audio transcription error handled gracefully
      audioExtracted = false;
    }
  }

  // 8. Determine coverage status
  let coverageStatus: VideoCoverage["coverageStatus"] = "POSTER_ONLY";
  if (framesExtracted > 0 && audioExtracted) {
    coverageStatus = "FRAMES_AND_AUDIO";
  } else if (framesExtracted > 0) {
    coverageStatus = "POSTER_ONLY";
  } else if (audioExtracted) {
    coverageStatus = "AUDIO_ONLY";
  } else {
    coverageStatus = "POSTER_ONLY";
  }

  const coverage: VideoCoverage = {
    container: cleanMime,
    codecs,
    durationMs,
    hasVideoTrack,
    hasAudioTrack,
    framesExtracted,
    audioExtracted,
    coverageStatus,
    limitationReason:
      framesExtracted > 0 && !audioExtracted
        ? "Video chỉ phân tích khung hình đại diện / poster; chưa thể xem toàn bộ chuyển động video hoặc nghe âm thanh."
        : undefined,
  };

  return {
    success: true,
    status: "READY",
    coverage,
    posterMediaRefId,
    transcript,
  };
}
