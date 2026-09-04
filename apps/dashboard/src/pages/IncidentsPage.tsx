import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "../api";
import type { IncidentItem } from "../types";
import { AlertTriangle, CheckCircle, ShieldCheck, Cpu, ExternalLink } from "lucide-react";

export const IncidentsPage: React.FC = () => {
  const [incidents, setIncidents] = useState<IncidentItem[]>([]);
  const [loading, setLoading] = useState(true);

  const loadIncidents = async () => {
    try {
      const res = await apiFetch<{ items: IncidentItem[] }>("/api/incidents");
      setIncidents(res.items);
    } catch {
      // Handled
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadIncidents();
  }, []);

  const handleResolve = async (id: string) => {
    const note = prompt("Nhập ghi chú xử lý sự cố:");
    if (note === null) return;
    try {
      await apiFetch(`/api/incidents/${id}/resolve`, {
        method: "POST",
        body: JSON.stringify({ resolutionNote: note }),
      });
      await loadIncidents();
    } catch (err: unknown) {
      alert((err as Error).message);
    }
  };

  return (
    <div>
      <h1 style={{ margin: "0 0 16px 0", fontSize: "1.5rem", fontWeight: "bold" }}>Quản lý sự cố (Circuit Breaker & Alerts)</h1>

      {loading && incidents.length === 0 ? (
        <div>Đang tải danh sách sự cố...</div>
      ) : incidents.length === 0 ? (
        <div style={{ padding: "40px", backgroundColor: "#ffffff", borderRadius: "8px", textAlign: "center", color: "#64748b", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
          <ShieldCheck size={36} color="#10b981" style={{ margin: "0 auto 8px auto" }} />
          <div>Không có sự cố nào đang mở. Mọi thành phần đều ổn định!</div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          {incidents.map((item) => (
            <div
              key={item.id}
              style={{
                backgroundColor: "#ffffff",
                borderRadius: "8px",
                padding: "16px 20px",
                borderLeft: `4px solid ${item.status === "OPEN" ? "#ef4444" : "#10b981"}`,
                boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <span style={{ fontWeight: "bold", fontSize: "1rem" }}>{item.title}</span>
                  <span
                    style={{
                      backgroundColor: item.status === "OPEN" ? "#fee2e2" : "#dcfce7",
                      color: item.status === "OPEN" ? "#991b1b" : "#166534",
                      fontSize: "0.75rem",
                      padding: "2px 6px",
                      borderRadius: "4px",
                      fontWeight: "bold",
                    }}
                  >
                    {item.status}
                  </span>
                  <span style={{ fontSize: "0.8rem", color: "#64748b" }}>Loại: {item.type}</span>
                </div>
                <div style={{ fontSize: "0.9rem", color: "#334155", marginTop: "6px" }}>{item.description}</div>
                
                {item.type === "AI_ERROR" && (
                  <div style={{ marginTop: "8px", display: "flex", alignItems: "center", gap: "10px" }}>
                    <Link
                      to={item.conversationId ? `/ai-logs?conversationId=${item.conversationId}` : "/ai-logs"}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "4px",
                        fontSize: "0.8rem",
                        color: "#2563eb",
                        textDecoration: "none",
                        fontWeight: "600",
                        backgroundColor: "#eff6ff",
                        padding: "3px 8px",
                        borderRadius: "4px",
                        border: "1px solid #bfdbfe",
                      }}
                    >
                      <Cpu size={14} /> Xem chi tiết tin nhắn gửi lên AI Proxy & Raw Response
                    </Link>
                  </div>
                )}

                {item.metadata?.rawResponse && (
                  <details style={{ marginTop: "6px", fontSize: "0.8rem" }}>
                    <summary style={{ cursor: "pointer", color: "#64748b" }}>Xem trước Raw Response</summary>
                    <pre
                      style={{
                        marginTop: "4px",
                        padding: "8px",
                        backgroundColor: "#0f172a",
                        color: "#e2e8f0",
                        borderRadius: "4px",
                        overflowX: "auto",
                        maxHeight: "140px",
                        fontSize: "0.75rem",
                      }}
                    >
                      {item.metadata.rawResponse}
                    </pre>
                  </details>
                )}

                <div style={{ fontSize: "0.75rem", color: "#94a3b8", marginTop: "6px" }}>
                  Thời gian: {new Date(item.createdAt).toLocaleString("vi-VN")}
                </div>
              </div>

              {item.status === "OPEN" && (
                <button
                  onClick={() => handleResolve(item.id)}
                  style={{
                    backgroundColor: "#10b981",
                    color: "#ffffff",
                    border: "none",
                    padding: "8px 14px",
                    borderRadius: "6px",
                    fontWeight: "600",
                    cursor: "pointer",
                    fontSize: "0.85rem",
                  }}
                >
                  Giải quyết & Đóng
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
