import type { ConversationItem, MessageItem } from "../types";

export interface CursorQueryParams {
  filter?: string;
  limit?: number;
  cursor?: string | null;
  offset?: number;
  scope?: string;
}

/**
 * Builds standard query string with cursor or limit/offset support.
 */
export function buildInboxQuery(params: CursorQueryParams): string {
  const q = new URLSearchParams();
  if (params.filter && params.filter !== "all") {
    q.append("filter", params.filter);
  }
  if (params.scope) {
    q.append("scope", params.scope);
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
 * Ties on equal timestamp are deterministically broken using message ID.
 * Incoming messages with higher or equal contentRevision update existing messages.
 */
export function mergePaginatedMessages(
  existing: MessageItem[],
  incoming: MessageItem[]
): MessageItem[] {
  const byId = new Map<string, MessageItem>();

  for (const msg of existing) {
    byId.set(msg.id, msg);
  }

  for (const msg of incoming) {
    const prev = byId.get(msg.id);
    if (!prev) {
      byId.set(msg.id, msg);
    } else {
      const prevRev = prev.contentRevision ?? 1;
      const nextRev = msg.contentRevision ?? 1;
      if (nextRev >= prevRev) {
        byId.set(msg.id, {
          ...prev,
          ...msg,
        });
      }
    }
  }

  return Array.from(byId.values()).sort((a, b) => {
    const timeA = new Date(a.timestamp || (a.time?.displayAt ?? 0)).getTime();
    const timeB = new Date(b.timestamp || (b.time?.displayAt ?? 0)).getTime();
    if (timeA !== timeB) {
      return timeA - timeB;
    }
    return a.id.localeCompare(b.id);
  });
}

/**
 * Extract next cursor timestamp or composite cursor from a list of items.
 */
export function extractNextCursor<T>(
  items: T[],
  limit: number,
  getTimestamp: (item: T) => string | null | undefined,
  getId?: (item: T) => string | null | undefined
): string | null {
  if (items.length < limit) {
    return null;
  }
  const last = items[items.length - 1];
  if (!last) return null;
  const ts = getTimestamp(last);
  if (!ts) return null;
  const iso = new Date(ts).toISOString();
  if (getId) {
    const id = getId(last);
    if (id) {
      return `${iso}__${id}`;
    }
  }
  return iso;
}
