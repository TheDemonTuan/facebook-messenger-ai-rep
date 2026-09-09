import React from "react";
import type { AiRunItem, OutboundActionItem, MessageItem } from "../../types";
import { formatTime } from "../../helpers/date-helpers";
import { Sparkles, XCircle, Cpu, Send, Layers } from "lucide-react";

interface AiRunInspectorProps {
  run?: AiRunItem | null;
  actions?: OutboundActionItem[];
  messages?: MessageItem[];
  turnId?: string | null;
  onClose?: () => void;
  compact?: boolean;
}

export const AiRunInspector: React.FC<AiRunInspectorProps> = ({
  run,
  actions = [],
  messages: _messages = [],
  turnId: _turnId,
  onClose,
  compact = false,
}) => {
  if (!run) {
    return (
      <div style={{ padding: "20px", textAlign: "center", color: "#64748b", fontSize: "14px" }}>
        <Cpu size={32} style={{ margin: "0 auto 10px", color: "#94a3b8", display: "block" }} />
        <p style={{ margin: 0, fontWeight: 500 }}>Chưa có lượt chạy AI nào được chọn</p>
        <p style={{ margin: "4px 0 0", fontSize: "12px", color: "#94a3b8" }}>
          Chọn một tin nhắn hoặc một lượt chạy AI để xem chi tiết prompt, suy luận và phản hồi.
        </p>
      </div>
    );
  }

  const promptHash = run.promptHash || "—";
  const responseHash = run.responseHash || "—";
  const latencyMs = run.latencyMs ?? null;
  const isSuccess = run.status === "SUCCESS";
  const rawContent = run.responseSnapshot?.content || "";
  const outputMessages = run.parsedOutput?.messages || run.usedResult?.messages || [];

  // Match outbound action by inboundVersion and actor
  const matchingAction = actions.length > 0
    ? actions.find((a) => a.actor === "AI" && a.inboundVersion === run.inboundVersion)
    : null;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        backgroundColor: "#ffffff",
        borderLeft: compact ? "1px solid #e2e8f0" : "none",
        fontSize: "13px",
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "14px 16px",
          borderBottom: "1px solid #e2e8f0",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          backgroundColor: "#f8fafc",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <Sparkles size={16} style={{ color: "#3b82f6" }} />
          <span style={{ fontWeight: 600, color: "#0f172a" }}>Chi tiết AI Run</span>
          <span
            style={{
              fontSize: "11px",
              padding: "2px 6px",
              borderRadius: "4px",
              fontWeight: 600,
              backgroundColor: isSuccess ? "#dcfce7" : "#fee2e2",
              color: isSuccess ? "#15803d" : "#b91c1c",
            }}
          >
            {run.status}
          </span>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            style={{
              border: "none",
              background: "none",
              color: "#64748b",
              cursor: "pointer",
              fontSize: "16px",
              padding: "2px 6px",
            }}
            title="Đóng"
          >
            ✕
          </button>
        )}
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflowY: "auto", padding: "16px", display: "flex", flexDirection: "column", gap: "16px" }}>
        {/* Run Metadata Card */}
        <div
          style={{
            backgroundColor: "#f8fafc",
            borderRadius: "8px",
            padding: "12px",
            border: "1px solid #e2e8f0",
            display: "grid",
            gridTemplateColumns: "repeat(2, 1fr)",
            gap: "8px 12px",
          }}
        >
          <div>
            <div style={{ fontSize: "11px", color: "#64748b" }}>Model</div>
            <div style={{ fontWeight: 500, color: "#1e293b" }}>{run.model || "—"}</div>
          </div>
          <div>
            <div style={{ fontSize: "11px", color: "#64748b" }}>Độ trễ (Latency)</div>
            <div style={{ fontWeight: 500, color: "#1e293b" }}>
              {latencyMs ? `${latencyMs} ms` : "—"}
            </div>
          </div>
          <div>
            <div style={{ fontSize: "11px", color: "#64748b" }}>Thời điểm tạo</div>
            <div style={{ fontWeight: 500, color: "#1e293b" }}>
              {formatTime(run.createdAt)}
            </div>
          </div>
          <div>
            <div style={{ fontSize: "11px", color: "#64748b" }}>Lượt (Inbound v)</div>
            <div style={{ fontWeight: 500, color: "#1e293b" }}>
              v{run.inboundVersion ?? "—"}
            </div>
          </div>
          <div>
            <div style={{ fontSize: "11px", color: "#64748b" }}>Tokens (Prompt / Compl)</div>
            <div style={{ fontWeight: 500, color: "#1e293b" }}>
              {run.promptTokens ?? 0} / {run.completionTokens ?? 0} ({run.totalTokens ?? 0} tổng)
            </div>
          </div>
          <div>
            <div style={{ fontSize: "11px", color: "#64748b" }}>Định dạng API</div>
            <div style={{ fontWeight: 500, color: "#1e293b" }}>
              {run.requestSnapshot?.apiFormat || "OPENAI_COMPATIBLE"}
            </div>
          </div>
        </div>

        {run.errorMessage && (
          <div
            style={{
              padding: "10px 12px",
              borderRadius: "6px",
              backgroundColor: "#fee2e2",
              border: "1px solid #fecaca",
              color: "#991b1b",
              fontSize: "12px",
              display: "flex",
              gap: "8px",
              alignItems: "flex-start",
            }}
          >
            <XCircle size={15} style={{ flexShrink: 0, marginTop: "2px" }} />
            <div>
              <strong>Lỗi thực thi:</strong> {run.errorMessage}
            </div>
          </div>
        )}

        {/* Draft Response Text */}
        <div>
          <div style={{ fontSize: "12px", fontWeight: 600, color: "#475569", marginBottom: "6px" }}>
            Câu trả lời được sinh (Parsed Output)
          </div>
          <div
            style={{
              backgroundColor: "#f1f5f9",
              padding: "12px",
              borderRadius: "6px",
              border: "1px solid #cbd5e1",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              color: "#0f172a",
              fontSize: "13px",
              lineHeight: 1.5,
              minHeight: "48px",
            }}
          >
            {outputMessages.length > 0 ? (
              outputMessages.join("\n\n")
            ) : rawContent ? (
              rawContent
            ) : (
              <span style={{ color: "#94a3b8", fontStyle: "italic" }}>Không có nội dung text</span>
            )}
          </div>
        </div>

        {/* Provenance and Delivery Trace */}
        <div>
          <div style={{ fontSize: "12px", fontWeight: 600, color: "#475569", marginBottom: "6px", display: "flex", alignItems: "center", gap: "6px" }}>
            <Send size={14} color="#3b82f6" /> Truy vết gửi tin (Delivery Trace)
          </div>
          <div
            style={{
              border: "1px solid #e2e8f0",
              borderRadius: "6px",
              padding: "10px 12px",
              backgroundColor: "#fafafa",
              fontSize: "12px",
              display: "flex",
              flexDirection: "column",
              gap: "6px",
            }}
          >
            {actions.length === 0 ? (
              <div style={{ color: "#64748b", fontStyle: "italic" }}>
                Chưa tải danh sách actions gắn kèm (Mở qua chi tiết Hội thoại để xem liên kết đối soát gửi).
              </div>
            ) : matchingAction ? (
              <>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "#64748b" }}>Trạng thái gửi Messenger:</span>
                  <span
                    style={{
                      fontWeight: 600,
                      color:
                        matchingAction.status === "SENT"
                          ? "#16a34a"
                          : matchingAction.status === "SEND_UNCERTAIN"
                          ? "#dc2626"
                          : "#ca8a04",
                    }}
                  >
                    {matchingAction.status === "SENT"
                      ? "Đã gửi thành công (SENT)"
                      : matchingAction.status === "SEND_UNCERTAIN"
                      ? "Cần đối soát (SEND_UNCERTAIN)"
                      : matchingAction.status}
                  </span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "#64748b" }}>Thời điểm gửi:</span>
                  <span>{formatTime(matchingAction.createdAt)}</span>
                </div>
              </>
            ) : (
              <div style={{ color: "#64748b" }}>
                Không tìm thấy hành động gửi trực tiếp nào gắn với phiên bản inbound v{run.inboundVersion}. (Có thể đã bị hủy hoặc đang chờ gửi).
              </div>
            )}
          </div>
        </div>

        {/* Security & Technical Hashes */}
        <div>
          <div style={{ fontSize: "12px", fontWeight: 600, color: "#475569", marginBottom: "6px", display: "flex", alignItems: "center", gap: "6px" }}>
            <Layers size={14} color="#64748b" /> Thông tin kỹ thuật & Mã băm an toàn
          </div>
          <div
            style={{
              border: "1px solid #e2e8f0",
              borderRadius: "6px",
              padding: "10px 12px",
              backgroundColor: "#fafafa",
              fontSize: "11px",
              display: "flex",
              flexDirection: "column",
              gap: "6px",
              fontFamily: "ui-monospace, monospace",
            }}
          >
            <div>
              <span style={{ color: "#64748b" }}>Run ID: </span>
              <span style={{ color: "#1e293b" }}>{run.id}</span>
            </div>
            <div>
              <span style={{ color: "#64748b" }}>Prompt Hash: </span>
              <span style={{ color: "#1e293b" }}>{promptHash}</span>
            </div>
            <div>
              <span style={{ color: "#64748b" }}>Response Hash: </span>
              <span style={{ color: "#1e293b" }}>{responseHash}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
