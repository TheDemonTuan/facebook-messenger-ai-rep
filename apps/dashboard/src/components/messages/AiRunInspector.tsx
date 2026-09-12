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
          Chọn một tin nhắn hoặc một lượt chạy AI để xem chi tiết thực thi (Execution), tuyển chọn (Disposition) và phân phát (Delivery).
        </p>
      </div>
    );
  }

  const promptHash = run.promptHash || "—";
  const responseHash = run.responseHash || "—";
  const latencyMs = run.latencyMs ?? null;
  const isSuccess = run.status === "SUCCESS";
  const rawContent = run.responseSnapshot?.content || "";
  const candidateMessages = run.parsedOutput?.messages || [];
  const selectedMessages = run.usedResult?.messages || [];

  // Only direct provenance is safe: a conversation can have multiple AI runs for one inbound version.
  const matchingActions = actions.filter((action) => action.sourceAiRunId === run.id);
  const confirmedActions = matchingActions.filter((action) => action.status === "CONFIRMED" || action.status === "SENT");
  const uncertainActions = matchingActions.filter((action) => action.status === "SEND_UNCERTAIN" || action.status === "UNCONFIRMED");

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
          <span style={{ fontWeight: 600, color: "#0f172a" }}>Chi tiết AI Run (v{run.inboundVersion ?? "—"})</span>
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
        {/* Semantic 1: Run Execution Metadata */}
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
            <div style={{ fontSize: "11px", color: "#64748b" }}>1. Thực thi (Model)</div>
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

        {/* Semantic 2: Disposition & Selected Result */}
        <div>
          <div style={{ fontSize: "12px", fontWeight: 600, color: "#475569", marginBottom: "6px", display: "flex", alignItems: "center", gap: "6px" }}>
            <Sparkles size={14} color="#8b5cf6" /> 2. Tuyển chọn nội dung (Disposition & Selected Result)
          </div>
          <div
            style={{
              backgroundColor: "#f8fafc",
              padding: "12px",
              borderRadius: "6px",
              border: "1px solid #e2e8f0",
              display: "flex",
              flexDirection: "column",
              gap: "8px",
            }}
          >
            <div>
              <div style={{ fontSize: "11px", fontWeight: 600, color: "#64748b", marginBottom: "4px" }}>
                Kết quả thực tế được chọn gửi (usedResult):
              </div>
              <div
                style={{
                  backgroundColor: selectedMessages.length > 0 ? "#f0fdf4" : "#f1f5f9",
                  border: `1px solid ${selectedMessages.length > 0 ? "#bbf7d0" : "#cbd5e1"}`,
                  borderRadius: "6px",
                  padding: "10px",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  color: selectedMessages.length > 0 ? "#14532d" : "#64748b",
                  fontSize: "13px",
                  lineHeight: 1.5,
                }}
              >
                {selectedMessages.length > 0 ? (
                  selectedMessages.join("\n\n")
                ) : (
                  <span style={{ fontStyle: "italic" }}>
                    {isSuccess ? "Không có tin nhắn nào được chọn làm phản hồi cuối cùng (dropped hoặc superseded)" : "Chưa có kết quả do thực thi thất bại"}
                  </span>
                )}
              </div>
            </div>

            {candidateMessages.length > 0 && candidateMessages.join("\n") !== selectedMessages.join("\n") && (
              <div>
                <div style={{ fontSize: "11px", fontWeight: 600, color: "#64748b", marginBottom: "4px" }}>
                  Tin nhắn ứng viên ban đầu (parsedOutput):
                </div>
                <div
                  style={{
                    backgroundColor: "#ffffff",
                    border: "1px dashed #cbd5e1",
                    borderRadius: "6px",
                    padding: "8px 10px",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    color: "#475569",
                    fontSize: "12px",
                    lineHeight: 1.4,
                  }}
                >
                  {candidateMessages.join("\n\n")}
                </div>
              </div>
            )}

            {!candidateMessages.length && !selectedMessages.length && rawContent && (
              <div>
                <div style={{ fontSize: "11px", fontWeight: 600, color: "#64748b", marginBottom: "4px" }}>
                  Nội dung thô phản hồi từ LLM (rawContent):
                </div>
                <div
                  style={{
                    backgroundColor: "#ffffff",
                    border: "1px dashed #cbd5e1",
                    borderRadius: "6px",
                    padding: "8px 10px",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    color: "#475569",
                    fontSize: "12px",
                    lineHeight: 1.4,
                  }}
                >
                  {rawContent}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Semantic 3: Messenger Delivery Trace */}
        <div>
          <div style={{ fontSize: "12px", fontWeight: 600, color: "#475569", marginBottom: "6px", display: "flex", alignItems: "center", gap: "6px" }}>
            <Send size={14} color="#3b82f6" /> 3. Phân phát tin nhắn Messenger (Delivery Trace)
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
            ) : matchingActions.length > 0 ? (
              <>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "#64748b" }}>Delivery:</span>
                  <span style={{ fontWeight: 600, color: uncertainActions.length > 0 ? "#dc2626" : confirmedActions.length === matchingActions.length ? "#16a34a" : "#ca8a04" }}>
                    {confirmedActions.length}/{matchingActions.length} xác nhận{uncertainActions.length > 0 ? `, ${uncertainActions.length} cần đối soát` : ""}
                  </span>
                </div>
                {matchingActions.map((action) => <div key={action.id} style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "#64748b" }}>Tin {action.responseIndex + 1}:</span>
                  <span>{action.status}{action.confirmedAt ? ` · ${formatTime(action.confirmedAt)}` : ""}</span>
                </div>)}
              </>
            ) : (
              <div style={{ color: "#64748b" }}>
                Chưa có hành động gửi nào được liên kết trực tiếp với lượt chạy AI này.
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
