export interface ParsedBubble {
  id: string;
  text: string;
  isOutgoing: boolean;
  senderName?: string;
}

export interface BubbleParseResult {
  ok: boolean;
  bubbles: ParsedBubble[];
  isDegraded: boolean;
  degradedReason?: string;
}

export interface ParsedSidebarThread {
  threadId: string;
  threadRef: string;
  customerName: string;
  snippet: string;
  isUnread: boolean;
  isOutgoing: boolean;
}

/**
 * Parses Messenger message bubble rows from HTML string or DOM representation.
 * If a row has text content but lacks a stable identity attribute (e.g. mid.$...),
 * marks isDegraded = true so caller transitions to DEGRADED rather than inventing Date.now().
 */
export function parseMessengerBubblesFromHtml(html: string): BubbleParseResult {
  const bubbles: ParsedBubble[] = [];
  let isDegraded = false;
  let degradedReason: string | undefined;

  // Split by message rows
  const rowChunks = html.split(/<div\b(?=[^>]*\brole=["']row["'])/i);

  for (let i = 1; i < rowChunks.length; i++) {
    const chunk = rowChunks[i]!;
    const tagEndIdx = chunk.indexOf(">");
    if (tagEndIdx === -1) continue;

    const openingTag = chunk.slice(0, tagEndIdx);
    const body = chunk.slice(tagEndIdx + 1);

    // Extract text content from dir="auto" or inner text
    const textMatch =
      /<(?:div|span)\b[^>]*\bdir=["']auto["'][^>]*>([\s\S]*?)<\/(?:div|span)>/i.exec(body) ||
      /<span\b[^>]*>([\s\S]*?)<\/span>/i.exec(body) ||
      /<div\b[^>]*>([\s\S]*?)<\/div>/i.exec(body);

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

    let senderName: string | undefined;
    if (ariaLabelMatch && ariaLabelMatch[1]) {
      const parts = ariaLabelMatch[1].split(/[:;]/);
      if (parts.length > 1 && parts[0]) {
        senderName = parts[0].trim();
      }
    }

    bubbles.push({
      id: stableId,
      text: cleanText,
      isOutgoing,
      senderName,
    });
  }

  return {
    ok: !isDegraded && bubbles.length > 0,
    bubbles,
    isDegraded,
    degradedReason,
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

    threads.push({
      threadId,
      threadRef,
      customerName,
      snippet: textWithoutTags,
      isUnread,
      isOutgoing,
    });
  }

  return threads;
}
