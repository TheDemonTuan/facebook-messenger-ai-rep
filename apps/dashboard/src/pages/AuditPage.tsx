import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "../api";
import { Search, Loader2, AlertCircle, Shield } from "lucide-react";

interface AuditEventItem {
  id: string;
  type: string;
  actor?: string | null;
  conversationId?: string | null;
  inboundVersion?: number | null;
  payload?: Record<string, unknown> | null;
  createdAt: string;
}

export const AuditPage: React.FC = () => {
  const [events, setEvents] = useState<AuditEventItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterConvId, setFilterConvId] = useState("");

  const loadAudit = async (convId?: string) => {
    setLoading(true);
    setError(null);
    try {
      const url = convId ? `/api/audit?conversationId=${encodeURIComponent(convId)}&limit=100` : "/api/audit?limit=100";
      const res = await apiFetch<{ items?: AuditEventItem[]; events?: AuditEventItem[] }>(url);
      setEvents(res.items || res.events || []);
    } catch (err: unknown) {
      setError((err as Error).message || "Không thể tải nhật ký kiểm toán");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAudit();
  }, []);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    loadAudit(filterConvId.trim());
  };

  const formatEventType = (type: string) => {
    switch (type) {
      case "SETTINGS_UPDATE":
        return "Cập nhật cài đặt";
      case "CHANNEL_PAUSED":
        return "Tạm dừng kênh";
      case "CHANNEL_RESUMED":
        return "Tiếp tục kênh";
      case "TAKEOVER_STARTED":
        return "Tiếp quản thủ công";
      case "TAKEOVER_RELEASED":
        return "Chuyển lại cho AI";
      case "MANUAL_MESSAGE_SENT":
        return "Gửi tin thủ công";
      case "INCIDENT_CREATED":
        return "Phát sinh sự cố";
      case "INCIDENT_RESOLVED":
        return "Giải quyết sự cố";
      case "ACTION_RECONCILED":
        return "Xác nhận gửi tin";
      case "AI_RUN":
        return "AI xử lý";
      case "INBOUND_MESSAGE":
        return "Tin nhắn đến";
      default:
        return type.replace(/_/g, " ").toLowerCase();
    }
  };

  const formatActor = (actor?: string | null) => {
    if (!actor || actor === "SYSTEM") return "Hệ thống";
    if (actor === "AI") return "Trợ lý AI";
    if (actor === "OWNER") return "Chủ sở hữu";
    if (actor === "OPERATOR") return "Quản trị viên";
    return actor;
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px" }}>
        <div>
          <h1 style={{ margin: "0 0 4px 0", fontSize: "1.5rem", fontWeight: "bold", color: "#0f172a" }}>
            Nhật ký hoạt động
          </h1>
          <div style={{ fontSize: "0.85rem", color: "#64748b" }}>
            Lịch sử ghi nhận các sự kiện hệ thống, thay đổi cài đặt và quá trình xử lý tin nhắn
          </div>
        </div>
      </div>

      {/* Filter by Conversation ID */}
      <form onSubmit={handleSearch} style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
        <input
          type="text"
          placeholder="Tìm theo mã hội thoại..."
          value={filterConvId}
          onChange={(e) => setFilterConvId(e.target.value)}
          style={{
            padding: "8px 12px",
            borderRadius: "6px",
            border: "1px solid #cbd5e1",
            fontSize: "0.85rem",
            width: "280px",
            outline: "none",
          }}
        />
        <button
          type="submit"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "6px",
            padding: "8px 14px",
            backgroundColor: "#2563eb",
            color: "#ffffff",
            border: "none",
            borderRadius: "6px",
            fontSize: "0.85rem",
            fontWeight: "600",
            cursor: "pointer",
          }}
        >
          <Search size={14} /> Lọc
        </button>
        {filterConvId && (
          <button
            type="button"
            onClick={() => {
              setFilterConvId("");
              loadAudit();
            }}
            style={{
              padding: "8px 12px",
              backgroundColor: "#f1f5f9",
              border: "1px solid #cbd5e1",
              borderRadius: "6px",
              fontSize: "0.85rem",
              cursor: "pointer",
            }}
          >
            Xóa lọc
          </button>
        )}
      </form>

      {/* Error state */}
      {error && (
        <div style={{ display: "flex", alignItems: "center", gap: "8px", padding: "14px", backgroundColor: "#fef2f2", border: "1px solid #fecaca", borderRadius: "8px", color: "#991b1b", fontSize: "0.9rem" }}>
          <AlertCircle size={18} />
          <span>{error}</span>
          <button onClick={() => loadAudit(filterConvId)} style={{ marginLeft: "auto", padding: "4px 10px", backgroundColor: "#dc2626", color: "#fff", border: "none", borderRadius: "4px", cursor: "pointer" }}>Thử lại</button>
        </div>
      )}

      {/* Loading state */}
      {loading && events.length === 0 ? (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "200px", gap: "10px", color: "#64748b" }}>
          <Loader2 size={22} className="animate-spin" />
          <span>Đang tải nhật ký kiểm toán...</span>
        </div>
      ) : events.length === 0 ? (
        <div style={{ padding: "40px", backgroundColor: "#ffffff", borderRadius: "8px", textAlign: "center", color: "#64748b", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
          <Shield size={32} color="#94a3b8" style={{ margin: "0 auto 8px auto" }} />
          <div>Không có sự kiện kiểm toán nào</div>
        </div>
      ) : (
        <div style={{ backgroundColor: "#ffffff", borderRadius: "8px", overflowX: "auto", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left", fontSize: "0.85rem" }}>
            <thead>
              <tr style={{ backgroundColor: "#f8fafc", borderBottom: "1px solid #e2e8f0", color: "#64748b" }}>
                <th style={{ padding: "10px 14px" }}>Thời gian</th>
                <th style={{ padding: "10px 14px" }}>Loại sự kiện</th>
                <th style={{ padding: "10px 14px" }}>Người thực hiện</th>
                <th style={{ padding: "10px 14px" }}>Hội thoại</th>
                <th style={{ padding: "10px 14px" }}>Phiên bản</th>
                <th style={{ padding: "10px 14px" }}>Chi tiết sự kiện</th>
              </tr>
            </thead>
            <tbody>
              {events.map((ev) => (
                <tr key={ev.id} style={{ borderBottom: "1px solid #f1f5f9" }}>
                  <td style={{ padding: "10px 14px", color: "#64748b", fontSize: "0.8rem", whiteSpace: "nowrap" }}>
                    {new Date(ev.createdAt).toLocaleString("vi-VN")}
                  </td>
                  <td style={{ padding: "10px 14px", fontWeight: "600", color: "#1e293b" }}>{formatEventType(ev.type)}</td>
                  <td style={{ padding: "10px 14px", color: "#334155" }}>{formatActor(ev.actor)}</td>
                  <td style={{ padding: "10px 14px", color: "#64748b", fontSize: "0.8rem" }}>
                    {ev.conversationId ? (
                      <Link
                        to={`/inbox/${ev.conversationId}`}
                        style={{ color: "#2563eb", textDecoration: "none", fontWeight: "600" }}
                      >
                        Xem hội thoại
                      </Link>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td style={{ padding: "10px 14px" }}>{ev.inboundVersion !== null ? `v${ev.inboundVersion}` : "—"}</td>
                  <td style={{ padding: "10px 14px" }}>
                    {ev.payload && Object.keys(ev.payload).length > 0 ? (
                      <details>
                        <summary style={{ cursor: "pointer", fontSize: "0.75rem", color: "#2563eb", fontWeight: "500" }}>
                          Chi tiết kỹ thuật
                        </summary>
                        <pre style={{ margin: "4px 0 0 0", fontSize: "0.72rem", backgroundColor: "#0f172a", color: "#e2e8f0", padding: "6px 8px", borderRadius: "4px", maxWidth: "350px", overflowX: "auto" }}>
                          {JSON.stringify(ev.payload, null, 2)}
                        </pre>
                      </details>
                    ) : (
                      <span style={{ color: "#94a3b8", fontSize: "0.75rem" }}>—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
