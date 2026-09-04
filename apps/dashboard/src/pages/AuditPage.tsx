import React, { useEffect, useState } from "react";
import { apiFetch } from "../api";
import { Download, Search } from "lucide-react";

export const AuditPage: React.FC = () => {
  const [events, setEvents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterConvId, setFilterConvId] = useState("");

  const loadAudit = async (convId?: string) => {
    setLoading(true);
    try {
      const url = convId ? `/api/audit?conversationId=${convId}&limit=100` : "/api/audit?limit=100";
      const res = await apiFetch<{ events: any[] }>(url);
      setEvents(res.events);
    } catch {
      // Handled
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

  const handleDownloadCsv = () => {
    const url = filterConvId.trim()
      ? `/api/audit/csv?conversationId=${filterConvId.trim()}`
      : "/api/audit/csv";
    window.open(url, "_blank");
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
        <h1 style={{ margin: 0, fontSize: "1.5rem", fontWeight: "bold" }}>Nhật ký kiểm toán (Audit Trail)</h1>
        <button
          onClick={handleDownloadCsv}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "6px",
            backgroundColor: "#ffffff",
            border: "1px solid #cbd5e1",
            padding: "8px 14px",
            borderRadius: "6px",
            cursor: "pointer",
            fontWeight: "600",
            fontSize: "0.85rem",
          }}
        >
          <Download size={16} /> Tải CSV
        </button>
      </div>

      {/* Filter by Conversation ID */}
      <form onSubmit={handleSearch} style={{ display: "flex", gap: "8px", marginBottom: "16px" }}>
        <input
          type="text"
          value={filterConvId}
          onChange={(e) => setFilterConvId(e.target.value)}
          placeholder="Lọc theo Conversation ID..."
          style={{
            flex: 1,
            maxWidth: "400px",
            padding: "8px 12px",
            borderRadius: "6px",
            border: "1px solid #cbd5e1",
            fontSize: "0.9rem",
          }}
        />
        <button
          type="submit"
          style={{
            backgroundColor: "#2563eb",
            color: "#ffffff",
            border: "none",
            borderRadius: "6px",
            padding: "0 16px",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: "6px",
            fontWeight: "600",
          }}
        >
          <Search size={16} /> Lọc
        </button>
      </form>

      {loading && events.length === 0 ? (
        <div>Đang tải nhật ký...</div>
      ) : events.length === 0 ? (
        <div style={{ padding: "40px", backgroundColor: "#ffffff", borderRadius: "8px", textAlign: "center", color: "#64748b" }}>
          Không có sự kiện nào phù hợp.
        </div>
      ) : (
        <div style={{ backgroundColor: "#ffffff", borderRadius: "8px", overflowX: "auto", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left", fontSize: "0.85rem" }}>
            <thead>
              <tr style={{ backgroundColor: "#f8fafc", borderBottom: "1px solid #e2e8f0", color: "#64748b" }}>
                <th style={{ padding: "10px 14px" }}>Thời gian</th>
                <th style={{ padding: "10px 14px" }}>Loại sự kiện</th>
                <th style={{ padding: "10px 14px" }}>Tác tử (Actor)</th>
                <th style={{ padding: "10px 14px" }}>Version</th>
                <th style={{ padding: "10px 14px" }}>Chi tiết</th>
              </tr>
            </thead>
            <tbody>
              {events.map((ev) => (
                <tr key={ev.id} style={{ borderBottom: "1px solid #f1f5f9" }}>
                  <td style={{ padding: "10px 14px", whiteSpace: "nowrap", color: "#64748b" }}>
                    {new Date(ev.createdAt).toLocaleString("vi-VN")}
                  </td>
                  <td style={{ padding: "10px 14px", fontWeight: "600" }}>{ev.type}</td>
                  <td style={{ padding: "10px 14px", color: "#2563eb" }}>{ev.actor}</td>
                  <td style={{ padding: "10px 14px" }}>{ev.inboundVersion !== null ? `v${ev.inboundVersion}` : "-"}</td>
                  <td style={{ padding: "10px 14px", fontFamily: "monospace", fontSize: "0.75rem", maxWidth: "400px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {JSON.stringify(ev.payload)}
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
