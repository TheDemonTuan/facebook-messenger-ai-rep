import type { ConversationItem, MessageItem } from "../types";

export interface CursorQueryParams {
  filter?: string;
  limit?: number;
  cursor?: string | null;
  offset?: number;
}

/**
 * Builds standard query string with cursor or limit/offset support.
 */
export function buildInboxQuery(params: CursorQueryParams): string {
  const q = new URLSearchParams();
  if (params.filter && params.filter !== "all") {
    q.append("filter", params.filter);
  }
  if (params.limit) {
    q.append("limit", params.limit.toString());
  }
  if (params.cursor) {
    q.append("cursor", params.cursor);
  } else if (params.offset !== undefined && params.offset > 0) {
    q.append("offset", params.offset.toString());
  }
  const str = q.toString();
  return str ? `?${str}` : "";
}

/**
 * Merge conversations without duplicates, preserving order by lastInboundAt descending.
 */
export function mergePaginatedConversations(
  existing: ConversationItem[],
  incoming: ConversationItem[]
): ConversationItem[] {
  const seen = new Set<string>();
  const merged: ConversationItem[] = [];

  for (const item of [...existing, ...incoming]) {
    if (!seen.has(item.conversation.id)) {
      seen.add(item.conversation.id);
      merged.push(item);
    }
  }

  return merged.sort((a, b) => {
    const timeA = a.conversation.lastInboundAt
      ? new Date(a.conversation.lastInboundAt).getTime()
      : 0;
    const timeB = b.conversation.lastInboundAt
      ? new Date(b.conversation.lastInboundAt).getTime()
      : 0;
    return timeB - timeA;
  });
}

/**
 * Merge messages without duplicates, keeping chronological order (oldest to newest).
 */
export function mergePaginatedMessages(
  existing: MessageItem[],
  incoming: MessageItem[]
): MessageItem[] {
  const seen = new Set<string>();
  const merged: MessageItem[] = [];

  for (const msg of [...existing, ...incoming]) {
    if (!seen.has(msg.id)) {
      seen.add(msg.id);
      merged.push(msg);
    }
  }

  return merged.sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );
}

/**
 * Extract next cursor timestamp from a list of items.
 */
export function extractNextCursor<T>(
  items: T[],
  limit: number,
  getTimestamp: (item: T) => string | null | undefined
): string | null {
  if (items.length < limit) {
    return null;
  }
  const last = items[items.length - 1];
  if (!last) return null;
  const ts = getTimestamp(last);
  return ts ? new Date(ts).toISOString() : null;
}
