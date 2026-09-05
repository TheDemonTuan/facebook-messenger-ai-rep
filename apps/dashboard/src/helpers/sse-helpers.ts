/**
 * Determines whether an incoming SSE event should trigger a refetch of the Inbox list.
 */
export function shouldRefetchInbox(eventType: string): boolean {
  return [
    "inbound:received",
    "conversation:status",
    "conversation:takeover",
    "conversation:manual-send",
    "conversation:block",
    "outbox:inbound_received",
    "outbox:manual_send",
  ].includes(eventType);
}

/**
 * Determines whether an incoming SSE event matches a specific conversation ID.
 */
export function shouldRefetchConversationDetail(
  eventType: string,
  targetConversationId: string,
  eventPayload?: { conversationId?: string; id?: string }
): boolean {
  if (!targetConversationId) return false;

  const eventConvId = eventPayload?.conversationId || eventPayload?.id;
  if (eventConvId && eventConvId !== targetConversationId) {
    return false;
  }

  return [
    "inbound:received",
    "conversation:status",
    "conversation:takeover",
    "conversation:manual-send",
    "conversation:block",
    "outbound:transition",
    "outbound:confirmed",
    "outbound:uncertain",
    "outbound:aborted",
    "action:reconciled",
    "outbox:inbound_received",
    "outbox:manual_send",
    "outbox:ai_generated",
    "outbox:browser_confirmed",
  ].includes(eventType);
}

/**
 * Determines whether an incoming SSE event should trigger a refetch of the Queue page.
 */
export function shouldRefetchQueue(eventType: string): boolean {
  return [
    "queue:updated",
    "conversation:status",
    "channel:status",
    "outbox:debounce",
    "outbox:ai_generated",
    "outbox:reconcile",
  ].includes(eventType);
}

/**
 * Determines whether an incoming SSE event should trigger a refetch of Incidents.
 */
export function shouldRefetchIncidents(eventType: string): boolean {
  return [
    "incident:resolved",
    "outbound:uncertain",
    "channel:status",
  ].includes(eventType);
}

/**
 * Determines whether an incoming SSE event affects system overview.
 */
export function shouldRefetchOverview(eventType: string): boolean {
  return [
    "channel:status",
    "queue:updated",
    "incident:resolved",
    "conversation:status",
    "conversation:takeover",
    "conversation:manual-send",
  ].includes(eventType);
}
