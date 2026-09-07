import React from "react";
import type { MessageTimeDetail } from "../../types";
import { formatTime } from "../../helpers/date-helpers";
import { Clock, Radio, Server, HelpCircle } from "lucide-react";

export interface MessageTimeBadgeProps {
  time?: MessageTimeDetail | null;
  timestamp?: string | Date;
  eventTimestamp?: string | Date | null;
  observedTimestamp?: string | Date | null;
  timestampProvenance?: string;
  timestampPrecision?: string;
}

export const MessageTimeBadge: React.FC<MessageTimeBadgeProps> = ({
  time,
  timestamp,
  eventTimestamp,
  observedTimestamp,
  timestampProvenance,
  timestampPrecision,
}) => {
  // Resolve source provenance
  const source = time?.source || timestampProvenance || (eventTimestamp ? "FACEBOOK_EVENT" : "OBSERVED");
  const precision = time?.precision || timestampPrecision || "UNKNOWN";

  // Resolve target date:
  // If FACEBOOK_EVENT, prefer eventAt / eventTimestamp; otherwise observedAt / observedTimestamp / displayAt / timestamp
  const dateStr =
    source === "FACEBOOK_EVENT"
      ? (time?.eventAt || eventTimestamp || time?.displayAt || timestamp)
      : (time?.observedAt || observedTimestamp || time?.displayAt || timestamp);

  const formatted = formatTime(dateStr);

  let label = formatted;
  let tooltip = "";
  let icon = <Clock size={11} />;

  if (source === "FACEBOOK_EVENT") {
    icon = <Radio size={11} color="#2563eb" />;
    if (precision === "MINUTE") {
      label = `${formatted} (phút)`;
      tooltip = `Giờ gửi từ Facebook: ${formatted} (độ chính xác: phút)`;
    } else if (precision === "APPROXIMATE") {
      label = `~${formatted}`;
      tooltip = `Giờ gửi từ Facebook (xấp xỉ): ${formatted}`;
    } else {
      label = formatted;
      tooltip = `Giờ gửi từ Facebook: ${formatted} (độ chính xác: ${precision.toLowerCase()})`;
    }
  } else if (source === "OBSERVED") {
    // Crucial: do NOT fake send time. Clearly label as observed time
    icon = <Clock size={11} color="#64748b" />;
    label = `Ghi nhận: ${formatted}`;
    tooltip = `Thời điểm hệ thống quan sát/ghi nhận (OBSERVED), không phải giờ gửi từ Facebook. Độ chính xác: ${precision}`;
  } else if (source === "SYSTEM") {
    icon = <Server size={11} color="#64748b" />;
    label = `Hệ thống: ${formatted}`;
    tooltip = `Thời điểm hệ thống tạo tin (SYSTEM)`;
  } else {
    icon = <HelpCircle size={11} color="#94a3b8" />;
    label = formatted;
    tooltip = `Thời gian (nguồn: chưa xác định)`;
  }

  return (
    <span
      title={tooltip}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
        fontSize: "0.72rem",
        color: "#64748b",
      }}
    >
      {icon}
      <span>{label}</span>
    </span>
  );
};
