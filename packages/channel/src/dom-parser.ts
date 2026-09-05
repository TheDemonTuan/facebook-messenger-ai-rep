import type {
  ThreadKind,
  SenderKind,
  ClassificationReliability,
  TimestampProvenance,
  TimestampPrecision,
  MentionEvidence,
  MessageTimestamps,
  ClassificationEvidence,
} from "@messenger/contracts";
import {
  createMessageTimestamps,
  canonicalizeFacebookUrl,
  extractFacebookEntityId,
  isValidTimeZone,
} from "@messenger/contracts";

export interface ParsedBubble {
  id: string;
  text: string;
  isOutgoing: boolean;
  senderName?: string;
  senderId?: string | null;
  senderProfileUrl?: string | null;
  senderKind?: SenderKind;
  senderReliability?: ClassificationReliability;
  threadKind?: ThreadKind;
  threadReliability?: ClassificationReliability;
  mentions?: MentionEvidence[];
  timestamps?: MessageTimestamps;
  facebookEventTimestamp?: Date | null;
  observedTimestamp?: Date;
  timestampProvenance?: TimestampProvenance;
  timestampPrecision?: TimestampPrecision;
  threadEvidence?: ClassificationEvidence[];
  senderEvidence?: ClassificationEvidence[];
}

export interface ThreadClassificationResult {
  kind: ThreadKind;
  reliability: ClassificationReliability;
  evidence: ClassificationEvidence[];
}

export interface BubbleParseResult {
  ok: boolean;
  bubbles: ParsedBubble[];
  isDegraded: boolean;
  degradedReason?: string;
  threadClassification?: ThreadClassificationResult;
}

export interface ParsedSidebarThread {
  threadId: string;
  threadRef: string;
  customerName: string;
  snippet: string;
  isUnread: boolean;
  isOutgoing: boolean;
  threadKind?: ThreadKind;
  threadReliability?: ClassificationReliability;
}

export interface ParseBubblesOptions {
  observedAt?: Date;
  timeZone?: string;
  botChannelAccountId?: string;
  botParticipantId?: string;
  botProfileUrl?: string;
  threadKindHint?: ThreadKind;
  threadReliabilityHint?: ClassificationReliability;
}

export interface ParsedTimestampResult {
  timestamps: MessageTimestamps;
  facebookEventTimestamp: Date | null;
  observedTimestamp: Date;
  timestampProvenance: TimestampProvenance;
  timestampPrecision: TimestampPrecision;
}

export interface ParsedSenderResult {
  senderId: string | null;
  senderProfileUrl: string | null;
  senderName?: string;
  senderKind: SenderKind;
  senderReliability: ClassificationReliability;
  evidence: ClassificationEvidence[];
}

const DEFAULT_TIMEZONE = "Asia/Ho_Chi_Minh";

/**
 * Normalizes an IANA timezone identifier, defaulting to Asia/Ho_Chi_Minh.
 */
function resolveTimeZone(timeZone?: string): string {
  if (timeZone && isValidTimeZone(timeZone)) {
    return timeZone.trim();
  }
  return DEFAULT_TIMEZONE;
}

/**
 * Returns UTC Date for calendar components in a target IANA timezone without fixed offsets.
 */
export function getUtcDateFromZonedParts(
  parts: { year: number; month: number; day: number; hour: number; minute: number; second?: number },
  timeZone = DEFAULT_TIMEZONE
): Date {
  const tz = resolveTimeZone(timeZone);
  const candidate = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second ?? 0)
  );
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hourCycle: "h23",
  });
  const formatted = dtf.formatToParts(candidate);
  const zYear = parseInt(formatted.find((p) => p.type === "year")!.value, 10);
  const zMonth = parseInt(formatted.find((p) => p.type === "month")!.value, 10);
  const zDay = parseInt(formatted.find((p) => p.type === "day")!.value, 10);
  const zHour = parseInt(formatted.find((p) => p.type === "hour")!.value, 10);
  const zMin = parseInt(formatted.find((p) => p.type === "minute")!.value, 10);
  const zSec = parseInt(formatted.find((p) => p.type === "second")!.value, 10);

  const candidateZonedNominalUtc = Date.UTC(zYear, zMonth - 1, zDay, zHour, zMin, zSec);
  const offsetMs = candidateZonedNominalUtc - candidate.getTime();
  return new Date(candidate.getTime() - offsetMs);
}

/**
 * Extracts year/month/day/hour/minute/second of a Date in the given IANA timezone.
 */
export function getZonedDateParts(
  date: Date,
  timeZone = DEFAULT_TIMEZONE
): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const tz = resolveTimeZone(timeZone);
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hourCycle: "h23",
  });
  const formatted = dtf.formatToParts(date);
  return {
    year: parseInt(formatted.find((p) => p.type === "year")!.value, 10),
    month: parseInt(formatted.find((p) => p.type === "month")!.value, 10),
    day: parseInt(formatted.find((p) => p.type === "day")!.value, 10),
    hour: parseInt(formatted.find((p) => p.type === "hour")!.value, 10),
    minute: parseInt(formatted.find((p) => p.type === "minute")!.value, 10),
    second: parseInt(formatted.find((p) => p.type === "second")!.value, 10),
  };
}

/**
 * Extracts a stable entity ID from a canonical Facebook profile URL or entity string.
 */
export function extractEntityIdFromCanonicalUrl(canonicalUrl: string): string | null {
  const direct = extractFacebookEntityId(canonicalUrl);
  if (direct) return direct;
  try {
    const parsed = new URL(canonicalUrl);
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length > 0) {
      const last = segments[segments.length - 1]!;
      return extractFacebookEntityId(last);
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Classifies thread kind (DIRECT, GROUP, UNKNOWN) with reliability and evidence.
 * If absent or ambiguous, emits UNKNOWN / UNVERIFIED to fail closed downstream.
 */
export function parseThreadClassification(
  html: string,
  options?: ParseBubblesOptions
): ThreadClassificationResult {
  if (options?.threadKindHint && options.threadKindHint !== "UNKNOWN") {
    return {
      kind: options.threadKindHint,
      reliability: options.threadReliabilityHint ?? "VERIFIED",
      evidence: [
        {
          source: "THREAD_METADATA",
          signal: "explicit_thread_hint",
          confidence: 1.0,
          details: { hint: options.threadKindHint },
        },
      ],
    };
  }

  // 1. Group signals
  const hasGroupTestId =
    /data-testid=["'](?:group_chat_header|group_thread_header|mw_chat_header_group)["']/i.test(html) ||
    /data-thread-type=["']GROUP["']/i.test(html);
  const hasGroupAria = /aria-label=["'][^"']*(?:thông tin nhóm|group info|group details)[^"']*["']/i.test(html);
  const memberCountMatch = html.match(/\b(\d+)\s*(?:thành viên|members)\b/i);

  if (hasGroupTestId || hasGroupAria || memberCountMatch) {
    return {
      kind: "GROUP",
      reliability: "VERIFIED",
      evidence: [
        {
          source: "DOM_SELECTOR",
          signal: "group_header_indicator",
          confidence: 1.0,
          details: {
            hasGroupTestId,
            hasGroupAria,
            memberCount: memberCountMatch ? memberCountMatch[1] : null,
          },
        },
      ],
    };
  }

  // 2. Direct signals
  const hasDirectTestId =
    /data-testid=["'](?:direct_chat_header|mw_chat_header_direct)["']/i.test(html) ||
    /data-thread-type=["']DIRECT["']/i.test(html);
  const hasDirectAria = /aria-label=["'][^"']*(?:thông tin cuộc trò chuyện|conversation info|chat details)[^"']*["']/i.test(html);

  if (hasDirectTestId || hasDirectAria) {
    return {
      kind: "DIRECT",
      reliability: "VERIFIED",
      evidence: [
        {
          source: "DOM_SELECTOR",
          signal: "direct_header_indicator",
          confidence: 1.0,
          details: { hasDirectTestId, hasDirectAria },
        },
      ],
    };
  }

  // 3. Absent / Ambiguous -> fail closed
  return {
    kind: "UNKNOWN",
    reliability: "UNVERIFIED",
    evidence: [],
  };
}

/**
 * Parses sender identity from structured DOM evidence.
 * Names, avatars, thread IDs, and message text are NEVER accepted as identity proof.
 */
export function parseSenderIdentity(
  chunk: string,
  openingTag: string,
  body: string,
  _options?: ParseBubblesOptions
): ParsedSenderResult {
  // Check aria-label for non-identity display name
  const ariaLabelMatch =
    openingTag.match(/aria-label=["']([^"']+)["']/i) ||
    body.match(/aria-label=["']([^"']+)["']/i);
  let senderName: string | undefined;
  if (ariaLabelMatch && ariaLabelMatch[1]) {
    const parts = ariaLabelMatch[1].split(/[:;]/);
    if (parts.length > 1 && parts[0]) {
      senderName = parts[0].trim();
    }
  }

  // 1. Non-person / System signals
  const isSystem =
    openingTag.includes('role="status"') ||
    openingTag.includes('data-testid="system_message"') ||
    body.includes('data-testid="system_message"') ||
    openingTag.includes('data-sender-type="SYSTEM"') ||
    openingTag.includes('data-entity-type="NON_PERSON"') ||
    body.includes('data-testid="meta_ai_message"') ||
    Boolean(senderName && /^(?:tin nhắn hệ thống|system message|meta ai)$/i.test(senderName));

  if (isSystem) {
    return {
      senderId: "system",
      senderProfileUrl: null,
      senderName: senderName || "System",
      senderKind: "NON_PERSON",
      senderReliability: "VERIFIED",
      evidence: [
        {
          source: "DOM_SELECTOR",
          signal: "system_status_indicator",
          confidence: 1.0,
          details: {},
        },
      ],
    };
  }

  // 2. Extract author anchor / entity attribute
  // Trust only explicit author links or entity attributes, never message content or thread links
  let structuredUrl: string | null = null;
  let structuredId: string | null = null;

  // Check data-sender-id or data-entity-id
  const entityIdMatch =
    openingTag.match(/\b(?:data-sender-id|data-entity-id)=["']([^"']+)["']/i) ||
    body.match(/\b(?:data-sender-id|data-entity-id)=["']([^"']+)["']/i);
  if (entityIdMatch && entityIdMatch[1]) {
    structuredId = entityIdMatch[1].trim();
  }

  // Check hovercard user/page ID
  const hovercardMatch = chunk.match(/\bdata-hovercard=["'][^"']*(?:id|user\.php\?id|page\.php\?id)=([0-9]+)[^"']*["']/i);
  if (hovercardMatch && hovercardMatch[1]) {
    structuredId = hovercardMatch[1].trim();
  }

  // Check author profile anchor
  const authorLinkMatch =
    chunk.match(/<a\b(?=[^>]*\b(?:data-testid=["'](?:author_link|message_sender_avatar|sender_name)["']|class=["'][^"']*\bauthor\b))[^>]*\bhref=["']([^"']+)["'][^>]*>/i) ||
    chunk.match(/<a\b[^>]*\bhref=["']([^"']*(?:\/profile\.php\?id=|\/user\.|\/pages\/)[^"']*)["'][^>]*>/i);

  if (authorLinkMatch && authorLinkMatch[1]) {
    const rawHref = authorLinkMatch[1].trim();
    const fullHref = rawHref.startsWith("/") ? `https://www.facebook.com${rawHref}` : rawHref;
    const canonical = canonicalizeFacebookUrl(fullHref);
    if (canonical) {
      structuredUrl = canonical;
      const extracted = extractEntityIdFromCanonicalUrl(canonical);
      if (extracted) {
        structuredId = extracted;
      }
    }
  }

  // Check Page indicators
  const isPage =
    openingTag.includes('data-entity-type="PAGE"') ||
    body.includes('data-entity-type="PAGE"') ||
    openingTag.includes('data-sender-type="PAGE"') ||
    body.includes('data-sender-type="PAGE"') ||
    body.includes('data-testid="page_badge"') ||
    body.includes('aria-label="Trang"') ||
    body.includes('aria-label="Page"') ||
    body.includes('aria-label="Được xác minh là Trang"') ||
    body.includes('aria-label="Verified Page"') ||
    (structuredUrl !== null && (structuredUrl.includes("/pages/") || structuredUrl.includes("/pg/")));

  if (structuredId) {
    const senderKind: SenderKind = isPage ? "PAGE" : "PERSON";
    return {
      senderId: structuredId,
      senderProfileUrl: structuredUrl,
      senderName,
      senderKind,
      senderReliability: "VERIFIED",
      evidence: [
        {
          source: "DOM_SELECTOR",
          signal: isPage ? "page_badge_and_link" : "structured_profile_link",
          confidence: 1.0,
          details: { entityId: structuredId, profileUrl: structuredUrl },
        },
      ],
    };
  }

  // Absent / Ambiguous sender identity -> fail closed
  return {
    senderId: null,
    senderProfileUrl: null,
    senderName,
    senderKind: "UNKNOWN",
    senderReliability: "UNVERIFIED",
    evidence: [
      {
        source: "DOM_SELECTOR",
        signal: "missing_structured_sender_identity",
        confidence: 0,
        details: {},
      },
    ],
  };
}

/**
 * Parses mentions from a message row chunk.
 * Plain text or alias mentions are NEVER verified. Structured entity links must canonicalize
 * and match configured bot identity metadata to be marked verified.
 */
export function parseMentions(
  cleanText: string,
  rawChunk: string,
  options?: ParseBubblesOptions
): MentionEvidence[] {
  const mentions: MentionEvidence[] = [];
  const matchedTokens = new Set<string>();

  const botCanonicalUrl = options?.botProfileUrl ? canonicalizeFacebookUrl(options.botProfileUrl) : null;
  const botId = options?.botParticipantId?.trim() || options?.botChannelAccountId?.trim();

  // 1. Structured anchors
  const anchorRegex = /<a\b(?=[^>]*\b(?:class=["'][^"']*\bmention\b|data-mention-id|data-entity-id|role=["']link["']))[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let anchorMatch: RegExpExecArray | null;

  while ((anchorMatch = anchorRegex.exec(rawChunk)) !== null) {
    const rawHref = anchorMatch[1]!.trim();
    const innerText = anchorMatch[2]!.replace(/<[^>]+>/g, "").trim();
    const fullHref = rawHref.startsWith("/") ? `https://www.facebook.com${rawHref}` : rawHref;
    const canonical = canonicalizeFacebookUrl(fullHref);
    const entityId = (canonical ? extractEntityIdFromCanonicalUrl(canonical) : null) || extractFacebookEntityId(fullHref) || "";

    let isVerified = false;
    if (botCanonicalUrl && canonical && botCanonicalUrl === canonical) {
      isVerified = true;
    } else if (botId && entityId && (entityId === botId || extractFacebookEntityId(options?.botProfileUrl || "") === entityId)) {
      isVerified = true;
    }

    const offset = cleanText.indexOf(innerText);
    matchedTokens.add(innerText.toLowerCase());

    mentions.push({
      entityId,
      profileUrl: canonical,
      mentionText: innerText,
      offset: offset >= 0 ? offset : undefined,
      length: innerText.length > 0 ? innerText.length : undefined,
      isVerified,
      evidenceType: "DOM_ANCHOR",
      rawMetadata: { href: rawHref, canonicalUrl: canonical },
    });
  }

  // 2. Structured entity spans
  const spanRegex = /<(?:span|div)\b(?=[^>]*\b(?:data-entity-id|data-mention-id)=["']([^"']+)["'])[^>]*>([\s\S]*?)<\/(?:span|div)>/gi;
  let spanMatch: RegExpExecArray | null;

  while ((spanMatch = spanRegex.exec(rawChunk)) !== null) {
    const entityId = spanMatch[1]!.trim();
    const innerText = spanMatch[2]!.replace(/<[^>]+>/g, "").trim();

    let isVerified = false;
    if (botId && entityId && (entityId === botId || extractFacebookEntityId(options?.botProfileUrl || "") === entityId)) {
      isVerified = true;
    }

    const offset = cleanText.indexOf(innerText);
    matchedTokens.add(innerText.toLowerCase());

    mentions.push({
      entityId,
      profileUrl: null,
      mentionText: innerText,
      offset: offset >= 0 ? offset : undefined,
      length: innerText.length > 0 ? innerText.length : undefined,
      isVerified,
      evidenceType: "ENTITY_TAG",
      rawMetadata: { entityId },
    });
  }

  // 3. Unstructured plain text mentions (@token without DOM anchor)
  const textMentionRegex = /@([a-zA-Z0-9._-]+)/g;
  let textMatch: RegExpExecArray | null;

  while ((textMatch = textMentionRegex.exec(cleanText)) !== null) {
    const fullToken = textMatch[0];
    if (matchedTokens.has(fullToken.toLowerCase())) {
      continue;
    }

    // Plain text is never verified
    mentions.push({
      entityId: "",
      profileUrl: null,
      mentionText: fullToken,
      offset: textMatch.index,
      length: fullToken.length,
      isVerified: false,
      evidenceType: "TEXT_FALLBACK",
      rawMetadata: { reason: "unstructured_plain_text" },
    });
  }

  return mentions;
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  tháng1: 1, tháng2: 2, tháng3: 3, tháng4: 4, tháng5: 5, tháng6: 6,
  tháng7: 7, tháng8: 8, tháng9: 9, tháng10: 10, tháng11: 11, tháng12: 12,
};

/**
 * Extracts Facebook event timestamp where exact or localized DOM evidence exists;
 * otherwise returns observed timestamp with explicit provenance/precision.
 * Defaults business timezone to Asia/Ho_Chi_Minh; uses no fixed offsets.
 */
export function parseMessageTimestamp(
  chunk: string,
  options?: ParseBubblesOptions
): ParsedTimestampResult {
  const timeZone = resolveTimeZone(options?.timeZone);
  const observedAt = options?.observedAt ?? new Date();

  // 1. Exact machine-readable attributes
  const machineAttrMatch =
    chunk.match(/<time\b[^>]*\bdatetime=["']([^"']+)["']/i) ||
    chunk.match(/\b(?:data-timestamp|data-time|data-utime)=["']([^"']+)["']/i);

  if (machineAttrMatch && machineAttrMatch[1]) {
    const rawVal = machineAttrMatch[1].trim();
    let date: Date | null = null;
    let precision: TimestampPrecision = "SECOND";

    if (/^\d+$/.test(rawVal)) {
      const num = parseInt(rawVal, 10);
      if (rawVal.length >= 13) {
        date = new Date(num);
        precision = "MILLISECOND";
      } else {
        date = new Date(num * 1000);
        precision = "SECOND";
      }
    } else {
      const candidate = new Date(rawVal);
      if (!isNaN(candidate.getTime())) {
        date = candidate;
        precision = rawVal.includes(".") ? "MILLISECOND" : "SECOND";
      }
    }

    if (date && !isNaN(date.getTime())) {
      return {
        facebookEventTimestamp: date,
        observedTimestamp: observedAt,
        timestampProvenance: "FACEBOOK_EVENT",
        timestampPrecision: precision,
        timestamps: createMessageTimestamps({
          observedAt,
          facebookEventAt: date,
          facebookPrecision: precision,
          observedPrecision: "MILLISECOND",
          facebookSourceLabel: "dom_datetime_attribute",
          observedSourceLabel: "browser_observer",
        }),
      };
    }
  }

  // 2. Localized text or tooltip
  const textContainerMatch =
    chunk.match(/\bdata-tooltip-content=["']([^"']+)["']/i) ||
    chunk.match(/<time\b[^>]*>([\s\S]*?)<\/time>/i) ||
    chunk.match(/<(?:span|div)\b[^>]*\bdata-testid=["']message_timestamp["'][^>]*>([\s\S]*?)<\/(?:span|div)>/i) ||
    chunk.match(/aria-label=["']([^"']*\b(?:\d{1,2}:\d{2}|vừa xong|just now|hôm qua|yesterday)[^"']*)["']/i);

  if (textContainerMatch && textContainerMatch[1]) {
    const timeText = textContainerMatch[1].replace(/<[^>]+>/g, "").trim().toLowerCase();

    // Vừa xong / Just now
    if (timeText.includes("vừa xong") || timeText.includes("just now")) {
      return {
        facebookEventTimestamp: observedAt,
        observedTimestamp: observedAt,
        timestampProvenance: "FACEBOOK_EVENT",
        timestampPrecision: "MINUTE",
        timestamps: createMessageTimestamps({
          observedAt,
          facebookEventAt: observedAt,
          facebookPrecision: "MINUTE",
          observedPrecision: "MILLISECOND",
          facebookSourceLabel: "dom_localized_text",
          observedSourceLabel: "browser_observer",
        }),
      };
    }

    // Relative minutes
    const minMatch = timeText.match(/(\d+)\s*(?:phút|phut|m|min|mins|minute|minutes)(?:\s*trước|\s*ago)?/i);
    if (minMatch && minMatch[1]) {
      const mins = parseInt(minMatch[1], 10);
      const eventDate = new Date(observedAt.getTime() - mins * 60000);
      return {
        facebookEventTimestamp: eventDate,
        observedTimestamp: observedAt,
        timestampProvenance: "FACEBOOK_EVENT",
        timestampPrecision: "MINUTE",
        timestamps: createMessageTimestamps({
          observedAt,
          facebookEventAt: eventDate,
          facebookPrecision: "MINUTE",
          observedPrecision: "MILLISECOND",
          facebookSourceLabel: "dom_localized_text",
          observedSourceLabel: "browser_observer",
        }),
      };
    }

    // Relative hours
    const hourMatch = timeText.match(/(\d+)\s*(?:giờ|gio|h|hr|hrs|hour|hours)(?:\s*trước|\s*ago)?/i);
    if (hourMatch && hourMatch[1]) {
      const hrs = parseInt(hourMatch[1], 10);
      const eventDate = new Date(observedAt.getTime() - hrs * 3600000);
      return {
        facebookEventTimestamp: eventDate,
        observedTimestamp: observedAt,
        timestampProvenance: "FACEBOOK_EVENT",
        timestampPrecision: "MINUTE",
        timestamps: createMessageTimestamps({
          observedAt,
          facebookEventAt: eventDate,
          facebookPrecision: "MINUTE",
          observedPrecision: "MILLISECOND",
          facebookSourceLabel: "dom_localized_text",
          observedSourceLabel: "browser_observer",
        }),
      };
    }

    // Clock pattern (HH:MM or HH:MM AM/PM)
    const clockMatch = timeText.match(/\b(\d{1,2}):(\d{2})(?:\s*(am|pm))?\b/i);
    if (clockMatch && clockMatch[1] && clockMatch[2]) {
      let hour = parseInt(clockMatch[1], 10);
      const minute = parseInt(clockMatch[2], 10);
      const meridiem = clockMatch[3]?.toLowerCase();

      if (meridiem === "pm" && hour < 12) hour += 12;
      if (meridiem === "am" && hour === 12) hour = 0;

      const zoned = getZonedDateParts(observedAt, timeZone);
      let year = zoned.year;
      let month = zoned.month;
      let day = zoned.day;

      // Yesterday
      if (timeText.includes("hôm qua") || timeText.includes("yesterday")) {
        const yesterdayZoned = getZonedDateParts(new Date(observedAt.getTime() - 86400000), timeZone);
        year = yesterdayZoned.year;
        month = yesterdayZoned.month;
        day = yesterdayZoned.day;
      }

      // Explicit Vietnamese date: "5 tháng 9" or "5/9/2026"
      const viDateMatch = timeText.match(/(\d{1,2})[\s/-]+tháng[\s/-]+(\d{1,2})(?:,?\s*(\d{4}))?/i);
      if (viDateMatch && viDateMatch[1] && viDateMatch[2]) {
        day = parseInt(viDateMatch[1], 10);
        month = parseInt(viDateMatch[2], 10);
        if (viDateMatch[3]) year = parseInt(viDateMatch[3], 10);
      } else {
        const slashDateMatch = timeText.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
        if (slashDateMatch && slashDateMatch[1] && slashDateMatch[2] && slashDateMatch[3]) {
          day = parseInt(slashDateMatch[1], 10);
          month = parseInt(slashDateMatch[2], 10);
          year = parseInt(slashDateMatch[3], 10);
        }
      }

      // Explicit English date: "Sep 5, 2026" or "Sep 5"
      const enDateMatch = timeText.match(/\b([a-z]{3,9})\s+(\d{1,2})(?:,\s*(\d{4}))?/i);
      if (enDateMatch && enDateMatch[1] && enDateMatch[2]) {
        const prefix = enDateMatch[1].slice(0, 3).toLowerCase();
        if (MONTH_NAMES[prefix]) {
          month = MONTH_NAMES[prefix]!;
          day = parseInt(enDateMatch[2], 10);
          if (enDateMatch[3]) year = parseInt(enDateMatch[3], 10);
        }
      }

      const exactUtcDate = getUtcDateFromZonedParts({ year, month, day, hour, minute, second: 0 }, timeZone);

      return {
        facebookEventTimestamp: exactUtcDate,
        observedTimestamp: observedAt,
        timestampProvenance: "FACEBOOK_EVENT",
        timestampPrecision: "MINUTE",
        timestamps: createMessageTimestamps({
          observedAt,
          facebookEventAt: exactUtcDate,
          facebookPrecision: "MINUTE",
          observedPrecision: "MILLISECOND",
          facebookSourceLabel: "dom_localized_text",
          observedSourceLabel: "browser_observer",
        }),
      };
    }
  }

  // 3. Fallback: observed timestamp only. Never pretend fallback is Facebook exact time.
  return {
    facebookEventTimestamp: null,
    observedTimestamp: observedAt,
    timestampProvenance: "OBSERVED",
    timestampPrecision: "MILLISECOND",
    timestamps: createMessageTimestamps({
      observedAt,
      facebookEventAt: null,
      observedPrecision: "MILLISECOND",
      observedSourceLabel: "browser_observer",
    }),
  };
}

/**
 * Parses Messenger message bubble rows from HTML string or DOM representation.
 * Preserves degraded-DOM safeguards: missing stable mid marks isDegraded = true.
 */
export function parseMessengerBubblesFromHtml(
  html: string,
  options?: ParseBubblesOptions
): BubbleParseResult {
  const bubbles: ParsedBubble[] = [];
  let isDegraded = false;
  let degradedReason: string | undefined;

  // Classify thread from surrounding HTML
  const threadClassification = parseThreadClassification(html, options);

  // Split by message rows or status rows
  const rowChunks = html.split(/<div\b(?=[^>]*\b(?:role=["'](?:row|status)["']|data-testid=["'](?:mw_message_row|system_message)["']))/i);

  for (let i = 1; i < rowChunks.length; i++) {
    const chunk = rowChunks[i]!;
    const tagEndIdx = chunk.indexOf(">");
    if (tagEndIdx === -1) continue;

    const openingTag = chunk.slice(0, tagEndIdx);
    const body = chunk.slice(tagEndIdx + 1);

    // Strip author links before extracting text so author's display name is not mistaken for bubble text
    const bodyWithoutAuthor = body.replace(
      /<a\b(?=[^>]*\b(?:data-testid=["'](?:author_link|message_sender_avatar|sender_name)["']|class=["'][^"']*\bauthor\b))[\s\S]*?<\/a>/gi,
      ""
    );

    // Extract text content from dir="auto" or inner text
    const textMatch =
      /<(?:div|span)\b[^>]*\bdir=["']auto["'][^>]*>([\s\S]*?)<\/(?:div|span)>/i.exec(bodyWithoutAuthor) ||
      /<span\b[^>]*>([\s\S]*?)<\/span>/i.exec(bodyWithoutAuthor) ||
      /<div\b[^>]*>([\s\S]*?)<\/div>/i.exec(bodyWithoutAuthor) ||
      /<(?:div|span)\b[^>]*\bdir=["']auto["'][^>]*>([\s\S]*?)<\/(?:div|span)>/i.exec(body);

    const rawText = textMatch ? textMatch[1] : "";
    const cleanText = rawText
      ? rawText.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&").trim()
      : "";

    if (!cleanText) {
      continue;
    }

    // Look for stable message ID (e.g. mid.$..., id="mid...", data-message-id, data-mid, data-id)
    const idMatch =
      openingTag.match(/\b(?:id|data-message-id|data-mid|data-id)=["']([^"']+)["']/i) ||
      body.match(/\b(?:id|data-message-id|data-mid|data-id)=["']([^"']+)["']/i);

    const rawId = idMatch ? idMatch[1] : null;
    const isValidMid = Boolean(
      rawId &&
      (rawId.startsWith("mid.") || rawId.startsWith("mid.$") || rawId.length >= 12)
    );

    if (!isValidMid) {
      isDegraded = true;
      degradedReason = `Message row with text "${cleanText.slice(0, 30)}" missing stable mid identifier`;
      continue;
    }

    const stableId = rawId!;

    // Check outgoing vs incoming
    const ariaLabelMatch =
      openingTag.match(/aria-label=["']([^"']+)["']/i) ||
      body.match(/aria-label=["']([^"']+)["']/i);
    const ariaLabel = ariaLabelMatch ? ariaLabelMatch[1]!.toLowerCase() : "";

    const isOutgoing =
      ariaLabel.includes("bạn đã gửi") ||
      ariaLabel.includes("bạn:") ||
      ariaLabel.includes("you sent") ||
      ariaLabel.includes("you:") ||
      openingTag.includes('data-testid="outgoing_message"') ||
      body.includes('data-testid="outgoing_message"');

    // Parse sender identity from trustworthy structured DOM evidence
    const senderResult = parseSenderIdentity(chunk, openingTag, body, options);

    // Parse structured and plain text mentions
    const mentions = parseMentions(cleanText, chunk, options);

    // Parse timestamps (Facebook event vs observed fallback)
    const timestampResult = parseMessageTimestamp(chunk, options);

    bubbles.push({
      id: stableId,
      text: cleanText,
      isOutgoing,
      senderName: senderResult.senderName,
      senderId: isOutgoing ? (options?.botParticipantId ?? options?.botChannelAccountId ?? null) : senderResult.senderId,
      senderProfileUrl: isOutgoing ? (options?.botProfileUrl ?? null) : senderResult.senderProfileUrl,
      senderKind: isOutgoing ? "PERSON" : senderResult.senderKind,
      senderReliability: isOutgoing ? "VERIFIED" : senderResult.senderReliability,
      senderEvidence: senderResult.evidence,
      threadKind: threadClassification.kind,
      threadReliability: threadClassification.reliability,
      threadEvidence: threadClassification.evidence,
      mentions,
      timestamps: timestampResult.timestamps,
      facebookEventTimestamp: timestampResult.facebookEventTimestamp,
      observedTimestamp: timestampResult.observedTimestamp,
      timestampProvenance: timestampResult.timestampProvenance,
      timestampPrecision: timestampResult.timestampPrecision,
    });
  }

  return {
    ok: !isDegraded && bubbles.length > 0,
    bubbles,
    isDegraded,
    degradedReason,
    threadClassification,
  };
}

/**
 * Parses Messenger sidebar thread items from HTML.
 * Sidebar is only a trigger - extracts threadRef, threadId, and unread indicator.
 */
export function parseSidebarThreadsFromHtml(html: string): ParsedSidebarThread[] {
  const threads: ParsedSidebarThread[] = [];
  const linkRegex = /<a\b[^>]*\bhref=["']([^"']*\/messages\/t\/([^"'/]+)\/?)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;

  while ((match = linkRegex.exec(html)) !== null) {
    const threadRef = match[1]!;
    const threadId = match[2]!;
    const inner = match[3] || "";

    const textWithoutTags = inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

    // Check unread indicator (bold, aria-label with unread, badge)
    const isUnread =
      inner.includes("chưa đọc") ||
      inner.includes("unread") ||
      inner.includes('aria-label="Đánh dấu là chưa đọc"') ||
      inner.includes('aria-label="Mark as unread"') ||
      inner.includes('class="unread"');

    // Check outgoing snippet
    const isOutgoing =
      textWithoutTags.includes("Bạn:") ||
      textWithoutTags.includes("You:") ||
      textWithoutTags.includes("Bạn đã gửi") ||
      textWithoutTags.includes("You sent");

    // Extract customer name: first non-empty text token
    const customerNameMatch = inner.match(/<span\b[^>]*>([^<]+)<\/span>/i);
    const customerName = customerNameMatch ? customerNameMatch[1]!.trim() : threadId;

    // Detect thread kind cues in sidebar
    const isGroup =
      inner.includes("thành viên") ||
      inner.includes("members") ||
      inner.includes("nhóm") ||
      inner.includes("group");
    const threadKind: ThreadKind = isGroup ? "GROUP" : "DIRECT";
    const threadReliability: ClassificationReliability = "UNVERIFIED";

    threads.push({
      threadId,
      threadRef,
      customerName,
      snippet: textWithoutTags,
      isUnread,
      isOutgoing,
      threadKind,
      threadReliability,
    });
  }

  return threads;
}
