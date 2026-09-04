import React, { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { apiFetch } from "../api";
import type { MessageItem, OutboundActionItem } from "../types";
import { ArrowLeft, UserCheck, ShieldAlert, Send, RefreshCw, CheckCircle2, Cpu } from "lucide-react";

export const ConversationDetailPage: React.FC = () => {
  const { conversationId } = useParams<{ conversationId: string }>();
  const [data, setData] = useState<any>(null);
  const [manualText, setManualText] = useState("");
  const [sending, setSending] = useState(false);

  const loadDetails = async () => {
    if (!conversationId) return;
    try {
      const res = await apiFetch<any>(`/api/inbox/${conversationId}`);
      setData(res);
    } catch {
      // Handled
    }
  };

  useEffect(() => {
    loadDetails();
    const timer = setInterval(loadDetails, 4000);
    return () => clearInterval(timer);
  }, [conversationId]);

  if (!data) return <div>Đang tải chi tiết cuộc hội thoại...</div>;

  const conv = data.conversation;
  const customer = data.customer;
  const messages: MessageItem[] = data.messages || [];
  const actions: OutboundActionItem[] = data.outboundActions || [];

  const handleTakeoverToggle = async () => {
    try {
      if (conv.manualMode) {
        if (confirm("Chuyển cuộc hội thoại này về chế độ TỰ ĐỘNG (Auto)?")) {
          await apiFetch(`/api/inbox/${conversationId}/release`, { method: "POST" });
        }
      } else {
        if (confirm("Tiếp quản cuộc hội thoại này (Manual Takeover)? AI sẽ ngừng gửi phản hồi tự động.")) {
          await apiFetch(`/api/inbox/${conversationId}/takeover`, { method: "POST" });
        }
      }
      await loadDetails();
    } catch (err: unknown) {
      alert((err as Error).message);
    }
  };

  const handleBlockToggle = async () => {
    try {
      const nextBlocked = !conv.isBlocked;
      if (confirm(nextBlocked ? "Chặn (Block) cuộc hội thoại này?" : "Bỏ chặn cuộc hội thoại này?")) {
        await apiFetch(`/api/inbox/${conversationId}/block`, {
          method: "POST",
          body: JSON.stringify({ isBlocked: nextBlocked }),
        });
        await loadDetails();
      }
    } catch (err: unknown) {
      alert((err as Error).message);
    }
  };

  const handleManualSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualText.trim()) return;
    setSending(true);
    try {
      await apiFetch(`/api/inbox/${conversationId}/manual-send`, {
        method: "POST",
        body: JSON.stringify({ text: manualText }),
      });
      setManualText("");
      await loadDetails();
    } catch (err: unknown) {
      alert((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  const handleReconcile = async (actionId: string, resolution: "MARK_SENT" | "RETRY") => {
    if (confirm(`Xác nhận xử lý tin nhắn chưa xác nhận: ${resolution === "MARK_SENT" ? "Đánh dấu đã gửi" : "Thử gửi lại"}?`)) {
      try {
        await apiFetch(`/api/inbox/${conversationId}/reconcile-action`, {
          method: "POST",
          body: JSON.stringify({ actionId, resolution }),
        });
        await loadDetails();
      } catch (err: unknown) {
        alert((err as Error).message);
      }
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", gap: "16px" }}>
      {/* Header bar */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", backgroundColor: "#ffffff", padding: "16px 20px", borderRadius: "8px", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <Link to="/inbox" style={{ color: "#64748b", textDecoration: "none", display: "flex", alignItems: "center" }}>
            <ArrowLeft size={20} />
          </Link>
          <div>
            <div style={{ fontWeight: "bold", fontSize: "1.1rem" }}>{customer.name || "Khách hàng"}</div>
            <div style={{ fontSize: "0.8rem", color: "#64748b" }}>
              Thread ID: {conv.externalThreadId} | Inbound Version: {conv.inboundVersion} | Status: <span style={{ fontWeight: "600", color: "#2563eb" }}>{conv.status}</span>
            </div>
          </div>
        </div>

        <div style={{ display: "flex", gap: "8px" }}>
          <Link
            to={`/ai-logs?conversationId=${conversationId}`}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "6px",
              padding: "6px 12px",
              borderRadius: "6px",
              border: "1px solid #bfdbfe",
              backgroundColor: "#eff6ff",
              color: "#1e40af",
              textDecoration: "none",
              cursor: "pointer",
              fontSize: "0.85rem",
              fontWeight: "600",
            }}
          >
            <Cpu size={16} />
            AI Proxy Logs
          </Link>

          <button
            onClick={handleTakeoverToggle}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "6px",
              padding: "6px 12px",
              borderRadius: "6px",
              border: "none",
              backgroundColor: conv.manualMode ? "#10b981" : "#f59e0b",
              color: "#ffffff",
              fontWeight: "600",
              cursor: "pointer",
              fontSize: "0.85rem",
            }}
          >
            <UserCheck size={16} />
            {conv.manualMode ? "Trả về Auto" : "Tiếp quản (Manual)"}
          </button>

          <button
            onClick={handleBlockToggle}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "6px",
              padding: "6px 12px",
              borderRadius: "6px",
              border: "1px solid #cbd5e1",
              backgroundColor: conv.isBlocked ? "#fee2e2" : "#ffffff",
              color: conv.isBlocked ? "#991b1b" : "#475569",
              cursor: "pointer",
              fontSize: "0.85rem",
            }}
          >
            <ShieldAlert size={16} />
            {conv.isBlocked ? "Bỏ chặn" : "Chặn"}
          </button>
        </div>
      </div>

      {/* Unconfirmed Actions Banner */}
      {actions.filter((a) => a.status === "UNCONFIRMED").map((action) => (
        <div
          key={action.id}
          style={{
            backgroundColor: "#fee2e2",
            border: "1px solid #f87171",
            borderRadius: "8px",
            padding: "16px",
            color: "#991b1b",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div>
            <div style={{ fontWeight: "bold" }}>⚠️ Tin nhắn chưa được xác nhận (UNCONFIRMED)</div>
            <div style={{ fontSize: "0.85rem", marginTop: "4px" }}>
              Nội dung: "{action.text}"
            </div>
            <div style={{ fontSize: "0.75rem", color: "#b91c1c" }}>
              Lý do: {action.unconfirmedReason || "Không tìm thấy bubble gửi ra sau timeout"}
            </div>
          </div>
          <div style={{ display: "flex", gap: "8px" }}>
            <button
              onClick={() => handleReconcile(action.actionId, "MARK_SENT")}
              style={{
                backgroundColor: "#16a34a",
                color: "#ffffff",
                border: "none",
                padding: "6px 12px",
                borderRadius: "4px",
                cursor: "pointer",
                fontWeight: "600",
                display: "flex",
                alignItems: "center",
                gap: "4px",
              }}
            >
              <CheckCircle2 size={16} /> Đã kiểm tra (Mark Sent)
            </button>
            <button
              onClick={() => handleReconcile(action.actionId, "RETRY")}
              style={{
                backgroundColor: "#dc2626",
                color: "#ffffff",
                border: "none",
                padding: "6px 12px",
                borderRadius: "4px",
                cursor: "pointer",
                fontWeight: "600",
                display: "flex",
                alignItems: "center",
                gap: "4px",
              }}
            >
              <RefreshCw size={16} /> Thử gửi lại
            </button>
          </div>
        </div>
      ))}

      {/* Chat Messages Timeline */}
      <div style={{ flex: 1, backgroundColor: "#ffffff", borderRadius: "8px", padding: "20px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "12px", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
        {messages.length === 0 ? (
          <div style={{ color: "#94a3b8", textAlign: "center", margin: "auto" }}>Chưa có tin nhắn trong cuộc hội thoại này.</div>
        ) : (
          messages.map((m) => {
            const isOut = m.direction === "OUTBOUND";
            return (
              <div
                key={m.id}
                style={{
                  alignSelf: isOut ? "flex-end" : "flex-start",
                  maxWidth: "70%",
                  backgroundColor: isOut ? (m.actor === "MANUAL_OWNER" ? "#0284c7" : "#2563eb") : "#f1f5f9",
                  color: isOut ? "#ffffff" : "#1e293b",
                  padding: "10px 14px",
                  borderRadius: "12px",
                  borderBottomRightRadius: isOut ? "2px" : "12px",
                  borderBottomLeftRadius: !isOut ? "2px" : "12px",
                }}
              >
                <div style={{ fontSize: "0.75rem", color: isOut ? "#e0f2fe" : "#64748b", marginBottom: "2px", display: "flex", justifyContent: "space-between", gap: "8px" }}>
                  <span>{isOut ? (m.actor === "MANUAL_OWNER" ? "Chủ shop (Manual)" : "AI Rep") : customer.name || "Khách hàng"}</span>
                  <span>{new Date(m.timestamp).toLocaleTimeString("vi-VN")}</span>
                </div>
                <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: "0.95rem" }}>{m.text}</div>
              </div>
            );
          })
        )}
      </div>

      {/* Manual Send Composer */}
      <form onSubmit={handleManualSend} style={{ display: "flex", gap: "8px", backgroundColor: "#ffffff", padding: "12px", borderRadius: "8px", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
        <input
          type="text"
          value={manualText}
          onChange={(e) => setManualText(e.target.value)}
          placeholder={conv.manualMode ? "Soạn tin nhắn gửi trực tiếp đến khách qua single-sender..." : "Bật Manual để can thiệp hoặc soạn tin gửi trực tiếp..."}
          disabled={sending}
          style={{
            flex: 1,
            padding: "10px 14px",
            borderRadius: "6px",
            border: "1px solid #cbd5e1",
            outline: "none",
            fontSize: "0.95rem",
          }}
        />
        <button
          type="submit"
          disabled={sending || !manualText.trim()}
          style={{
            backgroundColor: "#2563eb",
            color: "#ffffff",
            border: "none",
            borderRadius: "6px",
            padding: "0 18px",
            cursor: sending || !manualText.trim() ? "not-allowed" : "pointer",
            fontWeight: "600",
            display: "flex",
            alignItems: "center",
            gap: "6px",
          }}
        >
          <Send size={16} />
          {sending ? "Đang gửi..." : "Gửi"}
        </button>
      </form>
    </div>
  );
};
