import React, { useEffect, useState, useCallback, useRef } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "../api";
import type { ConversationItem, PaginatedInboxResponse } from "../types";
import { buildInboxQuery, mergePaginatedConversations } from "../helpers/pagination";
import { shouldRefetchInbox } from "../helpers/sse-helpers";
import { useSseWakeup } from "../context/SseContext";
import {
  MessageSquare,
  Clock,
  User,
  AlertCircle,
  RefreshCw,
  Loader2,
  ChevronRight,
  Shield,
  Bot,
  UserCheck,
} from "lucide-react";

const PAGE_SIZE = 20;

export const InboxPage: React.FC = () => {
  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  const [filter, setFilter] = useState<string>("all");
  const [loading, setLoading] = useState<boolean>(true);
  const [loadingMore, setLoadingMore] = useState<boolean>(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState<boolean>(false);
  const [totalCount, setTotalCount] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);

  const filterRef = useRef(filter);
  filterRef.current = filter;

  const loadInbox = useCallback(async (selectedFilter: string, cursor: string | null = null, append = false) => {
    if (append) {
      setLoadingMore(true);
    } else {
      setLoading(true);
    }
    setError(null);

    try {
      const query = buildInboxQuery({
        filter: selectedFilter,
        limit: PAGE_SIZE,
        cursor: cursor || undefined,
      });

      const res = await apiFetch<PaginatedInboxResponse>(`/api/inbox${query}`);
      const newItems = res.conversations || [];

      if (append) {
        setConversations((prev) => mergePaginatedConversations(prev, newItems));
      } else {
        setConversations(newItems);
      }

      setNextCursor(res.nextCursor || null);
      setHasMore(Boolean(res.hasMore && res.nextCursor));
      setTotalCount(res.total || 0);
    } catch (err: unknown) {
      setError((err as Error).message || "Không thể tải danh sách hội thoại");
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    loadInbox(filter, null, false);
  }, [filter, loadInbox]);

  // SSE wakeup: refetch current filter on matching inbound/conversation events without poll duplication
  useSseWakeup(shouldRefetchInbox, () => {
    loadInbox(filterRef.current, null, false);
  });

  const handleLoadMore = () => {
    if (!loadingMore && hasMore && nextCursor) {
      loadInbox(filter, nextCursor, true);
    }
  };

  const getStatusBadge = (conv: ConversationItem["conversation"]) => {
    if (conv.isBlocked) {
      return (
        <span style={{ backgroundColor: "#fecaca", color: "#991b1b", padding: "2px 8px", borderRadius: "4px", fontSize: "0.75rem", fontWeight: "700" }}>
          ĐÃ CHẶN
        </span>
      );
    }
    if (conv.manualMode) {
      return (
        <span style={{ backgroundColor: "#fef3c7", color: "#92400e", padding: "2px 8px", borderRadius: "4px", fontSize: "0.75rem", fontWeight: "700", display: "inline-flex", alignItems: "center", gap: "3px" }}>
          <UserCheck size={12} /> THỦ CÔNG
        </span>
      );
    }
    switch (conv.status) {
      case "QUEUED":
      case "DEBOUNCING":
        return (
          <span style={{ backgroundColor: "#dbeafe", color: "#1e40af", padding: "2px 8px", borderRadius: "4px", fontSize: "0.75rem", fontWeight: "700" }}>
            ĐANG CHỜ XỬ LÝ
          </span>
        );
      case "READING":
      case "THINKING":
      case "DRAFT_READY":
      case "TYPING":
      case "SENDING":
        return (
          <span style={{ backgroundColor: "#e0e7ff", color: "#3730a3", padding: "2px 8px", borderRadius: "4px", fontSize: "0.75rem", fontWeight: "700", display: "inline-flex", alignItems: "center", gap: "3px" }}>
            <Bot size={12} /> BOT ĐANG TRẢ LỜI
          </span>
        );
      case "ERROR":
        return (
          <span style={{ backgroundColor: "#fee2e2", color: "#991b1b", padding: "2px 8px", borderRadius: "4px", fontSize: "0.75rem", fontWeight: "700" }}>
            LỖI
          </span>
        );
      default:
        return (
          <span style={{ backgroundColor: "#f1f5f9", color: "#475569", padding: "2px 8px", borderRadius: "4px", fontSize: "0.75rem" }}>
            CHỜ KHÁCH HỎI
          </span>
        );
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px", maxWidth: "100%" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px" }}>
        <div>
          <h1 style={{ margin: "0 0 4px 0", fontSize: "1.5rem", fontWeight: "bold" }}>Hộp thư khách hàng</h1>
          <div style={{ fontSize: "0.85rem", color: "#64748b" }}>
            Tổng cộng: <strong style={{ color: "#1e293b" }}>{totalCount}</strong> cuộc hội thoại
          </div>
        </div>

        {/* Filter buttons */}
        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
          {[
            { id: "all", label: "Tất cả" },
            { id: "queued", label: "Trong hàng đợi" },
            { id: "manual", label: "Thủ công (Takeover)" },
            { id: "error", label: "Sự cố / Lỗi" },
          ].map((item) => (
            <button
              key={item.id}
              onClick={() => setFilter(item.id)}
              style={{
                padding: "6px 14px",
                borderRadius: "6px",
                border: "1px solid #cbd5e1",
                backgroundColor: filter === item.id ? "#2563eb" : "#ffffff",
                color: filter === item.id ? "#ffffff" : "#475569",
                cursor: "pointer",
                fontWeight: filter === item.id ? "700" : "500",
                fontSize: "0.85rem",
                transition: "all 0.15s",
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {/* Error state */}
      {error && (
        <div style={{ display: "flex", alignItems: "center", gap: "8px", padding: "14px", backgroundColor: "#fef2f2", border: "1px solid #fecaca", borderRadius: "8px", color: "#991b1b", fontSize: "0.9rem" }}>
          <AlertCircle size={18} />
          <span>{error}</span>
          <button
            onClick={() => loadInbox(filter, null, false)}
            style={{ marginLeft: "auto", padding: "4px 10px", backgroundColor: "#dc2626", color: "#fff", border: "none", borderRadius: "4px", cursor: "pointer", fontSize: "0.8rem" }}
          >
            Thử lại
          </button>
        </div>
      )}

      {/* Loading state (initial) */}
      {loading && conversations.length === 0 ? (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "240px", gap: "10px", color: "#64748b" }}>
          <Loader2 size={22} className="animate-spin" />
          <span>Đang tải danh sách tin nhắn...</span>
        </div>
      ) : conversations.length === 0 ? (
        /* Empty state */
        <div style={{ padding: "48px 20px", backgroundColor: "#ffffff", borderRadius: "10px", textAlign: "center", color: "#64748b", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
          <MessageSquare size={36} color="#94a3b8" style={{ margin: "0 auto 12px auto" }} />
          <h3 style={{ margin: "0 0 6px 0", color: "#1e293b", fontSize: "1.1rem" }}>Không có cuộc hội thoại nào</h3>
          <p style={{ margin: 0, fontSize: "0.85rem" }}>
            {filter === "all"
              ? "Chưa có tin nhắn nào được ghi nhận vào hệ thống."
              : "Không có cuộc hội thoại nào khớp với bộ lọc đã chọn."}
          </p>
        </div>
      ) : (
        /* Conversation list */
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {conversations.map((item) => (
            <Link
              key={item.conversation.id}
              to={`/inbox/${item.conversation.id}`}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "14px 18px",
                backgroundColor: "#ffffff",
                borderRadius: "8px",
                border: "1px solid #e2e8f0",
                textDecoration: "none",
                color: "inherit",
                boxShadow: "0 1px 2px rgba(0,0,0,0.03)",
                transition: "border-color 0.15s, box-shadow 0.15s",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "14px", minWidth: 0 }}>
                {/* Avatar */}
                <div
                  style={{
                    width: "42px",
                    height: "42px",
                    borderRadius: "50%",
                    backgroundColor: "#e2e8f0",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                    overflow: "hidden",
                  }}
                >
                  {item.customer.avatarUrl ? (
                    <img src={item.customer.avatarUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  ) : (
                    <User size={20} color="#64748b" />
                  )}
                </div>

                {/* Conversation Info */}
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                    <span style={{ fontWeight: "700", fontSize: "0.95rem", color: "#0f172a" }}>
                      {item.customer.name || "Khách hàng Messenger"}
                    </span>
                    {getStatusBadge(item.conversation)}
                    <span style={{ fontSize: "0.75rem", color: "#64748b" }}>
                      v{item.conversation.inboundVersion}
                    </span>
                  </div>

                  <div style={{ fontSize: "0.8rem", color: "#64748b", marginTop: "4px", display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
                    <span>ID: {item.conversation.id.slice(0, 8)}...</span>
                    {item.conversation.lastInboundAt && (
                      <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                        <Clock size={12} /> Tin cuối: {new Date(item.conversation.lastInboundAt).toLocaleString("vi-VN")}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: "10px", flexShrink: 0 }}>
                {item.conversation.unreadCount > 0 && (
                  <span style={{ backgroundColor: "#2563eb", color: "#fff", padding: "2px 8px", borderRadius: "10px", fontSize: "0.75rem", fontWeight: "bold" }}>
                    {item.conversation.unreadCount}
                  </span>
                )}
                <ChevronRight size={18} color="#94a3b8" />
              </div>
            </Link>
          ))}

          {/* Cursor pagination: Load More button */}
          {hasMore && (
            <div style={{ display: "flex", justifyContent: "center", marginTop: "12px" }}>
              <button
                onClick={handleLoadMore}
                disabled={loadingMore}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  padding: "10px 24px",
                  borderRadius: "8px",
                  backgroundColor: "#ffffff",
                  border: "1px solid #cbd5e1",
                  color: "#1e293b",
                  fontWeight: "600",
                  fontSize: "0.9rem",
                  cursor: loadingMore ? "not-allowed" : "pointer",
                  boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
                }}
              >
                {loadingMore ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    <span>Đang tải thêm...</span>
                  </>
                ) : (
                  <>
                    <RefreshCw size={16} />
                    <span>Tải thêm hội thoại</span>
                  </>
                )}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
