import type { MessageItem } from "../../types";
import type { ConversationStateEvent } from "./ConversationStateMarker";

const HUMAN_STATE = "HUMAN";
const BOT_STATE = "BOT";

type SupportState = typeof HUMAN_STATE | typeof BOT_STATE;

function eventState(type: string): SupportState | null {
  if (type === "MANUAL_TAKEOVER") return HUMAN_STATE;
  if (type === "MANUAL_RELEASED" || type === "AI_RESUMED_AFTER_HUMAN") return BOT_STATE;
  return null;
}

export function conversationStateMarkersBeforeMessages(
  events: ConversationStateEvent[],
  messages: Pick<MessageItem, "id" | "timestamp">[]
): Map<string, ConversationStateEvent[]> {
  const markers = new Map<string, ConversationStateEvent[]>();
  const seenIds = new Set<string>();
  const chronologicalEvents = events
    .filter((event) => eventState(event.type))
    .sort((a, b) => {
      const timeDiff = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      return timeDiff || a.id.localeCompare(b.id);
    });

  let currentState: SupportState = BOT_STATE;
  for (const event of chronologicalEvents) {
    if (seenIds.has(event.id)) continue;
    seenIds.add(event.id);

    const nextState = eventState(event.type);
    if (!nextState || nextState === currentState) continue;
    currentState = nextState;

    const eventTime = new Date(event.createdAt).getTime();
    const followingMessage = messages.find((message) => new Date(message.timestamp).getTime() >= eventTime);
    if (!followingMessage) continue;

    const beforeMessage = markers.get(followingMessage.id) || [];
    beforeMessage.push(event);
    markers.set(followingMessage.id, beforeMessage);
  }

  return markers;
}
