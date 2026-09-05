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

function getTimezoneOffsetMs(date: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hourCycle: "h23",
  });
  const formatted = dtf.formatToParts(date);
  const zYear = parseInt(formatted.find((p) => p.type === "year")!.value, 10);
  const zMonth = parseInt(formatted.find((p) => p.type === "month")!.value, 10);
  const zDay = parseInt(formatted.find((p) => p.type === "day")!.value, 10);
  const zHour = parseInt(formatted.find((p) => p.type === "hour")!.value, 10);
  const zMin = parseInt(formatted.find((p) => p.type === "minute")!.value, 10);
  const zSec = parseInt(formatted.find((p) => p.type === "second")!.value, 10);

  const candidateZonedNominalUtc = Date.UTC(zYear, zMonth - 1, zDay, zHour, zMin, zSec);
  return candidateZonedNominalUtc - date.getTime();
}

/**
 * Two-pass conversion from zoned nominal date/time parts to exact UTC Date.
 * Pass 1 estimates the offset at the nominal UTC timestamp;
 * Pass 2 recalculates the offset at the candidate date to resolve DST boundary shifts correctly.
 */
export function getUtcDateFromZonedParts(
  parts: { year: number; month: number; day: number; hour: number; minute: number; second?: number },
  timeZone = DEFAULT_TIMEZONE
): Date {
  const tz = resolveTimeZone(timeZone);
  const nominalTargetUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second ?? 0
  );

  // Pass 1: Estimate offset using nominal target UTC
  const offset1 = getTimezoneOffsetMs(new Date(nominalTargetUtc), tz);
  const candidate = new Date(nominalTargetUtc - offset1);

  // Pass 2: Refine offset using candidate date (handles DST transition boundary shifts)
  const offset2 = getTimezoneOffsetMs(candidate, tz);
  return new Date(nominalTargetUtc - offset2);
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
 * Validates date and time bounds.
 */
export function isValidDateParts(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second = 0
): boolean {
  if (year < 2000 || year > 2100) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  if (hour < 0 || hour > 23) return false;
  if (minute < 0 || minute > 59) return false;
  if (second < 0 || second > 59) return false;

  const testDate = new Date(Date.UTC(year, month - 1, day));
  if (
    testDate.getUTCFullYear() !== year ||
    testDate.getUTCMonth() !== month - 1 ||
    testDate.getUTCDate() !== day
  ) {
    return false;
  }
  return true;
}

/**
 * Extracts a stable entity ID from a canonical Facebook profile URL or entity string.
 * Never parses thread URLs (/messages/t/...).
 */
export function extractEntityIdFromCanonicalUrl(canonicalUrl: string): string | null {
  if (!canonicalUrl || typeof canonicalUrl !== "string") return null;
  const trimmed = canonicalUrl.trim();
  if (!trimmed) return null;

  // Never parse thread URLs as entity IDs (Finding 10c)
  if (
    trimmed.includes("/messages/") ||
    trimmed.includes("/messages/t/") ||
    /\/t\/[0-9]+/i.test(trimmed)
  ) {
    return null;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.pathname.startsWith("/messages")) {
      return null;
    }
    if (parsed.pathname.toLowerCase() === "/profile.php") {
      const id = parsed.searchParams.get("id");
      return id ? id.trim() : null;
    }
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length > 0) {
      const last = segments[segments.length - 1]!;
      if (last.toLowerCase() === "messages" || last.toLowerCase() === "t") {
        return null;
      }
      return extractFacebookEntityId(last);
    }
  } catch {
    if (trimmed.startsWith("/")) {
      const segments = trimmed.split("/").filter(Boolean);
      if (segments.length > 0) {
        if (segments[0]?.toLowerCase() === "messages" || segments[0]?.toLowerCase() === "t") {
          return null;
        }
        const last = segments[segments.length - 1]!;
        return extractFacebookEntityId(last);
      }
    }
    return extractFacebookEntityId(trimmed);
  }
  return null;
}

function extractHeaderSection(html: string): string | null {
  const headerMatch = html.match(/<header\b[^>]*>([\s\S]*?)<\/header>/i);
  if (headerMatch) return headerMatch[0];

  const bannerMatch = html.match(/<div\b(?=[^>]*\brole=["']banner["'])[^>]*>([\s\S]*?)<\/div>/i);
  if (bannerMatch) return bannerMatch[0];

  const testIdMatch = html.match(
    /<div\b(?=[^>]*\bdata-testid=["'](?:conversation_header|chat_header|message_header|mw_chat_header|group_chat_header|group_thread_header|mw_chat_header_group|direct_chat_header|mw_chat_header_direct)["'])[^>]*>([\s\S]*?)<\/div>/i
  );
  if (testIdMatch) return testIdMatch[0];

  return null;
}

/**
 * Classifies thread kind (DIRECT, GROUP, UNKNOWN) with reliability and evidence.
 * Group/Direct classification ONLY from header/banner structured cues (Finding 2).
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

  // 1. Group structured signals from header / banner ONLY
  const headerSection = extractHeaderSection(html);

  const hasGroupTestId =
    /data-testid=["'](?:group_chat_header|group_thread_header|mw_chat_header_group)["']/i.test(html) ||
    /data-thread-type=["']GROUP["']/i.test(html);

  const hasGroupAria = headerSection
    ? /aria-label=["'][^"']*(?:thông tin nhóm|group info|group details)[^"']*["']/i.test(headerSection)
    : false;
  const memberCountMatch = headerSection
    ? headerSection.match(/\b(\d+)\s*(?:thành viên|members)\b/i)
    : null;

  if (hasGroupTestId || hasGroupAria || Boolean(memberCountMatch)) {
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

  // 2. Direct structured signals from header / banner ONLY
  const hasDirectTestId =
    /data-testid=["'](?:direct_chat_header|mw_chat_header_direct)["']/i.test(html) ||
    /data-thread-type=["']DIRECT["']/i.test(html);
  const hasDirectAria = headerSection
    ? /aria-label=["'][^"']*(?:thông tin cuộc trò chuyện|conversation info|chat details)[^"']*["']/i.test(headerSection)
    : false;

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
 * Parses sender identity from opening row attributes or dedicated author elements ONLY.
 * Never extracts identity from message body links (Finding 1).
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

  // 2. Extract structured identity ONLY from opening row attributes OR dedicated author elements (Finding 1)
  let structuredUrl: string | null = null;
  let structuredId: string | null = null;
  let isPage = false;

  // A. Check opening row attributes ONLY
  const openingEntityIdMatch = openingTag.match(/\b(?:data-sender-id|data-entity-id)=["']([^"']+)["']/i);
  if (openingEntityIdMatch && openingEntityIdMatch[1]) {
    structuredId = openingEntityIdMatch[1].trim();
  }

  const openingHovercardMatch = openingTag.match(
    /\bdata-hovercard=["'][^"']*(?:id|user\.php\?id|page\.php\?id)=([0-9]+)[^"']*["']/i
  );
  if (openingHovercardMatch && openingHovercardMatch[1]) {
    structuredId = openingHovercardMatch[1].trim();
  }

  if (openingTag.includes('data-entity-type="PAGE"') || openingTag.includes('data-sender-type="PAGE"')) {
    isPage = true;
  }

  // B. Check dedicated author elements ONLY (never generic links or message body links)
  const dedicatedAuthorMatch = chunk.match(
    /<a\b(?=[^>]*\b(?:data-testid=["'](?:author_link|message_sender_avatar|sender_name)["']|class=["'][^"']*\bauthor\b))[^>]*>([\s\S]*?)<\/a>/i
  );

  if (dedicatedAuthorMatch) {
    const authorTag = dedicatedAuthorMatch[0];
    const hrefMatch = authorTag.match(/\bhref=["']([^"']+)["']/i);
    if (hrefMatch && hrefMatch[1]) {
      const rawHref = hrefMatch[1].trim();
      const fullHref = rawHref.startsWith("/") ? `https://www.facebook.com${rawHref}` : rawHref;
      const canonical = canonicalizeFacebookUrl(fullHref);
      if (canonical) {
        const extracted = extractEntityIdFromCanonicalUrl(canonical);
        if (extracted) {
          structuredUrl = canonical;
          structuredId = extracted;
        }
      }
    }

    const authorHovercard = authorTag.match(
      /\bdata-hovercard=["'][^"']*(?:id|user\.php\?id|page\.php\?id)=([0-9]+)[^"']*["']/i
    );
    if (!structuredId && authorHovercard && authorHovercard[1]) {
      structuredId = authorHovercard[1].trim();
    }

    const authorEntityId = authorTag.match(/\b(?:data-sender-id|data-entity-id)=["']([^"']+)["']/i);
    if (!structuredId && authorEntityId && authorEntityId[1]) {
      structuredId = authorEntityId[1].trim();
    }
  }

  // Page indicators on opening tag or dedicated author container / badge
  const hasPageBadge =
    openingTag.includes('data-testid="page_badge"') ||
    body.includes('data-testid="page_badge"') ||
    body.includes('aria-label="Trang"') ||
    body.includes('aria-label="Page"') ||
    body.includes('aria-label="Được xác minh là Trang"') ||
    body.includes('aria-label="Verified Page"');

  if (hasPageBadge || (structuredUrl !== null && (structuredUrl.includes("/pages/") || structuredUrl.includes("/pg/")))) {
    isPage = true;
  }

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
 * Mention anchors must be designated structured mention elements (not generic role=link),
 * dedupe normalized tokens, and entity extraction must never parse thread URLs (Finding 10).
 */
export function parseMentions(
  cleanText: string,
  rawChunk: string,
  options?: ParseBubblesOptions
): MentionEvidence[] {
  const mentions: MentionEvidence[] = [];
  const seenNormalizedTokens = new Set<string>();

  const botCanonicalUrl = options?.botProfileUrl ? canonicalizeFacebookUrl(options.botProfileUrl) : null;
  const botId = options?.botParticipantId?.trim() || options?.botChannelAccountId?.trim();

  // 1. Designated structured mention elements (NOT generic role="link"!) (Finding 10)
  const anchorRegex =
    /<a\b(?=[^>]*\b(?:class=["'][^"']*\b(?:mention|uiMention)\b[^"']*|data-mention-id|data-entity-type=["']MENTION["']|data-testid=["'](?:mention_token|structured_mention)["']))[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let anchorMatch: RegExpExecArray | null;

  while ((anchorMatch = anchorRegex.exec(rawChunk)) !== null) {
    const rawHref = anchorMatch[1]!.trim();
    const innerText = anchorMatch[2]!.replace(/<[^>]+>/g, "").trim();
    const normalizedToken = innerText.toLowerCase().replace(/^@/, "").trim();

    if (!normalizedToken || seenNormalizedTokens.has(normalizedToken)) {
      continue;
    }

    const fullHref = rawHref.startsWith("/") ? `https://www.facebook.com${rawHref}` : rawHref;
    const canonical = canonicalizeFacebookUrl(fullHref);
    // Entity extraction must NEVER parse thread URLs (Finding 10c)
    const entityId =
      (canonical ? extractEntityIdFromCanonicalUrl(canonical) : null) ||
      extractEntityIdFromCanonicalUrl(fullHref) ||
      "";

    let isVerified = false;
    if (botCanonicalUrl && canonical && botCanonicalUrl === canonical) {
      isVerified = true;
    } else if (
      botId &&
      entityId &&
      (entityId === botId || extractEntityIdFromCanonicalUrl(options?.botProfileUrl || "") === entityId)
    ) {
      isVerified = true;
    }

    const offset = cleanText.indexOf(innerText);
    seenNormalizedTokens.add(normalizedToken);

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

  // 2. Structured entity spans with data-mention-id or data-entity-type="MENTION"
  const spanRegex =
    /<(?:span|div)\b(?=[^>]*\b(?:data-mention-id|data-entity-type=["']MENTION["']))[^>]*>(?:<span[^>]*>)?([\s\S]*?)(?:<\/span>)?<\/(?:span|div)>/gi;
  let spanMatch: RegExpExecArray | null;

  while ((spanMatch = spanRegex.exec(rawChunk)) !== null) {
    const innerText = spanMatch[1]!.replace(/<[^>]+>/g, "").trim();
    const normalizedToken = innerText.toLowerCase().replace(/^@/, "").trim();

    if (!normalizedToken || seenNormalizedTokens.has(normalizedToken)) {
      continue;
    }

    const idAttrMatch = spanMatch[0].match(/\b(?:data-mention-id|data-entity-id)=["']([^"']+)["']/i);
    const entityId = idAttrMatch && idAttrMatch[1] ? idAttrMatch[1].trim() : "";

    let isVerified = false;
    if (
      botId &&
      entityId &&
      (entityId === botId || extractEntityIdFromCanonicalUrl(options?.botProfileUrl || "") === entityId)
    ) {
      isVerified = true;
    }

    const offset = cleanText.indexOf(innerText);
    seenNormalizedTokens.add(normalizedToken);

    mentions.push({
      entityId,
      profileUrl: null,
      mentionText: innerText,
      offset: offset >= 0 ? offset : undefined,
      length: innerText.length > 0 ? innerText.length : undefined,
      isVerified,
      evidenceType: "ENTITY_TAG",
      rawMetadata: { spanSnippet: spanMatch[0] },
    });
  }

  // 3. Fallback: Unstructured plain text mentions (@word) - NEVER verified, deduped against normalized tokens
  const textMentionRegex = /(?:^|\s)(@[a-zA-Z0-9._-]+)/g;
  let textMatch: RegExpExecArray | null;

  while ((textMatch = textMentionRegex.exec(cleanText)) !== null) {
    const fullToken = textMatch[1]!;
    const normalizedToken = fullToken.toLowerCase().replace(/^@/, "").trim();

    if (!normalizedToken || seenNormalizedTokens.has(normalizedToken)) {
      continue;
    }

    seenNormalizedTokens.add(normalizedToken);

    mentions.push({
      entityId: "",
      profileUrl: null,
      mentionText: fullToken,
      offset: textMatch.index + (textMatch[0].length - fullToken.length),
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
 * Validates date/time bounds and NEVER uses row aria-label as timestamp (Finding 8).
 * Relative hour requires ago/trước marker (Finding 9).
 */
export function parseMessageTimestamp(
  chunk: string,
  options?: ParseBubblesOptions
): ParsedTimestampResult {
  const timeZone = resolveTimeZone(options?.timeZone);
  const observedAt = options?.observedAt ?? new Date();

  // 1. Exact machine-readable attributes on <time> or timestamp elements
  const machineAttrMatch =
    chunk.match(/<time\b[^>]*\bdatetime=["']([^"']+)["']/i) ||
    chunk.match(
      /<(?:time|div|span)\b(?=[^>]*\b(?:data-testid=["']message_timestamp["']|class=["'][^"']*\btimestamp\b|datetime|data-timestamp|data-time|data-utime))[^>]*\b(?:data-timestamp|data-time|data-utime)=["']([^"']+)["']/i
    );

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
      const parsed = Date.parse(rawVal);
      if (!isNaN(parsed)) {
        date = new Date(parsed);
        precision = rawVal.includes(".") ? "MILLISECOND" : "SECOND";
      }
    }

    // Validate date bounds (2000 - 2100) (Finding 8)
    if (date && !isNaN(date.getTime())) {
      const yr = date.getUTCFullYear();
      if (yr >= 2000 && yr <= 2100) {
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
  }

  // 2. Localized text or tooltip ONLY from dedicated timestamp elements
  // NEVER use row-level aria-label as timestamp! (Finding 8)
  const textContainerMatch =
    chunk.match(/<time\b[^>]*>([\s\S]*?)<\/time>/i) ||
    chunk.match(/<(?:span|div)\b[^>]*\bdata-testid=["']message_timestamp["'][^>]*>([\s\S]*?)<\/(?:span|div)>/i) ||
    chunk.match(/<(?:time|span|div)\b(?=[^>]*\b(?:data-testid=["']message_timestamp["']|class=["'][^"']*\btimestamp\b))[^>]*\bdata-tooltip-content=["']([^"']+)["']/i) ||
    chunk.match(/\bdata-tooltip-content=["']([^"']+)["']/i) ||
    chunk.match(/<(?:time|span|div)\b(?=[^>]*\b(?:data-testid=["']message_timestamp["']|class=["'][^"']*\btimestamp\b))[^>]*\baria-label=["']([^"']+)["']/i);

  if (textContainerMatch && textContainerMatch[1]) {
    const timeText = textContainerMatch[1].replace(/<[^>]+>/g, "").trim().toLowerCase();

    // Vừa xong / Just now
    if (
      timeText === "vừa xong" ||
      timeText === "just now" ||
      timeText.startsWith("vừa xong") ||
      timeText.startsWith("just now")
    ) {
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

    // Relative minutes (must have trước or ago)
    const minMatch = timeText.match(/\b(\d+)\s*(?:phút|phut|m|min|mins|minute|minutes)\s*(?:trước|ago)\b/i);
    if (minMatch && minMatch[1]) {
      const mins = parseInt(minMatch[1], 10);
      if (mins >= 0 && mins <= 525600) {
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
    }

    // Relative hours (must have trước or ago - Finding 9)
    const hourMatch = timeText.match(/\b(\d+)\s*(?:giờ|gio|h|hr|hrs|hour|hours)\s*(?:trước|ago)\b/i);
    if (hourMatch && hourMatch[1]) {
      const hrs = parseInt(hourMatch[1], 10);
      if (hrs >= 0 && hrs <= 8760) {
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
    }

    // Clock pattern (HH:MM or HH:MM AM/PM)
    const clockMatch = timeText.match(/\b(\d{1,2}):(\d{2})(?:\s*(am|pm))?\b/i);
    if (clockMatch && clockMatch[1] && clockMatch[2]) {
      let hour = parseInt(clockMatch[1], 10);
      const minute = parseInt(clockMatch[2], 10);
      const meridiem = clockMatch[3]?.toLowerCase();

      let validTime = true;
      if (meridiem) {
        if (hour < 1 || hour > 12) validTime = false;
        if (meridiem === "pm" && hour < 12) hour += 12;
        if (meridiem === "am" && hour === 12) hour = 0;
      } else {
        if (hour < 0 || hour > 23) validTime = false;
      }
      if (minute < 0 || minute > 59) validTime = false;

      if (validTime) {
        const zoned = getZonedDateParts(observedAt, timeZone);
        let year = zoned.year;
        let month = zoned.month;
        let day = zoned.day;

        // Yesterday
        if (timeText.includes("hôm qua") || timeText.includes("yesterday")) {
          const yesterdayObserved = new Date(observedAt.getTime() - 86400000);
          const yZoned = getZonedDateParts(yesterdayObserved, timeZone);
          year = yZoned.year;
          month = yZoned.month;
          day = yZoned.day;
        } else {
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
        }

        if (isValidDateParts(year, month, day, hour, minute, 0)) {
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
      observedPrecision: "MILLISECOND",
      observedSourceLabel: "browser_observer_fallback",
    }),
  };
}

function cleanHtmlText(html: string): string {
  const withLineBreaks = html.replace(/<br\s*\/?>/gi, "___LINEBREAK___");
  const stripped = withLineBreaks.replace(/<[^>]+>/g, "");
  const unescaped = stripped
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");

  const normalized = unescaped.replace(/\s+/g, " ").trim();
  return normalized.replace(/___LINEBREAK___/g, "\n").trim();
}

/**
 * Preserves complete nested bubble text including styled spans, mentions, and line breaks (Finding 6).
 */
function extractNestedBubbleText(html: string): string {
  const tagRegex = /<(div|span)\b(?=[^>]*\bdir=["']auto["'])[^>]*>/gi;
  let match: RegExpExecArray | null;
  const textSegments: string[] = [];

  let lastIndex = 0;
  while ((match = tagRegex.exec(html)) !== null) {
    if (match.index < lastIndex) {
      continue;
    }
    const tagName = match[1]!.toLowerCase();
    const startIdx = match.index + match[0].length;

    let depth = 1;
    const tokenRegex = new RegExp(`(</?${tagName}\\b[^>]*>)`, "gi");
    tokenRegex.lastIndex = startIdx;

    let endIdx = -1;
    let tokenMatch: RegExpExecArray | null;
    while ((tokenMatch = tokenRegex.exec(html)) !== null) {
      const token = tokenMatch[0];
      if (token.startsWith(`</${tagName}`)) {
        depth--;
        if (depth === 0) {
          endIdx = tokenMatch.index;
          lastIndex = tokenRegex.lastIndex;
          break;
        }
      } else if (!token.endsWith("/>")) {
        depth++;
      }
    }

    if (endIdx !== -1) {
      const innerHtml = html.slice(startIdx, endIdx);
      const clean = cleanHtmlText(innerHtml);
      if (clean) {
        textSegments.push(clean);
      }
    }
  }

  if (textSegments.length > 0) {
    return textSegments.join("\n");
  }

  // Fallback: strip timestamp tags before cleaning text
  const stripped = html
    .replace(/<time\b[^>]*>[\s\S]*?<\/time>/gi, "")
    .replace(/<(?:span|div)\b[^>]*\bdata-testid=["']message_timestamp["'][^>]*>[\s\S]*?<\/(?:span|div)>/gi, "");
  return cleanHtmlText(stripped);
}

/**
 * Determines whether a row chunk represents an actual message bubble row (Finding 4).
 * Non-message rows (status, system notices, pure date dividers) must not mark DOM as degraded.
 */
function isActualMessageRow(openingTag: string, body: string, text: string): boolean {
  if (
    openingTag.includes('role="status"') ||
    openingTag.includes('data-testid="system_message"') ||
    body.includes('data-testid="system_message"') ||
    openingTag.includes('data-sender-type="SYSTEM"')
  ) {
    return false;
  }

  const cleanTrimmed = text.trim();
  if (
    /^(?:hôm nay|hôm qua|yesterday|today|\d{1,2}:\d{2}(?:\s*(?:am|pm))?)$/i.test(cleanTrimmed) &&
    !body.includes('data-testid="author_link"') &&
    !openingTag.includes('data-testid="outgoing_message"') &&
    !body.includes('data-testid="outgoing_message"')
  ) {
    return false;
  }

  const hasMessageTestId =
    openingTag.includes('data-testid="mw_message_row"') ||
    openingTag.includes('data-testid="message_row"') ||
    openingTag.includes('data-testid="outgoing_message"') ||
    body.includes('data-testid="outgoing_message"') ||
    openingTag.includes('data-testid="incoming_group_row"') ||
    body.includes('data-testid="incoming_group_row"') ||
    body.includes('data-testid="author_link"') ||
    openingTag.includes('data-sender-id') ||
    openingTag.includes('data-entity-id');

  const hasOutgoingOrIncomingAria =
    /^(?:bạn đã gửi|bạn|you sent|you)\s*[:;]/i.test(openingTag) ||
    /aria-label=["'][^"']+:\s*[^"']+["']/i.test(openingTag);

  const hasBubbleContainer =
    body.includes('dir="auto"') ||
    body.includes('data-testid="bubble_text"') ||
    body.includes('class="bubble"');

  return Boolean(
    hasMessageTestId ||
    hasOutgoingOrIncomingAria ||
    (hasBubbleContainer && openingTag.includes('role="row"'))
  );
}

/**
 * Parses Messenger message bubble rows from HTML string or DOM representation.
 * Preserves degraded-DOM safeguards: missing stable mid marks isDegraded = true
 * ONLY for actual message rows (Finding 4).
 */
export function parseMessengerBubblesFromHtml(
  html: string,
  options?: ParseBubblesOptions
): BubbleParseResult {
  const bubbles: ParsedBubble[] = [];
  let isDegraded = false;
  let degradedReason: string | undefined;

  // Classify thread from surrounding HTML header/banner cues (Finding 2)
  const threadClassification = parseThreadClassification(html, options);

  // Split by message rows or status rows
  const rowChunks = html.split(
    /<div\b(?=[^>]*\b(?:role=["'](?:row|status)["']|data-testid=["'](?:mw_message_row|system_message)["']))/i
  );

  for (let i = 1; i < rowChunks.length; i++) {
    const chunk = rowChunks[i]!;
    const tagEndIdx = chunk.indexOf(">");
    if (tagEndIdx === -1) continue;

    const openingTag = chunk.slice(0, tagEndIdx);
    const body = chunk.slice(tagEndIdx + 1);

    // Strip dedicated author links before extracting text
    const bodyWithoutAuthor = body.replace(
      /<a\b(?=[^>]*\b(?:data-testid=["'](?:author_link|message_sender_avatar|sender_name)["']|class=["'][^"']*\bauthor\b))[\s\S]*?<\/a>/gi,
      ""
    );

    // Extract complete nested bubble text (Finding 6)
    const cleanText = extractNestedBubbleText(bodyWithoutAuthor) || extractNestedBubbleText(body);

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
      // Degraded only for ACTUAL message rows (Finding 4)
      if (isActualMessageRow(openingTag, body, cleanText)) {
        isDegraded = true;
        degradedReason = `Message row with text "${cleanText.slice(0, 30)}" missing stable mid identifier`;
      }
      continue;
    }

    const stableId = rawId!;

    // Check outgoing vs incoming with anchored aria prefixes (Finding 5)
    const ariaLabelMatch =
      openingTag.match(/aria-label=["']([^"']+)["']/i) ||
      body.match(/aria-label=["']([^"']+)["']/i);
    const ariaLabel = ariaLabelMatch ? ariaLabelMatch[1]!.trim().toLowerCase() : "";

    const isOutgoingAria =
      /^(?:bạn đã gửi|bạn|you sent|you)\s*[:;]/i.test(ariaLabel) ||
      /^(?:bạn đã gửi|you sent)\b/i.test(ariaLabel);

    const isOutgoing =
      isOutgoingAria ||
      openingTag.includes('data-testid="outgoing_message"') ||
      body.includes('data-testid="outgoing_message"');

    // Parse sender identity from trustworthy structured DOM evidence (Finding 1)
    const senderResult = parseSenderIdentity(chunk, openingTag, body, options);

    // Parse structured and plain text mentions (Finding 10)
    const mentions = parseMentions(cleanText, chunk, options);

    // Parse timestamps (Findings 8 & 9)
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
      /class=["'][^"']*\bunread\b/i.test(inner) ||
      /aria-label=["'][^"']*(?:chưa đọc|unread)[^"']*["']/i.test(inner);

    // Check outgoing snippet
    const isOutgoing =
      textWithoutTags.includes("Bạn:") ||
      textWithoutTags.includes("You:") ||
      textWithoutTags.includes("Bạn đã gửi") ||
      textWithoutTags.includes("You sent");

    // Extract customer display name
    const nameMatch =
      /<span\b[^>]*\bdir=["']auto["'][^>]*>([\s\S]*?)<\/span>/i.exec(inner) ||
      /<strong\b[^>]*>([\s\S]*?)<\/strong>/i.exec(inner);

    const customerName = nameMatch
      ? nameMatch[1]!.replace(/<[^>]+>/g, "").trim()
      : threadId;

    const threadKind: ThreadKind =
      textWithoutTags.includes("thành viên") || textWithoutTags.includes("members")
        ? "GROUP"
        : "DIRECT";
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
