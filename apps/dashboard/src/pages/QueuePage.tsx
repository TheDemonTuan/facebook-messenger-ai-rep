import React, { useEffect, useState, useMemo } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "../api";
import type { QueueItem, JobItem, JobStatus } from "../types";
import { shouldRefetchQueue } from "../helpers/sse-helpers";
import { useSseWakeup } from "../context/SseContext";
import {
  ListOrdered,
  Clock,
  CheckCircle,
  AlertCircle,
  RefreshCw,
  Loader2,
  Database,
  ArrowUpCircle,
  Timer,
  ShieldAlert,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

export const QueuePage: React.FC = () => {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [jobs, setJobs] = useState<JobItem[]>([]);
  const [activeTab, setActiveTab] = useState<"JOBS" | "TURNS">("JOBS");
  const [jobStatusFilter, setJobStatusFilter] = useState<string>("ALL");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);

  const loadQueue = async () => {
    setError(null);
    try {
      const res = await apiFetch<{ items: QueueItem[]; jobs?: JobItem[] }>("/api/queue");
      setItems(res.items || []);
      setJobs(res.jobs || []);
    } catch (err: unknown) {
      setError((err as Error).message || "Không thể tải dữ liệu hàng đợi");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadQueue();
  }, []);

  // SSE wakeup: refetch without tight interval polling
  useSseWakeup(shouldRefetchQueue, loadQueue);

  const handlePrioritize = async (convId: string) => {
    try {
      await apiFetch(`/api/queue/${convId}/prioritize`, { method: "POST" });
      await loadQueue();
    } catch (err: unknown) {
      alert((err as Error).message);
    }
  };

  const filteredJobs = useMemo(() => {
    if (jobStatusFilter === "ALL") return jobs;
    return jobs.filter((j) => j.status === jobStatusFilter);
  }, [jobs, jobStatusFilter]);

  const getJobStatusBadge = (status: JobStatus) => {
    switch (status) {
      case "READY":
        return <span style={{ backgroundColor: "#dbeafe", color: "#1e40af", padding: "3px 8px", borderRadius: "4px", fontSize: "0.75rem", fontWeight: "700" }}>READY</span>;
      case "RUNNING":
        return <span style={{ backgroundColor: "#fef3c7", color: "#92400e", padding: "3px 8px", borderRadius: "4px", fontSize: "0.75rem", fontWeight: "700" }}>RUNNING</span>;
      case "RETRY_WAIT":
        return <span style={{ backgroundColor: "#ffedd5", color: "#9a3412", padding: "3px 8px", borderRadius: "4px", fontSize: "0.75rem", fontWeight: "700" }}>RETRY_WAIT</span>;
      case "SUCCEEDED":
        return <span style={{ backgroundColor: "#dcfce7", color: "#166534", padding: "3px 8px", borderRadius: "4px", fontSize: "0.75rem", fontWeight: "700" }}>SUCCEEDED</span>;
      case "FAILED":
        return <span style={{ backgroundColor: "#fee2e2", color: "#991b1b", padding: "3px 8px", borderRadius: "4px", fontSize: "0.75rem", fontWeight: "700" }}>FAILED</span>;
      case "CANCELLED":
        return <span style={{ backgroundColor: "#f1f5f9", color: "#475569", padding: "3px 8px", borderRadius: "4px", fontSize: "0.75rem", fontWeight: "700" }}>CANCELLED</span>;
      default:
        return <span>{status}</span>;
    }
  };

  const renderLeaseInfo = (job: JobItem) => {
    if (job.status === "RUNNING" && job.lockedUntil) {
      const remainingMs = new Date(job.lockedUntil).getTime() - Date.now();
      const remainingSec = Math.max(0, Math.round(remainingMs / 1000));
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
          <span style={{ color: "#b45309", fontWeight: "600", fontSize: "0.8rem", display: "flex", alignItems: "center", gap: "4px" }}>
            <Timer size={13} /> Active Lease ({remainingSec}s)
          </span>
          <span style={{ fontSize: "0.72rem", color: "#64748b" }}>
            epoch: {job.fencingEpoch}
          </span>
        </div>
      );
    }
    if (job.lockedUntil) {
      return (
        <span style={{ fontSize: "0.75rem", color: "#64748b" }}>
          {new Date(job.lockedUntil).toLocaleTimeString("vi-VN")}
        </span>
      );
    }
    return <span style={{ color: "#94a3b8", fontSize: "0.75rem" }}>—</span>;
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px", maxWidth: "100%", overflowX: "hidden" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px" }}>
        <div>
          <h1 style={{ margin: "0 0 4px 0", fontSize: "1.5rem", fontWeight: "bold" }}>
            Quản lý Hàng đợi (Queue & PostgreSQL Jobs)
          </h1>
          <div style={{ fontSize: "0.85rem", color: "#64748b" }}>
            Kiểm soát tác vụ nền PostgreSQL FOR UPDATE SKIP LOCKED và điều phối lượt hội thoại
          </div>
        </div>
        <button
          onClick={loadQueue}
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
          <RefreshCw size={15} /> Làm mới
        </button>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: "8px", borderBottom: "1px solid #e2e8f0", paddingBottom: "8px" }}>
        <button
          onClick={() => setActiveTab("JOBS")}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "6px",
            padding: "8px 16px",
            borderRadius: "6px",
            border: "none",
            backgroundColor: activeTab === "JOBS" ? "#2563eb" : "transparent",
            color: activeTab === "JOBS" ? "#ffffff" : "#475569",
            fontWeight: activeTab === "JOBS" ? "700" : "500",
            fontSize: "0.9rem",
            cursor: "pointer",
          }}
        >
          <Database size={16} /> PostgreSQL Jobs ({jobs.length})
        </button>
        <button
          onClick={() => setActiveTab("TURNS")}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "6px",
            padding: "8px 16px",
            borderRadius: "6px",
            border: "none",
            backgroundColor: activeTab === "TURNS" ? "#2563eb" : "transparent",
            color: activeTab === "TURNS" ? "#ffffff" : "#475569",
            fontWeight: activeTab === "TURNS" ? "700" : "500",
            fontSize: "0.9rem",
            cursor: "pointer",
          }}
        >
          <ListOrdered size={16} /> Hàng đợi hội thoại ({items.length})
        </button>
      </div>

      {/* Error state */}
      {error && (
        <div style={{ display: "flex", alignItems: "center", gap: "8px", padding: "14px", backgroundColor: "#fef2f2", border: "1px solid #fecaca", borderRadius: "8px", color: "#991b1b", fontSize: "0.9rem" }}>
          <AlertCircle size={18} />
          <span>{error}</span>
          <button onClick={loadQueue} style={{ marginLeft: "auto", padding: "4px 8px", backgroundColor: "#dc2626", color: "#fff", border: "none", borderRadius: "4px", cursor: "pointer" }}>Thử lại</button>
        </div>
      )}

      {/* Loading state */}
      {loading && jobs.length === 0 && items.length === 0 ? (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "200px", gap: "8px", color: "#64748b" }}>
          <Loader2 size={20} className="animate-spin" />
          <span>Đang tải thông tin hàng đợi...</span>
        </div>
      ) : null}

      {/* TAB 1: PostgreSQL Jobs */}
      {activeTab === "JOBS" && (
        <div>
          {/* Status filters */}
          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginBottom: "12px" }}>
            {["ALL", "READY", "RUNNING", "RETRY_WAIT", "SUCCEEDED", "FAILED", "CANCELLED"].map((st) => (
              <button
                key={st}
                onClick={() => setJobStatusFilter(st)}
                style={{
                  padding: "4px 10px",
                  borderRadius: "4px",
                  border: "1px solid #cbd5e1",
                  backgroundColor: jobStatusFilter === st ? "#1e293b" : "#ffffff",
                  color: jobStatusFilter === st ? "#ffffff" : "#475569",
                  fontSize: "0.78rem",
                  fontWeight: "600",
                  cursor: "pointer",
                }}
              >
                {st}
              </button>
            ))}
          </div>

          {filteredJobs.length === 0 ? (
            <div style={{ padding: "40px", backgroundColor: "#ffffff", borderRadius: "8px", textAlign: "center", color: "#64748b", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
              <CheckCircle size={32} color="#10b981" style={{ margin: "0 auto 8px auto" }} />
              <div>Không có tác vụ PostgreSQL nào theo bộ lọc đã chọn!</div>
            </div>
          ) : (
            <div style={{ backgroundColor: "#ffffff", borderRadius: "8px", overflowX: "auto", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left", fontSize: "0.85rem" }}>
                <thead>
                  <tr style={{ backgroundColor: "#f8fafc", borderBottom: "1px solid #e2e8f0", color: "#64748b" }}>
                    <th style={{ padding: "10px 14px" }}>Job ID / Type</th>
                    <th style={{ padding: "10px 14px" }}>Trạng thái</th>
                    <th style={{ padding: "10px 14px" }}>Lease / Khóa</th>
                    <th style={{ padding: "10px 14px" }}>Attempts</th>
                    <th style={{ padding: "10px 14px" }}>Ưu tiên</th>
                    <th style={{ padding: "10px 14px" }}>Thời gian</th>
                    <th style={{ padding: "10px 14px" }}>Chi tiết</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredJobs.map((job) => {
                    const isExpanded = expandedJobId === job.id;
                    const hasError = Boolean(job.lastError);
                    return (
                      <React.Fragment key={job.id}>
                        <tr style={{ borderBottom: "1px solid #f1f5f9", backgroundColor: isExpanded ? "#f8fafc" : "transparent" }}>
                          <td style={{ padding: "10px 14px" }}>
                            <div style={{ fontWeight: "600", color: "#0f172a" }}>{job.jobType}</div>
                            <div style={{ fontSize: "0.72rem", color: "#94a3b8", fontFamily: "monospace" }}>
                              {job.id.slice(0, 8)}...
                            </div>
                          </td>
                          <td style={{ padding: "10px 14px" }}>{getJobStatusBadge(job.status)}</td>
                          <td style={{ padding: "10px 14px" }}>{renderLeaseInfo(job)}</td>
                          <td style={{ padding: "10px 14px" }}>
                            <span style={{ fontWeight: "600", color: job.attempts > 1 ? "#ea580c" : "#334155" }}>
                              {job.attempts} / {job.maxAttempts}
                            </span>
                          </td>
                          <td style={{ padding: "10px 14px" }}>{job.priority}</td>
                          <td style={{ padding: "10px 14px", fontSize: "0.75rem", color: "#64748b" }}>
                            {new Date(job.createdAt).toLocaleTimeString("vi-VN")}
                          </td>
                          <td style={{ padding: "10px 14px" }}>
                            <button
                              onClick={() => setExpandedJobId(isExpanded ? null : job.id)}
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "4px",
                                padding: "4px 8px",
                                borderRadius: "4px",
                                border: "1px solid #cbd5e1",
                                backgroundColor: "#ffffff",
                                fontSize: "0.75rem",
                                cursor: "pointer",
                              }}
                            >
                              {isExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                              {isExpanded ? "Đóng" : "Xem"}
                            </button>
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr style={{ backgroundColor: "#f8fafc" }}>
                            <td colSpan={7} style={{ padding: "12px 16px", borderBottom: "1px solid #e2e8f0" }}>
                              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                                {hasError && (
                                  <div style={{ display: "flex", alignItems: "flex-start", gap: "6px", backgroundColor: "#fef2f2", border: "1px solid #fecaca", padding: "8px 12px", borderRadius: "6px", color: "#991b1b", fontSize: "0.8rem" }}>
                                    <ShieldAlert size={16} style={{ flexShrink: 0, marginTop: "2px" }} />
                                    <div><strong>Lỗi gần nhất:</strong> {job.lastError}</div>
                                  </div>
                                )}
                                <div style={{ fontSize: "0.75rem", color: "#475569" }}>
                                  <strong>Idempotency Key:</strong> {job.idempotencyKey || "None"} • <strong>Owner Token:</strong> {job.ownerToken || "None"} • <strong>Available At:</strong> {new Date(job.availableAt).toISOString()}
                                </div>
                                <div>
                                  <strong style={{ fontSize: "0.75rem", color: "#334155" }}>Payload:</strong>
                                  <pre style={{ margin: "4px 0 0 0", padding: "8px", backgroundColor: "#0f172a", color: "#e2e8f0", borderRadius: "6px", fontSize: "0.75rem", overflowX: "auto" }}>
                                    {JSON.stringify(job.payload, null, 2)}
                                  </pre>
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* TAB 2: Conversation Turn Queue */}
      {activeTab === "TURNS" && (
        <div>
          {items.length === 0 ? (
            <div style={{ padding: "40px", backgroundColor: "#ffffff", borderRadius: "8px", textAlign: "center", color: "#64748b", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
              <CheckCircle size={32} color="#10b981" style={{ margin: "0 auto 8px auto" }} />
              <div>Hàng đợi hội thoại hiện đang trống. Mọi tin nhắn đã được phục vụ!</div>
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
                      </td>
                      <td style={{ padding: "12px 16px", color: "#64748b", fontSize: "0.85rem" }}>
                        {new Date(item.readyAt).toLocaleTimeString("vi-VN")}
                      </td>
                      <td style={{ padding: "12px 16px" }}>
                        <span style={{ display: "flex", alignItems: "center", gap: "4px", color: item.estimatedWaitSeconds > 60 ? "#ea580c" : "#16a34a", fontSize: "0.85rem" }}>
                          <Clock size={14} /> ~{item.estimatedWaitSeconds}s
                        </span>
                      </td>
                      <td style={{ padding: "12px 16px" }}>
                        <div style={{ display: "flex", gap: "8px" }}>
                          <Link
                            to={`/inbox/${item.conversationId}`}
                            style={{ padding: "4px 8px", backgroundColor: "#f1f5f9", color: "#334155", borderRadius: "4px", textDecoration: "none", fontSize: "0.8rem", fontWeight: "600" }}
                          >
                            Xem hội thoại
                          </Link>
                          {item.position > 1 && (
                            <button
                              onClick={() => handlePrioritize(item.conversationId)}
                              style={{ display: "flex", alignItems: "center", gap: "4px", padding: "4px 8px", backgroundColor: "#eff6ff", color: "#2563eb", border: "1px solid #bfdbfe", borderRadius: "4px", cursor: "pointer", fontSize: "0.8rem", fontWeight: "600" }}
                            >
                              <ArrowUpCircle size={14} /> Ưu tiên
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
