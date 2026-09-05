import React, { useEffect, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "../api";
import type { ChannelOverview } from "../types";
import { shouldRefetchOverview } from "../helpers/sse-helpers";
import { useSseWakeup } from "../context/SseContext";
import { useBusinessTimeZone } from "../context/TimezoneContext";
import {
  MessageSquare,
  Users,
  AlertTriangle,
  Activity,
  Loader2,
  RefreshCw,
  AlertCircle,
  Bot,
} from "lucide-react";

export const OverviewPage: React.FC = () => {
  const { setTimeZone, formatTime } = useBusinessTimeZone();
  const [data, setData] = useState<ChannelOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await apiFetch<ChannelOverview>("/api/overview");
      setData(res);
      if (res.businessTimeZone) {
        setTimeZone(res.businessTimeZone);
      }
    } catch (err: unknown) {
      setError((err as Error).message || "Không thể tải dữ liệu tổng quan");
    } finally {
      setLoading(false);
    }
  }, [setTimeZone]);

  useEffect(() => {
    load();
  }, [load]);

  // SSE wakeup: refetches only when overview events arrive (no duplicate polling)
  useSseWakeup(shouldRefetchOverview, load);

  if (loading && !data) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "300px", gap: "10px", color: "#64748b" }}>
        <Loader2 size={24} className="animate-spin" />
        <span>Đang tải dữ liệu tổng quan...</span>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div style={{ backgroundColor: "#fef2f2", border: "1px solid #fecaca", borderRadius: "8px", padding: "20px", color: "#991b1b" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", fontWeight: "bold", marginBottom: "8px" }}>
          <AlertCircle size={20} /> Lỗi kết nối máy chủ
        </div>
        <div>{error}</div>
        <button
          onClick={load}
          style={{ marginTop: "12px", display: "flex", alignItems: "center", gap: "6px", padding: "6px 12px", borderRadius: "6px", backgroundColor: "#dc2626", color: "#fff", border: "none", cursor: "pointer" }}
        >
          <RefreshCw size={14} /> Thử lại
        </button>
      </div>
    );
  }

  if (!data) return null;

  const cardStyle: React.CSSProperties = {
    backgroundColor: "#ffffff",
    padding: "20px",
    borderRadius: "10px",
    boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    border: "1px solid #e2e8f0",
  };

  const formatConvStatus = (status: string) => {
    switch (status) {
      case "QUEUED":
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
        return "Chờ tin nhắn mới";
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px" }}>
        <div>
          <h1 style={{ margin: "0 0 4px 0", fontSize: "1.5rem", fontWeight: "bold", color: "#0f172a" }}>
            Tổng quan hệ thống
          </h1>
          <div style={{ fontSize: "0.85rem", color: "#64748b" }}>
            Trạng thái kênh Messenger, hàng đợi và chỉ số hoạt động chăm sóc khách hàng
          </div>
        </div>
        <button
          onClick={load}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "6px",
            padding: "8px 14px",
            backgroundColor: "#ffffff",
            border: "1px solid #cbd5e1",
            borderRadius: "6px",
            fontSize: "0.85rem",
            fontWeight: "600",
            cursor: "pointer",
          }}
        >
          <RefreshCw size={14} /> Làm mới
        </button>
      </div>

      {/* Active serving conversation highlight (Single Agent) */}
      <div
        style={{
          backgroundColor: data.activeConversation ? "#eff6ff" : "#ffffff",
          border: `1px solid ${data.activeConversation ? "#93c5fd" : "#e2e8f0"}`,
          padding: "16px 20px",
          borderRadius: "10px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: "12px",
          boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <div
            style={{
              width: "40px",
              height: "40px",
              borderRadius: "8px",
              backgroundColor: data.activeConversation ? "#dbeafe" : "#f1f5f9",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: data.activeConversation ? "#2563eb" : "#64748b",
            }}
          >
            <Bot size={22} />
          </div>
          <div>
            <div style={{ fontSize: "0.78rem", color: "#64748b", fontWeight: "700", textTransform: "uppercase" }}>
              Hội thoại đang được AI hỗ trợ
            </div>
            {data.activeConversation ? (
              <div style={{ marginTop: "2px", fontSize: "1rem", fontWeight: "bold", color: "#1e3a8a" }}>
                Đang xử lý phản hồi • Trạng thái:{" "}
                <span style={{ textDecoration: "underline" }}>{formatConvStatus(data.activeConversation.status)}</span>
                {data.activeConversation.claimedAt && (
                  <span style={{ fontSize: "0.85rem", fontWeight: "normal", color: "#475569", marginLeft: "8px" }}>
                    • Tiếp nhận: {formatTime(data.activeConversation.claimedAt)}
                  </span>
                )}
              </div>
            ) : (
              <div style={{ marginTop: "2px", fontSize: "0.9rem", color: "#64748b" }}>
                Hiện không có hội thoại nào cần xử lý gấp. Hệ thống sẵn sàng tiếp nhận tin nhắn mới.
              </div>
            )}
          </div>
        </div>

        {data.activeConversation && (
          <Link
            to={`/inbox/${data.activeConversation.id}`}
            style={{
              backgroundColor: "#2563eb",
              color: "#ffffff",
              padding: "8px 16px",
              borderRadius: "6px",
              textDecoration: "none",
              fontWeight: "600",
              fontSize: "0.85rem",
            }}
          >
            Mở hội thoại
          </Link>
        )}
      </div>

      {/* Metric Cards Grid */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "16px" }}>
        <div style={cardStyle}>
          <div style={{ display: "flex", justifyContent: "space-between", color: "#64748b" }}>
            <span style={{ fontSize: "0.85rem", fontWeight: "600" }}>Độ dài hàng đợi</span>
            <Activity size={20} color="#3b82f6" />
          </div>
          <div style={{ fontSize: "1.8rem", fontWeight: "bold", color: "#0f172a" }}>{data.queueLength}</div>
          <div style={{ fontSize: "0.8rem", color: "#64748b" }}>
            Chờ lâu nhất: {data.oldestWaitSeconds}s • Ước tính: ~{data.estimatedWaitSeconds}s
          </div>
        </div>

        <div style={cardStyle}>
          <div style={{ display: "flex", justifyContent: "space-between", color: "#64748b" }}>
            <span style={{ fontSize: "0.85rem", fontWeight: "600" }}>Hội thoại hôm nay</span>
            <Users size={20} color="#10b981" />
          </div>
          <div style={{ fontSize: "1.8rem", fontWeight: "bold", color: "#0f172a" }}>{data.todayConversationsCount}</div>
          <div style={{ fontSize: "0.8rem", color: "#64748b" }}>Tổng khách hàng phát sinh tin</div>
        </div>

        <div style={cardStyle}>
          <div style={{ display: "flex", justifyContent: "space-between", color: "#64748b" }}>
            <span style={{ fontSize: "0.85rem", fontWeight: "600" }}>Tin nhắn hôm nay</span>
            <MessageSquare size={20} color="#8b5cf6" />
          </div>
          <div style={{ fontSize: "1.8rem", fontWeight: "bold", color: "#0f172a" }}>{data.todayMessagesCount}</div>
          <div style={{ fontSize: "0.8rem", color: "#64748b" }}>Bao gồm tin nhắn gửi và nhận</div>
        </div>

        <div style={cardStyle}>
          <div style={{ display: "flex", justifyContent: "space-between", color: "#64748b" }}>
            <span style={{ fontSize: "0.85rem", fontWeight: "600" }}>Sự cố cần xử lý</span>
            <AlertTriangle size={20} color={data.openIncidentsCount > 0 ? "#ef4444" : "#10b981"} />
          </div>
          <div style={{ fontSize: "1.8rem", fontWeight: "bold", color: data.openIncidentsCount > 0 ? "#dc2626" : "#0f172a" }}>
            {data.openIncidentsCount}
          </div>
          <div style={{ fontSize: "0.8rem", color: "#64748b" }}>
            {data.openIncidentsCount > 0 ? (
              <Link to="/incidents" style={{ color: "#dc2626", fontWeight: "600", textDecoration: "underline" }}>
                Xem danh sách sự cố
              </Link>
            ) : (
              "Hệ thống ổn định"
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
