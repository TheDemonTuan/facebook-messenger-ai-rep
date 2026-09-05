import React, { useEffect, useState, useMemo } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "../api";
import type { IncidentItem } from "../types";
import {
  isSendUncertain,
  isCheckpoint,
  isDomDegraded,
  getIncidentSafetyPolicy,
} from "../helpers/incident-helpers";
import { shouldRefetchIncidents } from "../helpers/sse-helpers";
import { useSseWakeup } from "../context/SseContext";
import {
  AlertTriangle,
  CheckCircle,
  ShieldAlert,
  RefreshCw,
  CheckCheck,
  ChevronDown,
  ChevronUp,
  Search,
  ExternalLink,
  ShieldCheck,
  Check,
  Loader2,
  AlertOctagon,
} from "lucide-react";

export const IncidentsPage: React.FC = () => {
  const [incidents, setIncidents] = useState<IncidentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tabFilter, setTabFilter] = useState<"OPEN" | "ALL" | "RESOLVED">("OPEN");
  const [typeFilter, setTypeFilter] = useState<string>("ALL");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);

  const loadIncidents = async () => {
    setError(null);
    try {
      const res = await apiFetch<{ items: IncidentItem[] }>("/api/incidents?limit=100");
      setIncidents(res.items || []);
    } catch (err: unknown) {
      setError((err as Error).message || "Không thể tải danh sách sự cố");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadIncidents();
  }, []);

  // SSE wakeup: refetches only on incident:resolved, outbound:uncertain, channel:status
  useSseWakeup(shouldRefetchIncidents, loadIncidents);

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleResolve = async (id: string, defaultNote = "Đã xử lý") => {
    const note = prompt("Nhập ghi chú xử lý sự cố (hoặc để trống):", defaultNote);
    if (note === null) return;

    setActionInProgress(id);
    try {
      await apiFetch(`/api/incidents/${id}/resolve`, {
        method: "POST",
        body: JSON.stringify({ resolutionNote: note }),
      });
      await loadIncidents();
    } catch (err: unknown) {
      alert((err as Error).message);
    } finally {
      setActionInProgress(null);
    }
  };

  const handleResolveCheckpointOrDom = async (id: string, actionType: "CHECKPOINT" | "DOM") => {
    const note =
      actionType === "CHECKPOINT"
        ? "Đã xử lý Checkpoint qua trình duyệt, khôi phục kênh"
        : "Đã kiểm tra DOM và khôi phục kênh";

    setActionInProgress(id);
    try {
      // Resume channel if suspended
      await apiFetch("/api/channel/resume", { method: "POST" }).catch(() => {});
      // Resolve incident
      await apiFetch(`/api/incidents/${id}/resolve`, {
        method: "POST",
        body: JSON.stringify({ resolutionNote: note }),
      });
      await loadIncidents();
    } catch (err: unknown) {
      alert((err as Error).message);
    } finally {
      setActionInProgress(null);
    }
  };

  const handleResolveAll = async () => {
    const openCount = incidents.filter((i) => i.status === "OPEN").length;
    if (openCount === 0) return;
    if (!confirm(`Bạn có chắc muốn đóng và giải quyết TOÀN BỘ ${openCount} sự cố đang mở?`)) {
      return;
    }

    try {
      await apiFetch("/api/incidents/resolve-all", { method: "POST" });
      await loadIncidents();
    } catch (err: unknown) {
      alert((err as Error).message);
    }
  };

  const openCount = useMemo(() => incidents.filter((i) => i.status === "OPEN").length, [incidents]);
  const resolvedCount = useMemo(() => incidents.filter((i) => i.status === "RESOLVED").length, [incidents]);
  const availableTypes = useMemo(() => Array.from(new Set(incidents.map((i) => i.type))), [incidents]);

  const filteredIncidents = useMemo(() => {
    return incidents.filter((item) => {
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
  }, [incidents, tabFilter, typeFilter, searchQuery]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px", maxWidth: "100%", overflowX: "hidden" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "12px" }}>
        <div>
          <h1 style={{ margin: "0 0 4px 0", fontSize: "1.5rem", fontWeight: "bold" }}>
            Quản lý Sự cố & Giám sát An toàn (Circuit Breakers)
          </h1>
          <div style={{ fontSize: "0.85rem", color: "#64748b" }}>
            Xử lý fail-closed cho SEND_UNCERTAIN, Checkpoint Facebook và sự cố DOM mà không thử lại mù quáng (No Blind Retry)
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
                padding: "8px 14px",
                borderRadius: "6px",
                border: "none",
                fontWeight: "600",
                fontSize: "0.85rem",
                cursor: "pointer",
              }}
            >
              <CheckCheck size={16} /> Đóng tất cả ({openCount})
            </button>
          )}

          <button
            onClick={loadIncidents}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "6px",
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

      {/* Tabs & Search Filter */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px", borderBottom: "1px solid #e2e8f0", paddingBottom: "10px" }}>
        <div style={{ display: "flex", gap: "8px" }}>
          {[
            { id: "OPEN", label: `Đang mở (${openCount})` },
            { id: "ALL", label: `Tất cả (${incidents.length})` },
            { id: "RESOLVED", label: `Đã đóng (${resolvedCount})` },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setTabFilter(tab.id as any)}
              style={{
                padding: "6px 14px",
                borderRadius: "6px",
                border: "none",
                backgroundColor: tabFilter === tab.id ? "#2563eb" : "transparent",
                color: tabFilter === tab.id ? "#ffffff" : "#475569",
                fontWeight: tabFilter === tab.id ? "700" : "500",
                fontSize: "0.85rem",
                cursor: "pointer",
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Search */}
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <div style={{ position: "relative" }}>
            <Search size={14} style={{ position: "absolute", left: "10px", top: "50%", transform: "translateY(-50%)", color: "#94a3b8" }} />
            <input
              type="text"
              placeholder="Tìm kiếm sự cố..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{ padding: "6px 10px 6px 30px", borderRadius: "6px", border: "1px solid #cbd5e1", fontSize: "0.85rem", outline: "none", width: "180px" }}
            />
          </div>

          {availableTypes.length > 0 && (
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              style={{ padding: "6px 10px", borderRadius: "6px", border: "1px solid #cbd5e1", fontSize: "0.85rem", backgroundColor: "#ffffff" }}
            >
              <option value="ALL">Tất cả loại sự cố</option>
              {availableTypes.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          )}
        </div>
      </div>

      {/* Error state */}
      {error && (
        <div style={{ display: "flex", alignItems: "center", gap: "8px", padding: "14px", backgroundColor: "#fef2f2", border: "1px solid #fecaca", borderRadius: "8px", color: "#991b1b", fontSize: "0.9rem" }}>
          <AlertTriangle size={18} />
          <span>{error}</span>
          <button onClick={loadIncidents} style={{ marginLeft: "auto", padding: "4px 10px", backgroundColor: "#dc2626", color: "#fff", border: "none", borderRadius: "4px", cursor: "pointer" }}>Thử lại</button>
        </div>
      )}

      {/* Loading state */}
      {loading && incidents.length === 0 ? (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "240px", gap: "10px", color: "#64748b" }}>
          <Loader2 size={22} className="animate-spin" />
          <span>Đang tải danh sách sự cố...</span>
        </div>
      ) : filteredIncidents.length === 0 ? (
        /* Empty state */
        <div style={{ padding: "48px 20px", backgroundColor: "#ffffff", borderRadius: "10px", textAlign: "center", color: "#64748b", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
          <CheckCircle size={36} color="#10b981" style={{ margin: "0 auto 12px auto" }} />
          <h3 style={{ margin: "0 0 6px 0", color: "#1e293b", fontSize: "1.1rem" }}>Không có sự cố nào cần xử lý</h3>
          <p style={{ margin: 0, fontSize: "0.85rem" }}>
            Tất cả các cơ chế an toàn, fail-closed và kết nối kênh đều đang hoạt động bình thường.
          </p>
        </div>
      ) : (
        /* Incident list */
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          {filteredIncidents.map((incident) => {
            const isExpanded = expandedIds.has(incident.id);
            const isSendUnc = isSendUncertain(incident);
            const isCp = isCheckpoint(incident);
            const isDom = isDomDegraded(incident);
            const policy = getIncidentSafetyPolicy(incident);
            const isOpen = incident.status === "OPEN";

            return (
              <div
                key={incident.id}
                style={{
                  backgroundColor: "#ffffff",
                  borderRadius: "8px",
                  border: `1px solid ${isOpen ? (isSendUnc || isCp || isDom ? "#fca5a5" : "#fed7aa") : "#e2e8f0"}`,
                  boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
                  overflow: "hidden",
                }}
              >
                {/* Main Card Header */}
                <div style={{ padding: "16px", display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "12px" }}>
                  <div style={{ display: "flex", alignItems: "flex-start", gap: "12px", minWidth: 0, flex: 1 }}>
                    <div
                      style={{
                        padding: "8px",
                        borderRadius: "8px",
                        backgroundColor: isOpen ? (isSendUnc || isCp || isDom ? "#fee2e2" : "#ffedd5") : "#f1f5f9",
                        color: isOpen ? (isSendUnc || isCp || isDom ? "#dc2626" : "#ea580c") : "#64748b",
                        flexShrink: 0,
                      }}
                    >
                      {isCp ? <AlertOctagon size={22} /> : isSendUnc ? <ShieldAlert size={22} /> : <AlertTriangle size={22} />}
                    </div>

                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", marginBottom: "4px" }}>
                        <span
                          style={{
                            padding: "2px 8px",
                            borderRadius: "4px",
                            fontSize: "0.75rem",
                            fontWeight: "700",
                            backgroundColor: isOpen ? "#fee2e2" : "#dcfce7",
                            color: isOpen ? "#991b1b" : "#166534",
                          }}
                        >
                          {incident.status}
                        </span>

                        <span style={{ fontSize: "0.75rem", fontWeight: "700", color: "#2563eb", backgroundColor: "#eff6ff", padding: "2px 6px", borderRadius: "4px" }}>
                          {incident.type}
                        </span>

                        <span style={{ fontSize: "0.75rem", color: "#64748b" }}>
                          {new Date(incident.createdAt).toLocaleString("vi-VN")}
                        </span>
                      </div>

                      <h3 style={{ margin: "0 0 6px 0", fontSize: "1rem", fontWeight: "700", color: "#0f172a" }}>
                        {incident.title}
                      </h3>
                      <p style={{ margin: 0, fontSize: "0.85rem", color: "#475569", lineHeight: 1.4 }}>
                        {incident.description}
                      </p>
                    </div>
                  </div>

                  {/* Actions buttons */}
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", flexShrink: 0 }}>
                    {/* Specialized handler buttons based on safety policy */}
                    {isOpen && isSendUnc && (
                      <div style={{ display: "flex", gap: "6px" }}>
                        {incident.conversationId && (
                          <Link
                            to={`/inbox/${incident.conversationId}`}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "4px",
                              padding: "6px 12px",
                              borderRadius: "6px",
                              backgroundColor: "#f1f5f9",
                              color: "#1e293b",
                              textDecoration: "none",
                              fontSize: "0.8rem",
                              fontWeight: "600",
                            }}
                          >
                            <ExternalLink size={13} /> Mở hội thoại
                          </Link>
                        )}
                        <button
                          onClick={() => handleResolve(incident.id, "Đã đối soát thủ công; tin nhắn đã gửi đến khách")}
                          disabled={actionInProgress === incident.id}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "4px",
                            padding: "6px 12px",
                            borderRadius: "6px",
                            backgroundColor: "#16a34a",
                            color: "#ffffff",
                            border: "none",
                            fontSize: "0.8rem",
                            fontWeight: "600",
                            cursor: "pointer",
                          }}
                        >
                          <Check size={14} /> Đã đối soát & Đóng
                        </button>
                      </div>
                    )}

                    {isOpen && isCp && (
                      <div style={{ display: "flex", gap: "6px" }}>
                        <button
                          onClick={() => handleResolveCheckpointOrDom(incident.id, "CHECKPOINT")}
                          disabled={actionInProgress === incident.id}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "4px",
                            padding: "6px 12px",
                            borderRadius: "6px",
                            backgroundColor: "#16a34a",
                            color: "#ffffff",
                            border: "none",
                            fontSize: "0.8rem",
                            fontWeight: "600",
                            cursor: "pointer",
                          }}
                        >
                          <Check size={14} /> Đã gỡ Checkpoint & Tiếp tục
                        </button>
                      </div>
                    )}

                    {isOpen && isDom && (
                      <div style={{ display: "flex", gap: "6px" }}>
                        <button
                          onClick={() => handleResolveCheckpointOrDom(incident.id, "DOM")}
                          disabled={actionInProgress === incident.id}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "4px",
                            padding: "6px 12px",
                            borderRadius: "6px",
                            backgroundColor: "#16a34a",
                            color: "#ffffff",
                            border: "none",
                            fontSize: "0.8rem",
                            fontWeight: "600",
                            cursor: "pointer",
                          }}
                        >
                          <Check size={14} /> Đã khắc phục DOM & Tiếp tục
                        </button>
                      </div>
                    )}

                    {/* Generic resolve button if not already covered */}
                    {isOpen && !isCp && !isDom && !isSendUnc && (
                      <button
                        onClick={() => handleResolve(incident.id)}
                        disabled={actionInProgress === incident.id}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "4px",
                          padding: "6px 12px",
                          borderRadius: "6px",
                          backgroundColor: "#16a34a",
                          color: "#ffffff",
                          border: "none",
                          fontSize: "0.8rem",
                          fontWeight: "600",
                          cursor: "pointer",
                        }}
                      >
                        <Check size={14} /> Giải quyết sự cố
                      </button>
                    )}

                    <button
                      onClick={() => toggleExpand(incident.id)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "4px",
                        padding: "6px 10px",
                        borderRadius: "6px",
                        border: "1px solid #cbd5e1",
                        backgroundColor: "#ffffff",
                        fontSize: "0.8rem",
                        cursor: "pointer",
                      }}
                    >
                      {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                      {isExpanded ? "Đóng" : "Chi tiết"}
                    </button>
                  </div>
                </div>

                {/* Warning banner for safety policy */}
                {isOpen && (isSendUnc || isCp || isDom) && (
                  <div
                    style={{
                      padding: "8px 16px",
                      backgroundColor: "#fffbeb",
                      borderTop: "1px solid #fef3c7",
                      borderBottom: isExpanded ? "1px solid #fef3c7" : "none",
                      fontSize: "0.78rem",
                      color: "#92400e",
                      display: "flex",
                      alignItems: "center",
                      gap: "6px",
                    }}
                  >
                    <ShieldCheck size={15} color="#b45309" />
                    <span>{policy.warningMessage}</span>
                  </div>
                )}

                {/* Expanded metadata */}
                {isExpanded && (
                  <div style={{ padding: "16px", backgroundColor: "#f8fafc", borderTop: "1px solid #e2e8f0" }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                      <div style={{ fontSize: "0.8rem", color: "#475569" }}>
                        <strong>Incident ID:</strong> {incident.id}
                        {incident.conversationId && ` • Conversation: ${incident.conversationId}`}
                        {incident.resolvedBy && ` • Đã giải quyết bởi: ${incident.resolvedBy}`}
                        {incident.resolutionNote && ` • Ghi chú: ${incident.resolutionNote}`}
                      </div>

                      {incident.metadata && (
                        <div>
                          <strong style={{ fontSize: "0.78rem", color: "#334155" }}>Metadata kỹ thuật:</strong>
                          <pre style={{ margin: "4px 0 0 0", padding: "10px", backgroundColor: "#0f172a", color: "#e2e8f0", borderRadius: "6px", fontSize: "0.75rem", overflowX: "auto" }}>
                            {JSON.stringify(incident.metadata, null, 2)}
                          </pre>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
