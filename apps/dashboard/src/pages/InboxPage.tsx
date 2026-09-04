import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "../api";
import type { ConversationItem } from "../types";

export const InboxPage: React.FC = () => {
  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  const [filter, setFilter] = useState<string>("all");
  const [loading, setLoading] = useState<boolean>(true);

  const loadInbox = async (f: string) => {
    setLoading(true);
    try {
      const res = await apiFetch<{ conversations: ConversationItem[] }>(`/api/inbox?filter=${f}`);
      setConversations(res.conversations);
    } catch {
      // Handled
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadInbox(filter);
    const timer = setInterval(() => loadInbox(filter), 5000);
    return () => clearInterval(timer);
  }, [filter]);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
        <h1 style={{ margin: 0, fontSize: "1.5rem", fontWeight: "bold" }}>Hộp thư khách hàng</h1>
        <div style={{ display: "flex", gap: "8px" }}>
          {["all", "queued", "manual", "error"].map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              style={{
                padding: "6px 12px",
                borderRadius: "6px",
                border: "1px solid #cbd5e1",
                backgroundColor: filter === f ? "#2563eb" : "#ffffff",
                color: filter === f ? "#ffffff" : "#475569",
                cursor: "pointer",
                fontWeight: filter === f ? "bold" : "normal",
                textTransform: "capitalize",
              }}
            >
              {f === "all" ? "Tất cả" : f === "queued" ? "Trong hàng đợi" : f === "manual" ? "Manual Mode" : "Lỗi"}
            </button>
          ))}
        </div>
      </div>

      {loading && conversations.length === 0 ? (
        <div>Đang tải danh sách hộp thư...</div>
      ) : conversations.length === 0 ? (
        <div style={{ padding: "30px", backgroundColor: "#ffffff", borderRadius: "8px", textAlign: "center", color: "#64748b" }}>
          Không có cuộc hội thoại nào trong bộ lọc này.
        </div>
      ) : (
        <div style={{ backgroundColor: "#ffffff", borderRadius: "8px", overflow: "hidden", boxShadow: "0 1px 3px rgba(0,0,0,0.1)" }}>
          {conversations.map((item) => (
            <Link
              key={item.conversation.id}
              to={`/inbox/${item.conversation.id}`}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "16px 20px",
                borderBottom: "1px solid #f1f5f9",
                textDecoration: "none",
                color: "inherit",
              }}
            >
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <span style={{ fontWeight: "bold", fontSize: "1rem" }}>
                    {item.customer.name || "Khách hàng không tên"}
                  </span>
                  {item.conversation.manualMode && (
                    <span
                      style={{
                        backgroundColor: "#fef3c7",
                        color: "#92400e",
                        fontSize: "0.75rem",
                        padding: "2px 6px",
                        borderRadius: "4px",
                        fontWeight: "bold",
                      }}
                    >
                      MANUAL
                    </span>
                  )}
                  {item.conversation.isBlocked && (
                    <span
                      style={{
                        backgroundColor: "#fee2e2",
                        color: "#991b1b",
                        fontSize: "0.75rem",
                        padding: "2px 6px",
                        borderRadius: "4px",
                        fontWeight: "bold",
                      }}
                    >
                      BLOCKED
                    </span>
                  )}
                </div>
                <div style={{ fontSize: "0.85rem", color: "#64748b", marginTop: "4px" }}>
                  Inbound Version: {item.conversation.inboundVersion} | Tin đến cuối:{" "}
                  {item.conversation.lastInboundAt ? new Date(item.conversation.lastInboundAt).toLocaleTimeString("vi-VN") : "N/A"}
                </div>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                <span
                  style={{
                    padding: "4px 8px",
                    borderRadius: "4px",
                    fontSize: "0.8rem",
                    fontWeight: "600",
                    backgroundColor:
                      item.conversation.status === "CLAIMED" || item.conversation.status === "TYPING"
                        ? "#dbeafe"
                        : item.conversation.status === "ERROR"
                        ? "#fee2e2"
                        : "#f1f5f9",
                    color:
                      item.conversation.status === "CLAIMED" || item.conversation.status === "TYPING"
                        ? "#1e40af"
                        : item.conversation.status === "ERROR"
                        ? "#991b1b"
                        : "#475569",
                  }}
                >
                  {item.conversation.status}
                </span>
                {item.conversation.unreadCount > 0 && (
                  <span
                    style={{
                      backgroundColor: "#ef4444",
                      color: "#ffffff",
                      fontSize: "0.75rem",
                      padding: "2px 6px",
                      borderRadius: "10px",
                      fontWeight: "bold",
                    }}
                  >
                    {item.conversation.unreadCount}
                  </span>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
};
