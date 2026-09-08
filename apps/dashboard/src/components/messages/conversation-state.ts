import type { MessageItem } from "../../types";
import type { ConversationStateEvent } from "./ConversationStateMarker";

const STATE_EVENT_TYPES = new Set(["MANUAL_TAKEOVER", "MANUAL_RELEASED", "AI_RESUMED_AFTER_HUMAN"]);

export function conversationStateMarkersBeforeMessages(
  events: ConversationStateEvent[],
  messages: Pick<MessageItem, "id" | "timestamp">[]
): Map<string, ConversationStateEvent[]> {
  const markers = new Map<string, ConversationStateEvent[]>();
  const chronologicalEvents = events
    .filter((event) => STATE_EVENT_TYPES.has(event.type))
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  for (const event of chronologicalEvents) {
    const eventTime = new Date(event.createdAt).getTime();
    const followingMessage = messages.find((message) => new Date(message.timestamp).getTime() >= eventTime);
    if (!followingMessage) continue;
    const beforeMessage = markers.get(followingMessage.id) || [];
    beforeMessage.push(event);
    markers.set(followingMessage.id, beforeMessage);
  }

  return markers;
}
