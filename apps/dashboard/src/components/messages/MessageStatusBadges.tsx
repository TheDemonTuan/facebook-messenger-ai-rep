import React from "react";
import type {
  ReplyDecisionInfo,
  SkipReasonInfo,
  ContentStatus,
  NormalizationInfo,
} from "../../types";
import {
  AlertTriangle,
  UserCheck,
  Bot,
  ArrowRightCircle,
  HelpCircle,
  Loader2,
  FileWarning,
} from "lucide-react";
import { isManualSupportSkip } from "./ConversationStateMarker";

export interface MessageStatusBadgesProps {
  actor?: string;
  replyDecision?: ReplyDecisionInfo | null;
  skipReason?: SkipReasonInfo | null;
  contentStatus?: ContentStatus | string;
  normalization?: NormalizationInfo | null;
  isManual?: boolean;
  isWaiting?: boolean;
}

export const MessageStatusBadges: React.FC<MessageStatusBadgesProps> = ({
  actor,
  replyDecision,
  skipReason,
  contentStatus,
  normalization,
  isManual,
  isWaiting,
}) => {
  const isManualActor = actor === "MANUAL_OWNER" || isManual;

  // 1. Parse Error condition: UNSUPPORTED contentStatus OR unverified parseQuality OR parse warnings
  const isParseError =
    contentStatus === "UNSUPPORTED" ||
    normalization?.parseQuality === "UNVERIFIED" ||
    Boolean(normalization?.warnings && normalization.warnings.length > 0);

  // 2. Waiting condition: PENDING contentStatus OR isWaiting prop
  const showWaiting = contentStatus === "PENDING" || isWaiting;

  // 3. Decision info
  const hasSkipReason = skipReason && !skipReason.eligible && !isManualSupportSkip(skipReason.reasonCode);
  const hasReplyDecision = Boolean(replyDecision);

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", alignItems: "center", marginTop: "4px" }}>
      {/* 1. MANUAL BADGE */}
      {isManualActor && (
        <span
          title="Tin nhắn được gửi bởi nhân viên hỗ trợ trực tiếp (thao tác thủ công)"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "4px",
            padding: "2px 8px",
            borderRadius: "4px",
            backgroundColor: "#e0f2fe",
            border: "1px solid #bae6fd",
            color: "#0369a1",
            fontSize: "0.72rem",
            fontWeight: "600",
          }}
        >
          <UserCheck size={12} />
          <span>Thủ công (Nhân viên)</span>
        </span>
      )}

      {/* 2. WAITING BADGE */}
      {showWaiting && (
        <span
          title="Đang chờ tiếp nhận dữ liệu media hoặc xử lý từ mạng"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "4px",
            padding: "2px 8px",
            borderRadius: "4px",
            backgroundColor: "#fef3c7",
            border: "1px solid #fde68a",
            color: "#92400e",
            fontSize: "0.72rem",
            fontWeight: "600",
          }}
        >
          <Loader2 size={12} className="animate-spin" />
          <span>Đang chờ media / xử lý</span>
        </span>
      )}

      {/* 3. PARSE ERROR BADGE */}
      {isParseError && (
        <span
          title={
            normalization?.warnings && normalization.warnings.length > 0
              ? `Cảnh báo phân tích cú pháp: ${normalization.warnings.join(", ")}`
              : "Lỗi phân tích cú pháp hoặc định dạng nội dung chưa hỗ trợ (Parse Error)"
          }
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "4px",
            padding: "2px 8px",
            borderRadius: "4px",
            backgroundColor: "#fff1f2",
            border: "1px solid #fecdd3",
            color: "#be123c",
            fontSize: "0.72rem",
            fontWeight: "600",
          }}
        >
          <FileWarning size={12} />
          <span>Lỗi phân tích cú pháp</span>
        </span>
      )}

      {/* 4. DECISION BADGE */}
      {hasReplyDecision && replyDecision ? (
        <span
          title={`Quyết định: ${replyDecision.displayLabel} (Mã: ${replyDecision.reasonCode})`}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "4px",
            padding: "2px 8px",
            borderRadius: "4px",
            backgroundColor:
              replyDecision.action === "GENERATE"
                ? "#f0fdf4"
                : replyDecision.action === "DEFER"
                ? "#fefce8"
                : replyDecision.action === "CLARIFY"
                ? "#eff6ff"
                : replyDecision.action === "HANDOFF"
                ? "#faf5ff"
                : "#fef2f2",
            border: `1px solid ${
              replyDecision.action === "GENERATE"
                ? "#bbf7d0"
                : replyDecision.action === "DEFER"
                ? "#fef08a"
                : replyDecision.action === "CLARIFY"
                ? "#bfdbfe"
                : replyDecision.action === "HANDOFF"
                ? "#e9d5ff"
                : "#fecaca"
            }`,
            color:
              replyDecision.action === "GENERATE"
                ? "#15803d"
                : replyDecision.action === "DEFER"
                ? "#854d0e"
                : replyDecision.action === "CLARIFY"
                ? "#1d4ed8"
                : replyDecision.action === "HANDOFF"
                ? "#7e22ce"
                : "#b91c1c",
            fontSize: "0.72rem",
            fontWeight: "600",
          }}
        >
          {replyDecision.action === "GENERATE" ? (
            <Bot size={12} />
          ) : replyDecision.action === "HANDOFF" ? (
            <ArrowRightCircle size={12} />
          ) : replyDecision.action === "CLARIFY" ? (
            <HelpCircle size={12} />
          ) : (
            <AlertTriangle size={12} />
          )}
          <span>Quyết định: {replyDecision.displayLabel || replyDecision.action}</span>
        </span>
      ) : hasSkipReason && skipReason ? (
        <span
          title={`Tự động bỏ qua: ${skipReason.humanReadableReason} (Bước: ${skipReason.precedenceStep} - Mã: ${skipReason.reasonCode})`}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "4px",
            padding: "2px 8px",
            borderRadius: "4px",
            backgroundColor: "#fef2f2",
            border: "1px solid #fecaca",
            color: "#b91c1c",
            fontSize: "0.72rem",
            fontWeight: "600",
          }}
        >
          <AlertTriangle size={12} color="#dc2626" />
          <span>Quyết định: Bỏ qua ({skipReason.humanReadableReason})</span>
        </span>
      ) : null}
    </div>
  );
};
