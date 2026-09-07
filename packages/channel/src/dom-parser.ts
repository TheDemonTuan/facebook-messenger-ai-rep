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
  resolveBusinessTimeZone,
  getZonedDateParts,
  getUtcDateFromZonedParts,
} from "@messenger/contracts";

export { getUtcDateFromZonedParts, getZonedDateParts };

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
  headerTitle?: string | null;
  avatarUrl?: string | null;
}

export interface ParsedSidebarThread {
  threadId: string;
  threadRef: string;
  customerName: string;
  avatarUrl?: string | null;
  participantId?: string | null;
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
  threadTitleHint?: string;
  senderParticipantIdHint?: string;
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

/**
 * Normalizes an IANA timezone identifier, defaulting to Asia/Ho_Chi_Minh.
 */
function resolveTimeZone(timeZone?: string): string {
  return resolveBusinessTimeZone(timeZone);
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

export function findTagEnd(html: string, startIdx: number): number {
  let inDouble = false;
  let inSingle = false;
  for (let i = startIdx; i < html.length; i++) {
    const ch = html[i];
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === ">" && !inDouble && !inSingle) {
      return i;
    }
  }
  return -1;
}

export function findMatchingClosingTag(
  html: string,
  startContentIdx: number,
  tagName: string
): { contentEndIdx: number; fullEndIdx: number } | null {
  const lowerTag = tagName.toLowerCase();
  let depth = 1;
  let i = startContentIdx;
  const len = html.length;

  while (i < len) {
    const nextLt = html.indexOf("<", i);
    if (nextLt === -1) break;

    // Skip HTML comments <!-- ... -->
    if (html.startsWith("<!--", nextLt)) {
      const commentEnd = html.indexOf("-->", nextLt + 4);
      i = commentEnd === -1 ? len : commentEnd + 3;
      continue;
    }

    const tagEnd = findTagEnd(html, nextLt);
    if (tagEnd === -1) {
      i = nextLt + 1;
      continue;
    }

    const tagContent = html.slice(nextLt + 1, tagEnd).trim();
    if (tagContent.startsWith("/")) {
      const closingName = tagContent.slice(1).trim().split(/\s+/)[0]?.toLowerCase();
      if (closingName === lowerTag) {
        depth--;
        if (depth === 0) {
          return {
            contentEndIdx: nextLt,
            fullEndIdx: tagEnd + 1,
          };
        }
      }
    } else {
      const isSelfClosing = tagContent.endsWith("/");
      const openName = tagContent.replace(/\/$/, "").trim().split(/\s+/)[0]?.toLowerCase();
      if (openName === lowerTag && !isSelfClosing) {
        depth++;
      }
    }

    i = tagEnd + 1;
  }

  return null;
}

export function extractHeaderSection(html: string): string | null {
  const headerMatch = html.match(/<header\b[^>]*>/i);
  if (headerMatch && headerMatch.index !== undefined) {
    const tagEnd = findTagEnd(html, headerMatch.index);
    if (tagEnd !== -1) {
      const closing = findMatchingClosingTag(html, tagEnd + 1, "header");
      if (closing) {
        return html.slice(headerMatch.index, closing.fullEndIdx);
      }
    }
  }

  const bannerMatch = html.match(/<div\b(?=[^>]*\brole=["']banner["'])[^>]*>/i);
  if (bannerMatch && bannerMatch.index !== undefined) {
    const tagEnd = findTagEnd(html, bannerMatch.index);
    if (tagEnd !== -1) {
      const closing = findMatchingClosingTag(html, tagEnd + 1, "div");
      if (closing) {
        return html.slice(bannerMatch.index, closing.fullEndIdx);
      }
    }
  }

  const testIdMatch = html.match(
    /<div\b(?=[^>]*\bdata-testid=["'](?:conversation_header|chat_header|message_header|mw_chat_header|group_chat_header|group_thread_header|mw_chat_header_group|direct_chat_header|mw_chat_header_direct)["'])[^>]*>/i
  );
  if (testIdMatch && testIdMatch.index !== undefined) {
    const tagEnd = findTagEnd(html, testIdMatch.index);
    if (tagEnd !== -1) {
      const closing = findMatchingClosingTag(html, tagEnd + 1, "div");
      if (closing) {
        return html.slice(testIdMatch.index, closing.fullEndIdx);
      }
    }
  }

  return null;
}

/**
 * Classifies thread kind (DIRECT, GROUP, UNKNOWN) with reliability and evidence.
 * Group/Direct classification ONLY from header/banner structured cues (Finding 2, F08).
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

  const headerSection = extractHeaderSection(html);
  const threadTitle = options?.threadTitleHint?.trim();

  // 1. Group structured signals from header / banner ONLY (Finding 2, F08)
  if (headerSection) {
    const structuredHeaderText = cleanHtmlText(headerSection);

    const hasGroupTestId =
      /data-testid=["'](?:group_chat_header|group_thread_header|mw_chat_header_group)["']/i.test(headerSection) ||
      /data-thread-type=["']GROUP["']/i.test(headerSection);

    const hasGroupAria =
      /aria-label=["'][^"']*(?:thông tin nhóm|group info|group details|chat members|tùy chọn nhóm|group options)[^"']*["']/i.test(headerSection);

    const memberCountMatch = headerSection.match(/\b(\d+)\s*(?:thành viên|members)\b/i);
    const hasChatMembers = /\b(?:chat members|thành viên (?:đoạn chat|nhóm))\b/i.test(structuredHeaderText);

    if (hasGroupTestId || hasGroupAria || Boolean(memberCountMatch) || hasChatMembers) {
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
              hasChatMembers,
              memberCount: memberCountMatch ? memberCountMatch[1] : null,
            },
          },
        ],
      };
    }

    // 2. Direct structured signals in header
    const hasDirectTestId =
      /data-testid=["'](?:direct_chat_header|mw_chat_header_direct|conversation_header|chat_header)["']/i.test(headerSection) ||
      /data-thread-type=["']DIRECT["']/i.test(headerSection);

    const hasDirectAria =
      /aria-label=["'][^"']*(?:thông tin cuộc trò chuyện|conversation info|chat details)[^"']*["']/i.test(headerSection);

    const hasDirectPresence = /\b(?:active now|đang hoạt động|active \d+[smhd]? ago|hoạt động \d+ phút trước)\b/i.test(headerSection);
    const hasDirectCalls = /\b(?:bắt đầu gọi thoại|bắt đầu gọi video|bắt đầu cuộc gọi|start a voice call|start a video call|start a call)\b/i.test(headerSection);
    const hasDirectControls =
      (/\b(?:profile|trang cá nhân)\b/i.test(structuredHeaderText) ||
        hasDirectCalls ||
        hasDirectPresence) &&
      !hasChatMembers;
    const hasDirectParticipant = Boolean(threadTitle && structuredHeaderText.includes(threadTitle) && hasDirectControls);

    if (hasDirectTestId || hasDirectAria || hasDirectParticipant || hasDirectControls) {
      return {
        kind: "DIRECT",
        reliability: "VERIFIED",
        evidence: [
          {
            source: "DOM_SELECTOR",
            signal: "direct_header_indicator",
            confidence: 1.0,
            details: { hasDirectTestId, hasDirectAria, hasDirectParticipant, hasDirectPresence, hasDirectCalls },
          },
        ],
      };
    }
  } else {
    // When no explicit header element is found, exclude message rows from surrounding HTML
    // to avoid false signals from customer text or shared cards
    const rows = extractMessageRowElements(html);
    let surroundingHtml = html;
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i]!;
      surroundingHtml = surroundingHtml.slice(0, r.startIndex) + surroundingHtml.slice(r.startIndex + r.fullHtml.length);
    }
    const structuredSurrounding = cleanHtmlText(surroundingHtml);

    const hasDirectPresence = /\b(?:active now|đang hoạt động|active \d+[smhd]? ago|hoạt động \d+ phút trước)\b/i.test(surroundingHtml);
    const hasDirectCalls = /\b(?:bắt đầu gọi thoại|bắt đầu gọi video|bắt đầu cuộc gọi|start a voice call|start a video call|start a call)\b/i.test(surroundingHtml);
    const hasDirectControls =
      (/\b(?:profile|trang cá nhân)\b/i.test(structuredSurrounding) ||
        hasDirectCalls ||
        hasDirectPresence) &&
      !/\b(?:chat members|thành viên (?:đoạn chat|nhóm))\b/i.test(structuredSurrounding);
    const hasDirectParticipant = Boolean(threadTitle && structuredSurrounding.includes(threadTitle) && hasDirectControls);

    const hasDirectTestId =
      /data-testid=["'](?:direct_chat_header|mw_chat_header_direct)["']/i.test(surroundingHtml) ||
      /data-thread-type=["']DIRECT["']/i.test(surroundingHtml);

    const hasDirectAria =
      /aria-label=["'][^"']*(?:thông tin cuộc trò chuyện|conversation info|chat details)[^"']*["']/i.test(surroundingHtml);

    if (hasDirectTestId || hasDirectAria || hasDirectParticipant) {
      return {
        kind: "DIRECT",
        reliability: "VERIFIED",
        evidence: [
          {
            source: "DOM_SELECTOR",
            signal: "direct_header_indicator",
            confidence: 1.0,
            details: { hasDirectTestId, hasDirectAria, hasDirectParticipant, hasDirectPresence, hasDirectCalls },
          },
        ],
      };
    }
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
    const label = ariaLabelMatch[1];
    const timestampedSender = label.match(/^(?:at|lúc)\s+.+,\s*([^:;]+)(?=[:;]|$)/i)?.[1];
    const parts = label.split(/[:;]/);
    senderName = timestampedSender?.trim() || (parts.length > 1 ? parts[0]?.trim() : undefined);
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
  let structuredId: string | null = _options?.senderParticipantIdHint?.trim() || null;
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
          signal: isPage
            ? "page_badge_and_link"
            : (_options?.senderParticipantIdHint ? "thread_participant_hint" : "structured_profile_link"),
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

export function stripNonContentElements(body: string): string {
  let result = body;

  // 1. Remove void tags like <img>, <input>, <textarea>
  result = result.replace(/<(?:img|input|textarea)\b[^>]*>/gi, "");

  // 2. Remove non-content container elements using balanced tag removal
  const nonContentOpenTagRegex =
    /<(div|span|button|section|aside|blockquote|header|a|ul|ol|li|time)\b(?=[^>]*\b(?:role=["'](?:button|toolbar|menu|menuitem)["']|data-testid=["'](?:message_actions|reaction_picker|message_action_menu|action_button|quick_replies|message_receipt|delivery_status|seen_receipt|seen_heads|delivery_receipt|user_presence|presence_indicator|presence_badge|author_link|message_sender_avatar|sender_name|author_name|avatar|quoted_message|reply_to_message|message_quote|reply_preview|message_timestamp)["']|class=["'][^"']*\b(?:message-actions|reaction-picker|action-button|receipt|delivery-status|delivery-receipt|seen-receipt|presence|presence-indicator|author|sender_name|avatar|quoted_message|reply_preview|timestamp)\b|aria-label=["'][^"']*(?:bày tỏ cảm xúc|react|trả lời|reply|chuyển tiếp|forward|xem thêm|more|thao tác|actions|gửi tin nhắn|nhấn enter|message sent|đã gửi|đã chuyển|đã nhận|đã xem|seen by|delivered|active now|active \d+|đang hoạt động|hoạt động \d+|đang trả lời|replying to|replied to)[^"']*["']))/gi;

  let maxIterations = 50;
  while (maxIterations > 0) {
    maxIterations--;
    nonContentOpenTagRegex.lastIndex = 0;
    const match = nonContentOpenTagRegex.exec(result);
    if (!match) break;

    const startIdx = match.index;
    const tagName = match[1]!.toLowerCase();
    const tagEnd = findTagEnd(result, startIdx);
    if (tagEnd === -1) {
      result = result.slice(0, startIdx);
      break;
    }

    const closing = findMatchingClosingTag(result, tagEnd + 1, tagName);
    if (closing) {
      result = result.slice(0, startIdx) + result.slice(closing.fullEndIdx);
    } else {
      result = result.slice(0, startIdx) + result.slice(tagEnd + 1);
    }
  }

  // Also remove standalone <time> and <blockquote> elements
  const standaloneTagRegex = /<(time|blockquote|button)\b[^>]*>/gi;
  maxIterations = 50;
  while (maxIterations > 0) {
    maxIterations--;
    standaloneTagRegex.lastIndex = 0;
    const match = standaloneTagRegex.exec(result);
    if (!match) break;

    const startIdx = match.index;
    const tagName = match[1]!.toLowerCase();
    const tagEnd = findTagEnd(result, startIdx);
    if (tagEnd === -1) {
      result = result.slice(0, startIdx);
      break;
    }

    const closing = findMatchingClosingTag(result, tagEnd + 1, tagName);
    if (closing) {
      result = result.slice(0, startIdx) + result.slice(closing.fullEndIdx);
    } else {
      result = result.slice(0, startIdx) + result.slice(tagEnd + 1);
    }
  }

  return result;
}

const TRUSTED_MID_REGEX = /^(?:mid[.$:]|m_|active\.\$)[A-Za-z0-9_$.-]+$/i;

export function extractStableMessageId(openingTag: string, body: string): string | null {
  // 1. Primary: explicitly designated message ID attributes on the message row opening tag
  const messageIdAttrMatch = openingTag.match(/\b(?:data-message-id|data-mid)=["']([^"']+)["']/i);
  if (messageIdAttrMatch && messageIdAttrMatch[1]) {
    const val = messageIdAttrMatch[1].trim();
    if (val) return val;
  }

  // 2. Secondary: id or data-id on the row opening tag if it matches trusted message ID syntax
  const idAttrMatch = openingTag.match(/\b(?:id|data-id)=["']([^"']+)["']/i);
  if (idAttrMatch && idAttrMatch[1]) {
    const val = idAttrMatch[1].trim();
    if (TRUSTED_MID_REGEX.test(val)) {
      return val;
    }
  }

  // 3. Dedicated message root / container elements inside the row (NOT arbitrary descendants!)
  const containerMatch = body.match(
    /<(?:div|span|li)\b(?=[^>]*\b(?:data-testid=["'](?:mw_message_row|message_row|message_bubble|bubble_text)["']|aria-roledescription=["']message["']))[^>]*\b(?:data-message-id|data-mid|id|data-id)=["']([^"']+)["']/i
  );
  if (containerMatch && containerMatch[1]) {
    const val = containerMatch[1].trim();
    if (TRUSTED_MID_REGEX.test(val)) {
      return val;
    }
  }

  return null;
}

export interface ExtractedRowElement {
  openingTag: string;
  body: string;
  fullHtml: string;
  startIndex: number;
}

export function extractMessageRowElements(html: string): ExtractedRowElement[] {
  const rows: ExtractedRowElement[] = [];
  const rowStartRegex =
    /<(div|li)\b(?=[^>]*\b(?:role=["'](?:row|status)["']|aria-roledescription=["']message["']|data-testid=["'](?:mw_message_row|message_row|system_message|outgoing_message|incoming_group_row)["']))/gi;

  let match: RegExpExecArray | null;
  let searchIdx = 0;

  while ((match = rowStartRegex.exec(html)) !== null) {
    const startIndex = match.index;
    if (startIndex < searchIdx) continue;

    const tagName = match[1]!.toLowerCase();
    const tagEnd = findTagEnd(html, startIndex);
    if (tagEnd === -1) continue;

    const openingTag = html.slice(startIndex, tagEnd + 1);
    const closing = findMatchingClosingTag(html, tagEnd + 1, tagName);

    if (closing) {
      const body = html.slice(tagEnd + 1, closing.contentEndIdx);
      const fullHtml = html.slice(startIndex, closing.fullEndIdx);
      rows.push({ openingTag, body, fullHtml, startIndex });
      searchIdx = closing.fullEndIdx;
      rowStartRegex.lastIndex = closing.fullEndIdx;
    } else {
      // Fallback if tag is unclosed
      const nextMatch = html.slice(tagEnd + 1).search(rowStartRegex);
      const bodyEnd = nextMatch !== -1 ? tagEnd + 1 + nextMatch : html.length;
      const body = html.slice(tagEnd + 1, bodyEnd);
      const fullHtml = html.slice(startIndex, bodyEnd);
      rows.push({ openingTag, body, fullHtml, startIndex });
      searchIdx = bodyEnd;
      rowStartRegex.lastIndex = bodyEnd;
    }
  }

  return rows;
}

/**
 * Preserves complete nested bubble text including styled spans, mentions, and line breaks (Finding 6).
 */
export function extractNestedBubbleText(html: string): string {
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

    const closing = findMatchingClosingTag(html, startIdx, tagName);
    if (closing) {
      const innerHtml = html.slice(startIdx, closing.contentEndIdx);
      const clean = cleanHtmlText(innerHtml);
      if (clean) {
        textSegments.push(clean);
      }
      lastIndex = closing.fullEndIdx;
      tagRegex.lastIndex = closing.fullEndIdx;
    }
  }

  if (textSegments.length > 0) {
    return textSegments.join("\n");
  }

  return "";
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
    openingTag.includes('aria-roledescription="message"') ||
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

  // Classify thread from surrounding HTML header/banner cues (Finding 2, F08)
  const threadClassification = parseThreadClassification(html, options);

  const messageRows = extractMessageRowElements(html);

  for (const row of messageRows) {
    const { openingTag, body, fullHtml: chunk } = row;

    // 1. Strip non-content UI elements (controls, receipts, presence, avatars, quotes, headers, timestamps)
    const cleanBody = stripNonContentElements(body);

    const ariaLabelMatch = openingTag.match(/aria-label=["']([^"']+)["']/i);
    const ariaLabel = ariaLabelMatch ? cleanHtmlText(ariaLabelMatch[1]!) : "";
    const ariaMessageText = ariaLabel.match(/^(?:at|lúc)\s+.+,\s*[^:;]+[:;]\s*([\s\S]+)$/i)?.[1]?.trim();

    // Prefer bubble container text, fall back to opening tag's ariaMessageText or cleanBody text
    const bubbleText = extractNestedBubbleText(cleanBody);
    const cleanText = bubbleText || ariaMessageText || cleanHtmlText(cleanBody);

    if (!cleanText) {
      continue;
    }

    // Look for stable message ID from trusted sources (P0: tighten native message ID)
    const stableId = extractStableMessageId(openingTag, body);

    if (!stableId) {
      // Degraded only for ACTUAL message rows (Finding 4)
      if (isActualMessageRow(openingTag, body, cleanText)) {
        isDegraded = true;
        degradedReason = `Message row with text "${cleanText.slice(0, 30)}" missing stable mid identifier`;
      }
      continue;
    }

    // Check outgoing vs incoming with anchored aria prefixes (Finding 5)
    const normalizedAriaLabel = ariaLabel.toLowerCase();
    const timestampedSender = normalizedAriaLabel.match(/^(?:at|lúc)\s+.+,\s*([^:;]+)(?=[:;]|$)/i)?.[1]?.trim();

    const isOutgoingAria =
      /^(?:bạn đã gửi|bạn|you sent|you)\s*[:;]/i.test(normalizedAriaLabel) ||
      /^(?:bạn đã gửi|you sent)\b/i.test(normalizedAriaLabel) ||
      /^(?:you|bạn)$/i.test(timestampedSender ?? "");

    const isOutgoing =
      isOutgoingAria ||
      openingTag.includes('data-testid="outgoing_message"') ||
      openingTag.includes('data-outgoing="true"') ||
      chunk.includes('data-outgoing="true"') ||
      chunk.includes('data-testid="outgoing_message"');

    // Parse sender identity from trustworthy structured DOM evidence (Finding 1)
    const senderResult = parseSenderIdentity(chunk, openingTag, body, {
      ...options,
      senderParticipantIdHint:
        threadClassification.kind === "DIRECT" && threadClassification.reliability === "VERIFIED"
          ? options?.senderParticipantIdHint
          : undefined,
    });

    // Parse structured and plain text mentions (Finding 10)
    const mentions = parseMentions(cleanText, chunk, options);

    // Parse timestamps (Findings 8 & 9)
    const timestampResult = parseMessageTimestamp(chunk, options);

    bubbles.push({
      id: stableId,
      text: cleanText,
      isOutgoing,
      senderName: isOutgoing ? undefined : senderResult.senderName,
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

export function isSnippetOutgoing(snippet: string): boolean {
  return (
    /\b(?:bạn|you)\s*:/i.test(snippet) ||
    /\b(?:bạn đã gửi|you sent)\b/i.test(snippet)
  );
}

export function extractCleanSnippetText(rawSnippet: string, customerName?: string | null): string {
  if (!rawSnippet) return "";
  let text = rawSnippet.replace(/\s+/g, " ").trim();

  // Strip customer name prefix if present
  if (customerName && customerName.trim()) {
    const name = customerName.trim();
    while (text.toLowerCase().startsWith(name.toLowerCase())) {
      text = text.slice(name.length).trim();
      text = text.replace(/^[:\-\s]+/, "").trim();
    }
  }

  // Remove middle dot / bullet separator and anything following it (always timestamp in Messenger sidebar)
  text = text.replace(/\s*[·•].*$/, "").trim();

  // Remove standalone timestamp suffixes at the end of line
  text = text.replace(/\s+\d+\s*(?:phút|giờ|ngày|tuần|tháng|giây|năm|m|h|d|w|s)\s*$/iu, "").trim();

  // Remove action labels
  text = text.replace(/\b(?:đánh dấu là chưa đọc|đánh dấu là đã đọc|mark as unread|mark as read)\b/giu, "").trim();

  // Clean any leftover trailing punctuation from separators
  text = text.replace(/[\s:·•-]+$/, "").trim();

  return text;
}

/**
 * Parses Messenger sidebar thread items from HTML.
 * Sidebar is only a trigger - extracts threadRef, threadId, and unread indicator.
 */
export function parseSidebarThreadsFromHtml(html: string): ParsedSidebarThread[] {
  const threads: ParsedSidebarThread[] = [];
  const seenThreadIds = new Set<string>();
  const linkRegex = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;

  while ((match = linkRegex.exec(html)) !== null) {
    const attrs = match[1] || "";
    const inner = match[2] || "";

    const hrefMatch = /href=["']([^"']+)["']/i.exec(attrs);
    if (!hrefMatch) continue;
    const threadRef = hrefMatch[1]!;

    const idMatch = /\/messages\/(?:e2ee\/)?t\/([^/?#"'\s]+)/i.exec(threadRef);
    if (!idMatch) continue;
    const threadId = idMatch[1]!;
    if (!threadId || seenThreadIds.has(threadId)) continue;

    // Check data annotations first
    const attrCustomerName = /data-messenger-customer-name=["']([^"']*)["']/i.exec(attrs)?.[1];
    const attrSnippet = /data-messenger-snippet=["']([^"']*)["']/i.exec(attrs)?.[1];
    const attrUnread = /data-messenger-unread=["']([^"']*)["']/i.exec(attrs)?.[1];
    const attrParticipantId = /data-messenger-participant-id=["']([^"']*)["']/i.exec(attrs)?.[1];
    const attrAvatarUrl = /data-messenger-avatar-url=["']([^"']*)["']/i.exec(attrs)?.[1];

    let customerName = attrCustomerName;
    if (!customerName) {
      const nameMatch =
        /<span\b[^>]*\bdir=["']auto["'][^>]*>([\s\S]*?)<\/span>/i.exec(inner) ||
        /<strong\b[^>]*>([\s\S]*?)<\/strong>/i.exec(inner);
      customerName = nameMatch ? nameMatch[1]!.replace(/<[^>]+>/g, "").trim() : threadId;
    }

    let avatarUrl = attrAvatarUrl !== undefined ? (attrAvatarUrl || null) : null;
    if (!avatarUrl) {
      const avatarMatch =
        /<img\b[^>]*\bsrc=["']([^"']*(?:scontent|fbcdn)[^"']*)["']/i.exec(inner) ||
        /<image\b[^>]*\b(?:xlink:href|href)=["']([^"']*(?:scontent|fbcdn)[^"']*)["']/i.exec(inner) ||
        /<img\b[^>]*\bsrc=["']([^"']+)["']/i.exec(inner);
      avatarUrl = avatarMatch ? avatarMatch[1]! : null;
    }

    let participantId: string | null = attrParticipantId !== undefined ? (attrParticipantId || null) : null;
    if (!participantId) {
      const pidFromHref = threadRef.match(/[?&](?:id|participant_id)=([0-9]+)/i)?.[1];
      const pidFromImg = inner.match(/<img\b[^>]*src=["'][^"']*[?&]fbid=([0-9]+)[^"']*["']/i)?.[1];
      const textWithoutTags = inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      const isGroupText = /\b(?:\d+\s*(?:members|thành viên)|chat members|group options)\b/i.test(textWithoutTags);
      participantId = pidFromHref || pidFromImg || (/^[0-9]+$/.test(threadId) && !isGroupText ? threadId : null);
    }

    let rawSnippet = attrSnippet;
    if (rawSnippet === undefined) {
      const autoSpans = inner.match(/<span\b[^>]*\bdir=["']auto["'][^>]*>[\s\S]*?<\/span>/gi);
      if (autoSpans && autoSpans.length >= 2) {
        rawSnippet = autoSpans.slice(1).map((s) => s.replace(/<[^>]+>/g, "").trim()).filter(Boolean).join(" ");
      }
      if (!rawSnippet) {
        const textWithoutTags = inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        rawSnippet = textWithoutTags;
      }
    }

    const snippet = extractCleanSnippetText(rawSnippet || "", customerName);
    const isOutgoing = isSnippetOutgoing(snippet);

    let isUnread = false;
    if (attrUnread !== undefined) {
      isUnread = attrUnread === "true";
    } else {
      const fullContent = `${attrs} ${inner}`;
      const sanitized = fullContent
        .replace(/đánh dấu là chưa đọc/giu, "")
        .replace(/mark as unread/giu, "");

      const hasMarkAsReadAction =
        /đánh dấu là đã đọc/iu.test(fullContent) ||
        /mark as read/iu.test(fullContent);

      const hasUnreadMention =
        /chưa đọc/iu.test(sanitized) ||
        /unread/iu.test(sanitized);

      const hasUnreadClass =
        /class=["'][^"']*\bunread\b[^"']*["']/i.test(sanitized);

      const hasBoldFont =
        /style=["'][^"']*(?:font-weight:\s*(?:bold|[6-9]00))[^"']*["']/i.test(sanitized) ||
        /<strong\b/i.test(inner);

      isUnread = hasMarkAsReadAction || hasUnreadMention || hasUnreadClass || hasBoldFont;
    }

    const textWithoutTags = inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const threadKind: ThreadKind =
      textWithoutTags.includes("thành viên") || textWithoutTags.includes("members")
        ? "GROUP"
        : "DIRECT";
    const threadReliability: ClassificationReliability = "UNVERIFIED";

    seenThreadIds.add(threadId);
    threads.push({
      threadId,
      threadRef,
      customerName,
      avatarUrl,
      participantId,
      snippet,
      isUnread,
      isOutgoing,
      threadKind,
      threadReliability,
    });
  }

  return threads;
}
