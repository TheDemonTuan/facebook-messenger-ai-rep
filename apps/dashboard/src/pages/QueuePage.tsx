import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "../api";
import type { QueueItem } from "../types";
import { ListOrdered, Clock, CheckCircle } from "lucide-react";

export const QueuePage: React.FC = () => {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [loading, setLoading] = useState(true);

  const loadQueue = async () => {
    try {
      const res = await apiFetch<{ items: QueueItem[] }>("/api/queue");
      setItems(res.items);
    } catch {
      // Handled
    } finally {
      setLoading(false);
    }
  };

  const handlePrioritize = async (convId: string) => {
    try {
      await apiFetch(`/api/queue/${convId}/prioritize`, { method: "POST" });
      await loadQueue();
    } catch (err: unknown) {
      alert((err as Error).message);
    }
  };

  useEffect(() => {
    loadQueue();
    const timer = setInterval(loadQueue, 3000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
        <h1 style={{ margin: 0, fontSize: "1.5rem", fontWeight: "bold" }}>Hàng đợi hội thoại (FIFO & Stickiness)</h1>
        <div style={{ fontSize: "0.9rem", color: "#64748b" }}>
          Độ dài hiện tại: <span style={{ fontWeight: "bold", color: "#1e293b" }}>{items.length}</span>
        </div>
      </div>

      {loading && items.length === 0 ? (
        <div>Đang tải hàng đợi...</div>
      ) : items.length === 0 ? (
        <div style={{ padding: "40px", backgroundColor: "#ffffff", borderRadius: "8px", textAlign: "center", color: "#64748b", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
          <CheckCircle size={32} color="#10b981" style={{ margin: "0 auto 8px auto" }} />
          <div>Hàng đợi hiện đang trống. Mọi tin nhắn đã được xử lý xong!</div>
        </div>
      ) : (
        <div style={{ backgroundColor: "#ffffff", borderRadius: "8px", overflowX: "auto", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left", fontSize: "0.9rem" }}>
            <thead>
              <tr style={{ backgroundColor: "#f8fafc", borderBottom: "1px solid #e2e8f0", color: "#64748b" }}>
                <th style={{ padding: "12px 16px" }}>Vị trí</th>
                <th style={{ padding: "12px 16px" }}>Khách hàng</th>
                <th style={{ padding: "12px 16px" }}>Version</th>
                <th style={{ padding: "12px 16px" }}>Tính chất</th>
                <th style={{ padding: "12px 16px" }}>Ready At</th>
                <th style={{ padding: "12px 16px" }}>Ước tính chờ</th>
                <th style={{ padding: "12px 16px" }}>Thao tác</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.queueId} style={{ borderBottom: "1px solid #f1f5f9" }}>
                  <td style={{ padding: "12px 16px", fontWeight: "bold", color: item.position === 1 ? "#2563eb" : "inherit" }}>
                    #{item.position}
                  </td>
                  <td style={{ padding: "12px 16px", fontWeight: "600" }}>{item.customerName || "Khách hàng"}</td>
                  <td style={{ padding: "12px 16px" }}>v{item.inboundVersion}</td>
                  <td style={{ padding: "12px 16px" }}>
                    {item.isSticky ? (
                      <span style={{ backgroundColor: "#dbeafe", color: "#1e40af", padding: "2px 6px", borderRadius: "4px", fontSize: "0.75rem", fontWeight: "bold" }}>
                        STICKY (Turn {item.stickyTurns})
                      </span>
                    ) : (
                      <span style={{ backgroundColor: "#f1f5f9", color: "#475569", padding: "2px 6px", borderRadius: "4px", fontSize: "0.75rem" }}>
                        FIFO
                      </span>
                    )}
                    {item.yieldRequired && (
                      <span style={{ marginLeft: "4px", backgroundColor: "#fee2e2", color: "#991b1b", padding: "2px 6px", borderRadius: "4px", fontSize: "0.75rem" }}>
                        YIELD
                      </span>
                    )}
                  </td>
                  <td style={{ padding: "12px 16px", color: "#64748b" }}>
                    {new Date(item.readyAt).toLocaleTimeString("vi-VN")}
                  </td>
                  <td style={{ padding: "12px 16px", color: "#64748b" }}>~{item.estimatedWaitSeconds}s</td>
                  <td style={{ padding: "12px 16px", display: "flex", gap: "8px", alignItems: "center" }}>
                    <button
                      onClick={() => handlePrioritize(item.conversationId)}
                      style={{
                        backgroundColor: "#2563eb",
                        color: "#ffffff",
                        border: "none",
                        padding: "4px 8px",
                        borderRadius: "4px",
                        fontSize: "0.75rem",
                        fontWeight: "bold",
                        cursor: "pointer",
                      }}
                    >
                      Ưu tiên rep trước
                    </button>
                    <Link
                      to={`/inbox/${item.conversationId}`}
                      style={{ color: "#64748b", textDecoration: "none", fontSize: "0.85rem" }}
                    >
                      Xem
                    </Link>
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
