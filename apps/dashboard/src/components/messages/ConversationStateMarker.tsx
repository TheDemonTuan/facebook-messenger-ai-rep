import React from "react";
import { Bot, UserCheck } from "lucide-react";
import { formatTime } from "../../helpers/date-helpers";

export interface ConversationStateEvent {
  id: string;
  type: string;
  actor?: string | null;
  createdAt: string;
}

function displayActor(actor?: string | null): string | null {
  if (!actor || actor === "SYSTEM" || actor === "HUMAN_MESSENGER") return null;
  return actor;
}

function markerDetails(event: ConversationStateEvent): {
  label: string;
  icon: "BOT" | "HUMAN";
  tone: "bot" | "human";
} | null {
  switch (event.type) {
    case "MANUAL_TAKEOVER":
      return {
        label: displayActor(event.actor)
          ? `${displayActor(event.actor)} bắt đầu hỗ trợ — bot tạm dừng`
          : "Nhân viên bắt đầu hỗ trợ — bot tạm dừng",
        icon: "HUMAN",
        tone: "human",
      };
    case "MANUAL_RELEASED":
      return {
        label: displayActor(event.actor)
          ? `${displayActor(event.actor)} chuyển lại cho bot hỗ trợ`
          : "Nhân viên chuyển lại cho bot hỗ trợ",
        icon: "BOT",
        tone: "bot",
      };
    case "AI_RESUMED_AFTER_HUMAN":
      return {
        label: "Bot tiếp tục hỗ trợ vì đã hết thời gian chờ nhân viên",
        icon: "BOT",
        tone: "bot",
      };
    default:
      return null;
  }
}

export const isManualSupportSkip = (reasonCode?: string | null): boolean =>
  reasonCode === "CONVERSATION_MANUAL_MODE" ||
  reasonCode === "HUMAN_SESSION_ACTIVE" ||
  reasonCode === "HUMAN_PINNED_ACTIVE";

export const ConversationStateMarker: React.FC<{ event: ConversationStateEvent }> = ({ event }) => {
  const details = markerDetails(event);
  if (!details) return null;

  const isBot = details.tone === "bot";
  const color = isBot ? "#0f766e" : "#0369a1";
  const background = isBot ? "#f0fdfa" : "#f0f9ff";
  const border = isBot ? "#99f6e4" : "#bae6fd";
  const Icon = details.icon === "BOT" ? Bot : UserCheck;

  return (
    <div
      aria-label={`${formatTime(event.createdAt)}. ${details.label}`}
      style={{ display: "flex", alignItems: "center", gap: "8px", color, fontSize: "0.76rem", padding: "2px 0" }}
    >
      <div style={{ height: "1px", backgroundColor: border, flex: 1 }} />
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "5px",
          padding: "4px 9px",
          borderRadius: "999px",
          backgroundColor: background,
          border: `1px solid ${border}`,
          fontWeight: 600,
          textAlign: "center",
        }}
      >
        <Icon size={13} />
        <span>{formatTime(event.createdAt)} · {details.label}</span>
      </span>
      <div style={{ height: "1px", backgroundColor: border, flex: 1 }} />
    </div>
  );
};
