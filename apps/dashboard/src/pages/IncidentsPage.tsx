import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "../api";
import type { IncidentItem } from "../types";
import {
  AlertTriangle,
  CheckCircle,
  ShieldCheck,
  Cpu,
  RefreshCw,
  CheckCheck,
  ChevronDown,
  ChevronUp,
  Search,
} from "lucide-react";

export const IncidentsPage: React.FC = () => {
  const [incidents, setIncidents] = useState<IncidentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [tabFilter, setTabFilter] = useState<"OPEN" | "ALL" | "RESOLVED">("OPEN");
  const [typeFilter, setTypeFilter] = useState<string>("ALL");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const loadIncidents = async () => {
    setLoading(true);
    try {
      const res = await apiFetch<{ items: IncidentItem[] }>("/api/incidents");
      setIncidents(res.items || []);
    } catch {
      // Handled
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadIncidents();
  }, []);

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleResolve = async (id: string) => {
    const note = prompt("Nhập ghi chú xử lý sự cố (hoặc để trống):", "Đã xử lý");
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

  const handleResolveAll = async () => {
    const openCount = incidents.filter((i) => i.status === "OPEN").length;
    if (openCount === 0) return;
    if (!confirm(`Bạn có chắc chắn muốn giải quyết và đóng TOÀN BỘ ${openCount} sự cố đang mở?`)) {
      return;
    }
    try {
      await apiFetch("/api/incidents/resolve-all", { method: "POST" });
      await loadIncidents();
    } catch (err: unknown) {
      alert((err as Error).message);
    }
  };

  const openCount = incidents.filter((i) => i.status === "OPEN").length;
  const resolvedCount = incidents.filter((i) => i.status === "RESOLVED").length;

  const availableTypes = Array.from(new Set(incidents.map((i) => i.type)));

  // Filter items
  const filteredIncidents = incidents.filter((item) => {
    if (tabFilter === "OPEN" && item.status !== "OPEN") return false;
    if (tabFilter === "RESOLVED" && item.status !== "RESOLVED") return false;
    if (typeFilter !== "ALL" && item.type !== typeFilter) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const matchTitle = item.title.toLowerCase().includes(q);
      const matchDesc = item.description.toLowerCase().includes(q);
      const matchConv = item.conversationId?.toLowerCase().includes(q);
      if (!matchTitle && !matchDesc && !matchConv) return false;
    }
    return true;
  });

  return (
    <div style={{ maxWidth: "100%", overflowX: "hidden" }}>
      {/* Top Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          flexWrap: "wrap",
          gap: "12px",
          marginBottom: "16px",
        }}
      >
        <div>
          <h1 style={{ margin: "0 0 4px 0", fontSize: "1.5rem", fontWeight: "bold" }}>
            Quản lý sự cố (Circuit Breaker & Alerts)
          </h1>
          <div style={{ color: "#64748b", fontSize: "0.85rem" }}>
            Theo dõi, phân tích nguyên nhân và giải quyết các cảnh báo sự cố từ AI, Proxy Gateway và Browser.
          </div>
        </div>

        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          {openCount > 0 && (
            <button
              onClick={handleResolveAll}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "6px",
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
              <CheckCheck size={16} /> Đóng tất cả ({openCount})
            </button>
          )}

          <button
            onClick={loadIncidents}
            disabled={loading}
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
            <RefreshCw size={16} className={loading ? "spin" : ""} />
            Làm mới
          </button>
        </div>
      </div>

      {/* Filter Toolbar */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "12px",
          backgroundColor: "#ffffff",
          padding: "10px 16px",
          borderRadius: "8px",
          boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
          marginBottom: "16px",
        }}
      >
        {/* Status Tabs */}
        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
          <button
            onClick={() => setTabFilter("OPEN")}
            style={{
              padding: "6px 12px",
              borderRadius: "6px",
              border: "none",
              backgroundColor: tabFilter === "OPEN" ? "#ef4444" : "#f1f5f9",
              color: tabFilter === "OPEN" ? "#ffffff" : "#475569",
              fontWeight: "600",
              fontSize: "0.85rem",
              cursor: "pointer",
            }}
          >
            Đang mở ({openCount})
          </button>
          <button
            onClick={() => setTabFilter("ALL")}
            style={{
              padding: "6px 12px",
              borderRadius: "6px",
              border: "none",
              backgroundColor: tabFilter === "ALL" ? "#2563eb" : "#f1f5f9",
              color: tabFilter === "ALL" ? "#ffffff" : "#475569",
              fontWeight: "600",
              fontSize: "0.85rem",
              cursor: "pointer",
            }}
          >
            Tất cả ({incidents.length})
          </button>
          <button
            onClick={() => setTabFilter("RESOLVED")}
            style={{
              padding: "6px 12px",
              borderRadius: "6px",
              border: "none",
              backgroundColor: tabFilter === "RESOLVED" ? "#10b981" : "#f1f5f9",
              color: tabFilter === "RESOLVED" ? "#ffffff" : "#475569",
              fontWeight: "600",
              fontSize: "0.85rem",
              cursor: "pointer",
            }}
          >
            Đã đóng ({resolvedCount})
          </button>
        </div>

        {/* Type Filter & Search */}
        <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap", flex: 1, justifyContent: "flex-end" }}>
          {availableTypes.length > 0 && (
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              style={{
                padding: "6px 10px",
                borderRadius: "6px",
                border: "1px solid #cbd5e1",
                fontSize: "0.85rem",
                color: "#334155",
              }}
            >
              <option value="ALL">Tất cả loại sự cố</option>
              {availableTypes.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          )}

          <div style={{ display: "flex", alignItems: "center", gap: "4px", minWidth: "180px" }}>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Tìm kiếm sự cố..."
              style={{
                width: "100%",
                padding: "6px 10px",
                borderRadius: "6px",
                border: "1px solid #cbd5e1",
                fontSize: "0.85rem",
              }}
            />
          </div>
        </div>
      </div>

      {/* Incidents List */}
      {loading && incidents.length === 0 ? (
        <div style={{ padding: "30px", textAlign: "center", color: "#64748b" }}>Đang tải danh sách sự cố...</div>
      ) : filteredIncidents.length === 0 ? (
        <div
          style={{
            padding: "40px",
            backgroundColor: "#ffffff",
            borderRadius: "8px",
            textAlign: "center",
            color: "#64748b",
            boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
          }}
        >
          <ShieldCheck size={36} color="#10b981" style={{ margin: "0 auto 8px auto" }} />
          <div>Không có sự cố nào phù hợp bộ lọc hiện tại.</div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "12px", width: "100%" }}>
          {filteredIncidents.map((item) => {
            const isExpanded = expandedIds.has(item.id);
            const isLongDesc = item.description.length > 180;
            const displayDesc = isLongDesc && !isExpanded ? item.description.slice(0, 180) + "..." : item.description;

            return (
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
                  alignItems: "flex-start",
                  gap: "16px",
                  boxSizing: "border-box",
                  width: "100%",
                  overflow: "hidden",
                }}
              >
                {/* Left content with strict width constraint and overflow wrapping */}
                <div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", marginBottom: "6px" }}>
                    <span
                      style={{
                        fontWeight: "bold",
                        fontSize: "1rem",
                        color: "#0f172a",
                        wordBreak: "break-word",
                      }}
                    >
                      {item.title}
                    </span>
                    <span
                      style={{
                        backgroundColor: item.status === "OPEN" ? "#fee2e2" : "#dcfce7",
                        color: item.status === "OPEN" ? "#991b1b" : "#166534",
                        fontSize: "0.75rem",
                        padding: "2px 8px",
                        borderRadius: "4px",
                        fontWeight: "bold",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {item.status}
                    </span>
                    <span style={{ fontSize: "0.8rem", color: "#64748b", whiteSpace: "nowrap" }}>
                      Loại: <b>{item.type}</b>
                    </span>
                  </div>

                  {/* Truncated / Expandable Description */}
                  <div
                    style={{
                      fontSize: "0.875rem",
                      color: "#334155",
                      lineHeight: "1.5",
                      wordBreak: "break-word",
                      overflowWrap: "anywhere",
                    }}
                  >
                    {displayDesc}
                    {isLongDesc && (
                      <button
                        onClick={() => toggleExpand(item.id)}
                        style={{
                          background: "none",
                          border: "none",
                          color: "#2563eb",
                          padding: "0 4px",
                          marginLeft: "4px",
                          fontWeight: "600",
                          cursor: "pointer",
                          fontSize: "0.8rem",
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "2px",
                        }}
                      >
                        {isExpanded ? (
                          <>
                            Thu gọn <ChevronUp size={12} />
                          </>
                        ) : (
                          <>
                            Xem thêm <ChevronDown size={12} />
                          </>
                        )}
                      </button>
                    )}
                  </div>

                  {/* Deep link to AI Logs for AI_ERROR */}
                  {item.type === "AI_ERROR" && (
                    <div style={{ marginTop: "10px", display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                      <Link
                        to={item.conversationId ? `/ai-logs?conversationId=${item.conversationId}` : "/ai-logs"}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "6px",
                          fontSize: "0.8rem",
                          color: "#1e40af",
                          textDecoration: "none",
                          fontWeight: "600",
                          backgroundColor: "#eff6ff",
                          padding: "4px 10px",
                          borderRadius: "4px",
                          border: "1px solid #bfdbfe",
                          maxWidth: "100%",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        <Cpu size={14} /> Xem chi tiết tin nhắn gửi lên AI Proxy & Raw Response
                      </Link>
                    </div>
                  )}

                  {/* Collapsible Raw Response */}
                  {item.metadata?.rawResponse && (
                    <details style={{ marginTop: "8px", fontSize: "0.8rem", maxWidth: "100%" }}>
                      <summary style={{ cursor: "pointer", color: "#64748b", fontWeight: "500" }}>
                        Xem trước phản hồi thô (Raw Response)
                      </summary>
                      <pre
                        style={{
                          marginTop: "6px",
                          padding: "8px 12px",
                          backgroundColor: "#0f172a",
                          color: "#e2e8f0",
                          borderRadius: "6px",
                          overflowX: "auto",
                          maxHeight: "140px",
                          fontSize: "0.75rem",
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-word",
                          overflowWrap: "anywhere",
                          maxWidth: "100%",
                          lineHeight: "1.4",
                        }}
                      >
                        {item.metadata.rawResponse}
                      </pre>
                    </details>
                  )}

                  <div style={{ fontSize: "0.75rem", color: "#94a3b8", marginTop: "8px" }}>
                    Thời gian: {new Date(item.createdAt).toLocaleString("vi-VN")}
                    {item.conversationId && (
                      <span>
                        {" "}
                        | Hội thoại:{" "}
                        <Link
                          to={`/inbox/${item.conversationId}`}
                          style={{ color: "#64748b", textDecoration: "underline" }}
                        >
                          {item.conversationId}
                        </Link>
                      </span>
                    )}
                  </div>
                </div>

                {/* Right Action Button */}
                <div style={{ flexShrink: 0, display: "flex", flexDirection: "column", gap: "6px", alignItems: "flex-end" }}>
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
                        whiteSpace: "nowrap",
                        display: "flex",
                        alignItems: "center",
                        gap: "4px",
                      }}
                    >
                      <CheckCircle size={14} /> Giải quyết & Đóng
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
