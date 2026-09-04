import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "../api";
import type { ChannelOverview } from "../types";
import { MessageSquare, Users, Clock, AlertTriangle, Activity } from "lucide-react";

export const OverviewPage: React.FC = () => {
  const [data, setData] = useState<ChannelOverview | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await apiFetch<ChannelOverview>("/api/overview");
        setData(res);
      } catch {
        // Handled
      }
    };
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, []);

  if (!data) return <div>Đang tải dữ liệu tổng quan...</div>;

  const cardStyle: React.CSSProperties = {
    backgroundColor: "#ffffff",
    padding: "20px",
    borderRadius: "8px",
    boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
    display: "flex",
    flexDirection: "column",
    gap: "8px",
  };

  return (
    <div>
      <h1 style={{ margin: "0 0 20px 0", fontSize: "1.5rem", fontWeight: "bold" }}>Tổng quan hệ thống</h1>

      {/* Active serving conversation highlight */}
      <div
        style={{
          backgroundColor: data.activeConversation ? "#eff6ff" : "#f1f5f9",
          border: `1px solid ${data.activeConversation ? "#93c5fd" : "#cbd5e1"}`,
          padding: "16px 20px",
          borderRadius: "8px",
          marginBottom: "24px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div>
          <div style={{ fontSize: "0.85rem", color: "#64748b", fontWeight: "600" }}>
            CONVERSATION ĐANG ĐƯỢC PHỤC VỤ (SINGLE AGENT)
          </div>
          {data.activeConversation ? (
            <div style={{ marginTop: "4px", fontSize: "1.1rem", fontWeight: "bold", color: "#1e3a8a" }}>
              Thread: {data.activeConversation.externalThreadId} | Trạng thái:{" "}
              <span style={{ color: "#2563eb" }}>{data.activeConversation.status}</span>
            </div>
          ) : (
            <div style={{ marginTop: "4px", fontSize: "1rem", color: "#475569" }}>
              Hiện không có conversation nào đang được xử lý (Hàng đợi rỗng hoặc đang chờ tin nhắn)
            </div>
          )}
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
              fontSize: "0.9rem",
            }}
          >
            Xem chi tiết
          </Link>
        )}
      </div>

      {/* Metric Cards Grid */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "16px" }}>
        <div style={cardStyle}>
          <div style={{ display: "flex", justifyContent: "space-between", color: "#64748b" }}>
            <span>Độ dài hàng đợi</span>
            <Activity size={20} color="#3b82f6" />
          </div>
          <div style={{ fontSize: "1.8rem", fontWeight: "bold" }}>{data.queueLength}</div>
          <div style={{ fontSize: "0.85rem", color: "#64748b" }}>
            Chờ lâu nhất: {data.oldestWaitSeconds}s | Ước tính: ~{data.estimatedWaitSeconds}s
          </div>
        </div>

        <div style={cardStyle}>
          <div style={{ display: "flex", justifyContent: "space-between", color: "#64748b" }}>
            <span>Hội thoại hôm nay</span>
            <Users size={20} color="#10b981" />
          </div>
          <div style={{ fontSize: "1.8rem", fontWeight: "bold" }}>{data.todayConversationsCount}</div>
          <div style={{ fontSize: "0.85rem", color: "#64748b" }}>Khách hàng phát sinh tin nhắn</div>
        </div>

        <div style={cardStyle}>
          <div style={{ display: "flex", justifyContent: "space-between", color: "#64748b" }}>
            <span>Tin nhắn hôm nay</span>
            <MessageSquare size={20} color="#8b5cf6" />
          </div>
          <div style={{ fontSize: "1.8rem", fontWeight: "bold" }}>{data.todayMessagesCount}</div>
          <div style={{ fontSize: "0.85rem", color: "#64748b" }}>Bao gồm Inbound & Outbound</div>
        </div>

        <div style={cardStyle}>
          <div style={{ display: "flex", justifyContent: "space-between", color: "#64748b" }}>
            <span>Sự cố chưa đóng</span>
            <AlertTriangle size={20} color={data.openIncidentsCount > 0 ? "#ef4444" : "#10b981"} />
          </div>
          <div
            style={{
              fontSize: "1.8rem",
              fontWeight: "bold",
              color: data.openIncidentsCount > 0 ? "#ef4444" : "#10b981",
            }}
          >
            {data.openIncidentsCount}
          </div>
          <div style={{ fontSize: "0.85rem", color: "#64748b" }}>
            {data.openIncidentsCount > 0 ? "Cần kiểm tra ngay" : "Hệ thống hoạt động bình thường"}
          </div>
        </div>
      </div>
    </div>
  );
};
