import React, { useEffect, useState, useCallback, useRef } from "react";
import { useParams, Link } from "react-router-dom";
import { apiFetch } from "../api";
import type {
  ConversationDetailData,
  MessageItem,
  OutboundActionItem,
} from "../types";
import { mergePaginatedMessages } from "../helpers/pagination";
import {
  createTakeoverContext,
  transitionToWaitingCancelAck,
  transitionToManualActive,
  transitionToResuming,
  transitionToAuto,
  canSendManualMessage,
  type TakeoverMachineContext,
} from "../helpers/takeover-machine";
import { shouldRefetchConversationDetail } from "../helpers/sse-helpers";
import { useSseWakeup } from "../context/SseContext";
import { formatTime } from "../helpers/date-helpers";
import {
  ArrowLeft,
  UserCheck,
  Send,
  RefreshCw,
  Cpu,
  AlertTriangle,
  Clock,
  ShieldAlert,
  Loader2,
  Play,
  RotateCcw,
  Check,
} from "lucide-react";

export const ConversationDetailPage: React.FC = () => {
  const { conversationId } = useParams<{ conversationId: string }>();
  const [data, setData] = useState<ConversationDetailData | null>(null);
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [nextMessageCursor, setNextMessageCursor] = useState<string | null>(null);
  const [hasMoreMessages, setHasMoreMessages] = useState<boolean>(false);
  const [loadingOlder, setLoadingOlder] = useState<boolean>(false);

  // Takeover state machine
  const [takeoverCtx, setTakeoverCtx] = useState<TakeoverMachineContext>(() =>
    createTakeoverContext(false)
  );

  const [manualText, setManualText] = useState("");
  const [sendingManual, setSendingManual] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reconcilingId, setReconcilingId] = useState<string | null>(null);

  const conversationIdRef = useRef(conversationId);
  conversationIdRef.current = conversationId;

  const loadDetails = useCallback(async (messageCursor?: string, appendOlder = false) => {
    if (!conversationIdRef.current) return;
    setError(null);
    if (appendOlder) {
      setLoadingOlder(true);
    }

    try {
      let url = `/api/inbox/${conversationIdRef.current}?messageLimit=30`;
      if (messageCursor) {
        url += `&messageCursor=${encodeURIComponent(messageCursor)}`;
      }

      const res = await apiFetch<ConversationDetailData>(url);
      setData(res);

      if (appendOlder) {
        setMessages((prev) => mergePaginatedMessages(res.messages || [], prev));
      } else {
        setMessages(res.messages || []);
      }

      setNextMessageCursor(res.nextMessageCursor || null);
      setHasMoreMessages(Boolean(res.hasMoreMessages && res.nextMessageCursor));

      // Update takeover machine context based on live manualMode and active actions
      setTakeoverCtx((prev) => {
        if (res.conversation.manualMode) {
          return transitionToManualActive(prev, {
            actions: res.outboundActions,
            forceAck: true,
          });
        }
        return transitionToAuto(prev);
      });
    } catch (err: unknown) {
      setError((err as Error).message || "Không thể tải chi tiết cuộc hội thoại");
    } finally {
      setLoading(false);
      setLoadingOlder(false);
    }
  }, []);

  useEffect(() => {
    loadDetails();
  }, [conversationId, loadDetails]);

  // SSE wakeup: refetches only when events relevant to this conversation arrive
  useSseWakeup(
    (type, payload) =>
      shouldRefetchConversationDetail(
        type,
        conversationId || "",
        payload as { conversationId?: string; id?: string } | undefined
      ),
    () => loadDetails()
  );

  const handleLoadOlderMessages = () => {
    if (!loadingOlder && hasMoreMessages && nextMessageCursor) {
      loadDetails(nextMessageCursor, true);
    }
  };

  // Step 1 of takeover: operator triggers takeover -> enters WAITING_CANCEL_ACK -> sends request
  const handleInitiateTakeover = async () => {
    if (!conversationId) return;
    setTakeoverCtx((prev) => transitionToWaitingCancelAck(prev));

    try {
      const res = await apiFetch<{ success: boolean; cancelAck?: boolean }>(
        `/api/inbox/${conversationId}/takeover`,
        { method: "POST" }
      );

      // Transition to MANUAL_ACTIVE once cancel acknowledgement is received
      setTakeoverCtx((prev) =>
        transitionToManualActive(prev, { forceAck: Boolean(res.cancelAck) })
      );
      await loadDetails();
    } catch (err: unknown) {
      alert((err as Error).message);
      setTakeoverCtx(createTakeoverContext(false));
    }
  };

  // Resume bot flow: operator releases takeover -> enters RESUMING -> back to AUTO
  const handleResumeAi = async () => {
    if (!conversationId) return;
    setTakeoverCtx((prev) => transitionToResuming(prev));

    try {
      await apiFetch(`/api/inbox/${conversationId}/release`, { method: "POST" });
      setTakeoverCtx(createTakeoverContext(false));
      await loadDetails();
    } catch (err: unknown) {
      alert((err as Error).message);
    }
  };

  const handleManualSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualText.trim() || !conversationId) return;

    if (!canSendManualMessage(takeoverCtx)) {
      alert("Hội thoại chưa sẵn sàng gửi thủ công (Đang chờ xác nhận hủy bot)");
      return;
    }

    setSendingManual(true);
    try {
      await apiFetch(`/api/inbox/${conversationId}/manual-send`, {
        method: "POST",
        body: JSON.stringify({ text: manualText.trim() }),
      });
      setManualText("");
      await loadDetails();
    } catch (err: unknown) {
      alert((err as Error).message);
    } finally {
      setSendingManual(false);
    }
  };

  const handleReconcileAction = async (actionId: string, resolution: "MARK_SENT" | "RETRY") => {
    if (!conversationId) return;
    const confirmMsg =
      resolution === "MARK_SENT"
        ? "Xác nhận: Tin nhắn đã thực sự đến tay khách hàng trên Messenger?"
        : "CẢNH BÁO: Bạn chắc chắn tin nhắn chưa đến tay khách và đồng ý gửi lại? (Tránh gửi lặp tin nhắn)";

    if (!confirm(confirmMsg)) return;

    setReconcilingId(actionId);
    try {
      await apiFetch(`/api/inbox/${conversationId}/reconcile-action`, {
        method: "POST",
        body: JSON.stringify({ actionId, resolution }),
      });
      await loadDetails();
    } catch (err: unknown) {
      alert((err as Error).message);
    } finally {
      setReconcilingId(null);
    }
  };

  if (loading && !data) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "300px", gap: "10px", color: "#64748b" }}>
        <Loader2 size={22} className="animate-spin" />
        <span>Đang tải thông tin cuộc hội thoại...</span>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div style={{ backgroundColor: "#fef2f2", border: "1px solid #fecaca", borderRadius: "8px", padding: "20px", color: "#991b1b" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", fontWeight: "bold", marginBottom: "8px" }}>
          <AlertTriangle size={20} /> Lỗi tải hội thoại
        </div>
        <div>{error}</div>
        <Link to="/inbox" style={{ marginTop: "12px", display: "inline-block", color: "#2563eb", textDecoration: "underline" }}>
          Quay lại hộp thư
        </Link>
      </div>
    );
  }

  if (!data) return null;

  const conv = data.conversation;
  const customer = data.customer;
  const actions: OutboundActionItem[] = data.outboundActions || [];
  const events = data.events || [];

  // Check if any action is SEND_UNCERTAIN or UNCONFIRMED
  const uncertainActions = actions.filter(
    (a) => a.status === "SEND_UNCERTAIN" || a.status === "UNCONFIRMED"
  );

  const formatConversationStatus = (status: string, manualMode?: boolean) => {
    if (manualMode) return "Hỗ trợ trực tiếp";
    switch (status) {
      case "WAITING":
        return "Đang chờ tin nhắn";
      case "DEBOUNCING":
        return "Đang chờ phản hồi";
      case "READING":
      case "THINKING":
      case "DRAFT_READY":
      case "TYPING":
      case "SENDING":
        return "AI đang soạn tin";
      case "ERROR":
        return "Cần kiểm tra";
      default:
        return "Đang chờ tin nhắn";
    }
  };

  const formatActionStatus = (status: string) => {
    switch (status) {
      case "SENT":
        return "Đã gửi";
      case "SEND_UNCERTAIN":
        return "Cần xác nhận";
      case "QUEUED":
        return "Đang chờ gửi";
      case "IN_PROGRESS":
        return "Đang gửi";
      case "FAILED":
        return "Gửi thất bại";
      case "CANCELLED":
        return "Đã hủy";
      case "SKIPPED":
        return "Bỏ qua";
      default:
        return status || "Chưa rõ";
    }
  };

  const formatEventType = (type: string) => {
    switch (type) {
      case "INBOUND_MESSAGE":
        return "Khách gửi tin";
      case "OUTBOUND_MESSAGE":
        return "Gửi phản hồi";
      case "AI_RUN":
        return "AI xử lý";
      case "TAKEOVER_STARTED":
        return "Bắt đầu hỗ trợ trực tiếp";
      case "TAKEOVER_RELEASED":
        return "Chuyển lại cho AI";
      case "TAKEOVER_CANCEL_ACK":
        return "Đã dừng AI phản hồi";
      case "ACTION_RECONCILED":
        return "Xác nhận gửi tin";
      case "INCIDENT_CREATED":
        return "Phát sinh sự cố";
      case "INCIDENT_RESOLVED":
        return "Đã xử lý sự cố";
      default:
        return type.replace(/_/g, " ").toLowerCase();
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", gap: "14px", maxWidth: "100%" }}>
      {/* Header Bar */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "12px",
          backgroundColor: "#ffffff",
          padding: "14px 20px",
          borderRadius: "8px",
          boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <Link to="/inbox" style={{ color: "#64748b", textDecoration: "none", display: "flex", alignItems: "center" }}>
            <ArrowLeft size={20} />
          </Link>
          <div>
            <div style={{ fontWeight: "bold", fontSize: "1.1rem", color: "#0f172a" }}>
              {customer.name || "Khách hàng Messenger"}
            </div>
            <div style={{ fontSize: "0.8rem", color: "#64748b", marginTop: "2px" }}>
              Trạng thái: <strong style={{ color: "#1e293b" }}>{formatConversationStatus(conv.status, conv.manualMode)}</strong>
            </div>
            <div style={{ marginTop: "4px", fontSize: "0.75rem", color: "#64748b", display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
              <span style={{ backgroundColor: "#f1f5f9", padding: "2px 8px", borderRadius: "4px" }}>
                {conv.threadKind === "GROUP" ? "Nhóm chat Messenger" : "Hội thoại trực tiếp"}
              </span>
              <span>Phiên bản tin nhắn: v{conv.inboundVersion}</span>
            </div>
          </div>
        </div>

        {/* Takeover and Controls */}
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          {conv.manualMode || takeoverCtx.state === "MANUAL_ACTIVE" ? (
            <button
              onClick={handleResumeAi}
              disabled={takeoverCtx.state === "RESUMING"}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "6px",
                padding: "8px 14px",
                backgroundColor: "#10b981",
                color: "#ffffff",
                border: "none",
                borderRadius: "6px",
                fontWeight: "600",
                fontSize: "0.85rem",
                cursor: takeoverCtx.state === "RESUMING" ? "not-allowed" : "pointer",
              }}
            >
              <Play size={15} /> Bật lại AI tự động
            </button>
          ) : (
            <button
              onClick={handleInitiateTakeover}
              disabled={takeoverCtx.state === "WAITING_CANCEL_ACK"}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "6px",
                padding: "8px 14px",
                backgroundColor: "#f59e0b",
                color: "#ffffff",
                border: "none",
                borderRadius: "6px",
                fontWeight: "600",
                fontSize: "0.85rem",
                cursor: takeoverCtx.state === "WAITING_CANCEL_ACK" ? "not-allowed" : "pointer",
              }}
            >
              <UserCheck size={15} /> Tiếp quản thủ công
            </button>
          )}

          <button
            onClick={() => loadDetails()}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "4px",
              padding: "8px 12px",
              backgroundColor: "#ffffff",
              border: "1px solid #cbd5e1",
              borderRadius: "6px",
              fontSize: "0.85rem",
              cursor: "pointer",
            }}
          >
            <RefreshCw size={14} /> Làm mới
          </button>
        </div>
      </div>

      {/* Takeover State Banner */}
      {takeoverCtx.state === "WAITING_CANCEL_ACK" && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "10px",
            padding: "12px 16px",
            backgroundColor: "#fffbeb",
            border: "1px solid #fde68a",
            borderRadius: "8px",
            color: "#92400e",
            fontSize: "0.85rem",
            fontWeight: "600",
          }}
        >
          <Loader2 size={18} className="animate-spin" />
          <span>Đang tạm dừng phản hồi tự động... Vui lòng đợi trong giây lát trước khi gửi tin.</span>
        </div>
      )}

      {takeoverCtx.state === "MANUAL_ACTIVE" && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "10px",
            padding: "12px 16px",
            backgroundColor: "#fef3c7",
            border: "1px solid #fcd34d",
            borderRadius: "8px",
            color: "#92400e",
            fontSize: "0.85rem",
            fontWeight: "600",
          }}
        >
          <UserCheck size={18} />
          <span>Bạn đang hỗ trợ trực tiếp cuộc hội thoại này. AI đã tạm dừng phản hồi tự động.</span>
        </div>
      )}

      {/* SEND_UNCERTAIN Alert Banner */}
      {uncertainActions.length > 0 && (
        <div
          style={{
            padding: "14px 18px",
            backgroundColor: "#fef2f2",
            border: "1px solid #f87171",
            borderRadius: "8px",
            color: "#991b1b",
            fontSize: "0.85rem",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "8px", fontWeight: "700", marginBottom: "6px" }}>
            <ShieldAlert size={18} /> Cần xác nhận kết quả gửi tin
          </div>
          <div>
            Có <strong>{uncertainActions.length}</strong> tin nhắn chưa chắc chắn đã đến tay khách hàng.
            Hệ thống tạm dừng để tránh gửi lặp tin. Vui lòng kiểm tra trên Facebook Messenger và bấm xác nhận bên dưới:
          </div>
          <div style={{ marginTop: "10px", display: "flex", flexDirection: "column", gap: "8px" }}>
            {uncertainActions.map((action) => (
              <div
                key={action.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  backgroundColor: "#ffffff",
                  padding: "8px 12px",
                  borderRadius: "6px",
                  border: "1px solid #fecaca",
                  flexWrap: "wrap",
                  gap: "8px",
                }}
              >
                <span style={{ fontSize: "0.85rem", color: "#334155" }}>
                  Nội dung: "{action.text.slice(0, 50)}..."
                </span>
                <div style={{ display: "flex", gap: "6px" }}>
                  <button
                    onClick={() => handleReconcileAction(action.actionId, "MARK_SENT")}
                    disabled={reconcilingId === action.actionId}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "4px",
                      padding: "4px 10px",
                      backgroundColor: "#16a34a",
                      color: "#ffffff",
                      border: "none",
                      borderRadius: "4px",
                      fontSize: "0.75rem",
                      fontWeight: "600",
                      cursor: "pointer",
                    }}
                  >
                    <Check size={12} /> Đã gửi thành công
                  </button>
                  <button
                    onClick={() => handleReconcileAction(action.actionId, "RETRY")}
                    disabled={reconcilingId === action.actionId}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "4px",
                      padding: "4px 10px",
                      backgroundColor: "#ea580c",
                      color: "#ffffff",
                      border: "none",
                      borderRadius: "4px",
                      fontSize: "0.75rem",
                      fontWeight: "600",
                      cursor: "pointer",
                    }}
                  >
                    <RotateCcw size={12} /> Thử gửi lại
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Main Content Area: Responsive Split Grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
          gap: "16px",
          flex: 1,
        }}
      >
        {/* Message Thread & Composer */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            backgroundColor: "#ffffff",
            borderRadius: "8px",
            boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
            overflow: "hidden",
            minHeight: "450px",
          }}
        >
          {/* Load older messages button (Cursor Pagination) */}
          {hasMoreMessages && (
            <div style={{ padding: "8px", textAlign: "center", borderBottom: "1px solid #f1f5f9" }}>
              <button
                onClick={handleLoadOlderMessages}
                disabled={loadingOlder}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  padding: "6px 14px",
                  backgroundColor: "#f8fafc",
                  border: "1px solid #cbd5e1",
                  borderRadius: "6px",
                  fontSize: "0.8rem",
                  color: "#475569",
                  cursor: loadingOlder ? "not-allowed" : "pointer",
                }}
              >
                {loadingOlder ? <Loader2 size={13} className="animate-spin" /> : <Clock size={13} />}
                {loadingOlder ? "Đang tải tin cũ..." : "Tải tin nhắn cũ hơn"}
              </button>
            </div>
          )}

          {/* Messages list */}
          <div style={{ flex: 1, padding: "16px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "14px" }}>
            {messages.length === 0 ? (
              <div style={{ margin: "auto", color: "#94a3b8", fontSize: "0.85rem", textAlign: "center" }}>
                Chưa có tin nhắn nào trong hội thoại này
              </div>
            ) : (
              messages.map((msg) => {
                const isInbound = msg.direction === "INBOUND";
                return (
                  <div
                    key={msg.id}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: isInbound ? "flex-start" : "flex-end",
                      gap: "4px",
                    }}
                  >
                    {/* Sender snapshot */}
                    <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "0.75rem", color: "#64748b" }}>
                      {isInbound && (
                        <div style={{ width: "20px", height: "20px", borderRadius: "50%", backgroundColor: "#e2e8f0", overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center" }}>
                          {msg.avatarUrl ? (
                            <img src={msg.avatarUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                          ) : (
                            <UserCheck size={11} color="#64748b" />
                          )}
                        </div>
                      )}
                      <span style={{ fontWeight: "600", color: isInbound ? "#1e293b" : "#475569" }}>
                        {msg.senderName || (msg.actor === "AI" ? "Trợ lý AI" : msg.actor === "MANUAL_OWNER" ? "Nhân viên hỗ trợ" : isInbound ? "Khách hàng" : "Hệ thống")}
                      </span>
                      {isInbound && msg.isVerified && (
                        <span title="Người dùng đã xác minh" style={{ color: "#2563eb", display: "inline-flex" }}>
                          <Check size={12} />
                        </span>
                      )}
                      <span>•</span>
                      <span>{formatTime(msg.timestamp)}</span>
                    </div>

                    {/* Message bubble */}
                    <div
                      style={{
                        maxWidth: "80%",
                        padding: "10px 14px",
                        borderRadius: "14px",
                        backgroundColor: isInbound ? "#f1f5f9" : "#2563eb",
                        color: isInbound ? "#0f172a" : "#ffffff",
                        fontSize: "0.9rem",
                        lineHeight: 1.45,
                        wordBreak: "break-word",
                      }}
                    >
                      {msg.text}
                    </div>

                    {/* Readable Skip Reason Badge */}
                    {msg.skipReason && (
                      <div
                        style={{
                          marginTop: "2px",
                          maxWidth: "80%",
                          padding: "6px 10px",
                          borderRadius: "6px",
                          backgroundColor: "#fef2f2",
                          border: "1px solid #fecaca",
                          color: "#991b1b",
                          fontSize: "0.75rem",
                          display: "flex",
                          flexDirection: "column",
                          gap: "2px",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: "5px", fontWeight: "600" }}>
                          <AlertTriangle size={12} color="#dc2626" />
                          <span>Tự động bỏ qua: {msg.skipReason.humanReadableReason}</span>
                        </div>
                        <div style={{ fontSize: "0.7rem", color: "#b91c1c" }}>
                          Bước kiểm tra: {msg.skipReason.precedenceStep} • Mã: {msg.skipReason.reasonCode} {msg.skipReason.evaluationMode && `• Chế độ: ${msg.skipReason.evaluationMode}`}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {/* Composer Box */}
          <form
            onSubmit={handleManualSend}
            style={{
              padding: "12px 16px",
              borderTop: "1px solid #e2e8f0",
              backgroundColor: "#f8fafc",
              display: "flex",
              gap: "8px",
              alignItems: "center",
            }}
          >
            <input
              type="text"
              value={manualText}
              onChange={(e) => setManualText(e.target.value)}
              disabled={!canSendManualMessage(takeoverCtx) || sendingManual}
              placeholder={
                canSendManualMessage(takeoverCtx)
                  ? "Nhập tin nhắn phản hồi tới khách hàng..."
                  : "Bấm 'Tiếp quản thủ công' phía trên để mở khung chat"
              }
              style={{
                flex: 1,
                padding: "10px 14px",
                borderRadius: "8px",
                border: "1px solid #cbd5e1",
                fontSize: "0.9rem",
                outline: "none",
                backgroundColor: canSendManualMessage(takeoverCtx) ? "#ffffff" : "#f1f5f9",
              }}
            />
            <button
              type="submit"
              disabled={!canSendManualMessage(takeoverCtx) || !manualText.trim() || sendingManual}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "6px",
                padding: "10px 18px",
                borderRadius: "8px",
                border: "none",
                backgroundColor: canSendManualMessage(takeoverCtx) && manualText.trim() ? "#2563eb" : "#94a3b8",
                color: "#ffffff",
                fontWeight: "600",
                fontSize: "0.9rem",
                cursor: canSendManualMessage(takeoverCtx) && manualText.trim() && !sendingManual ? "pointer" : "not-allowed",
              }}
            >
              {sendingManual ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
              <span>Gửi</span>
            </button>
          </form>
        </div>

        {/* Sidebar Panel: Outbound Actions & Audit Events */}
        <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
          {/* Outbound Actions List */}
          <div style={{ backgroundColor: "#ffffff", borderRadius: "8px", padding: "16px", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
            <h3 style={{ margin: "0 0 12px 0", fontSize: "0.95rem", fontWeight: "700", color: "#1e293b", display: "flex", alignItems: "center", gap: "6px" }}>
              <Cpu size={16} color="#2563eb" /> Tin nhắn đã gửi gần nhất
            </h3>

            {actions.length === 0 ? (
              <div style={{ fontSize: "0.8rem", color: "#94a3b8" }}>Chưa có tin nhắn nào được gửi</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "8px", maxHeight: "250px", overflowY: "auto" }}>
                {actions.map((act) => (
                  <div
                    key={act.id}
                    style={{
                      padding: "8px 10px",
                      borderRadius: "6px",
                      border: "1px solid #e2e8f0",
                      backgroundColor: act.status === "SEND_UNCERTAIN" ? "#fef2f2" : "#f8fafc",
                      fontSize: "0.8rem",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span style={{ fontWeight: "600", color: "#334155" }}>Tin #{act.responseIndex + 1}</span>
                      <span
                        style={{
                          fontWeight: "700",
                          fontSize: "0.72rem",
                          padding: "2px 6px",
                          borderRadius: "4px",
                          backgroundColor: act.status === "SENT" ? "#dcfce7" : act.status === "SEND_UNCERTAIN" ? "#fee2e2" : "#e2e8f0",
                          color: act.status === "SENT" ? "#166534" : act.status === "SEND_UNCERTAIN" ? "#991b1b" : "#475569",
                        }}
                      >
                        {formatActionStatus(act.status)}
                      </span>
                    </div>
                    <div style={{ color: "#475569", marginTop: "4px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {act.text}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Audit Events */}
          <div style={{ backgroundColor: "#ffffff", borderRadius: "8px", padding: "16px", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
            <h3 style={{ margin: "0 0 12px 0", fontSize: "0.95rem", fontWeight: "700", color: "#1e293b", display: "flex", alignItems: "center", gap: "6px" }}>
              <Clock size={16} color="#64748b" /> Hoạt động gần đây
            </h3>

            {events.length === 0 ? (
              <div style={{ fontSize: "0.8rem", color: "#94a3b8" }}>Chưa có hoạt động nào</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "6px", maxHeight: "200px", overflowY: "auto" }}>
                {events.slice(0, 15).map((ev) => (
                  <div key={ev.id} style={{ display: "flex", justifyContent: "space-between", fontSize: "0.75rem", borderBottom: "1px solid #f1f5f9", paddingBottom: "4px" }}>
                    <span style={{ fontWeight: "600", color: "#334155" }}>{formatEventType(ev.type)}</span>
                    <span style={{ color: "#94a3b8" }}>{formatTime(ev.createdAt)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
