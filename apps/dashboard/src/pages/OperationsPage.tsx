import React, { useState, useEffect } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { apiFetch } from "../api";
import { formatTime } from "../helpers/date-helpers";
import { AiRunInspector } from "../components/messages/AiRunInspector";
import type { QueueItem, IncidentItem, AiRunItem } from "../types";
import {
  Workflow,
  ListOrdered,
  AlertTriangle,
  FileText,
  RefreshCw,
  ArrowRight,
  AlertCircle,
  Search,
} from "lucide-react";

type OperationsTab = "dispatch" | "airuns" | "tech";

export const OperationsPage: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = (searchParams.get("tab") as OperationsTab) || "dispatch";

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [incidents, setIncidents] = useState<IncidentItem[]>([]);
  const [aiRuns, setAiRuns] = useState<AiRunItem[]>([]);
  const [selectedRun, setSelectedRun] = useState<AiRunItem | null>(null);
  const [filterText, setFilterText] = useState("");

  const setTab = (tab: OperationsTab) => {
    setSearchParams({ tab });
  };

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      if (activeTab === "dispatch") {
        const res = await apiFetch<{ items?: QueueItem[]; queue?: QueueItem[] }>("/api/queue");
        setQueue(res.items || res.queue || []);
      } else if (activeTab === "airuns") {
        const res = await apiFetch<{ runs: AiRunItem[] }>("/api/ai-runs?limit=50");
        const list = res.runs || [];
        setAiRuns(list);
        if (list.length > 0 && !selectedRun) {
          setSelectedRun(list[0]);
        }
      } else if (activeTab === "tech") {
        const [incRes, qRes] = await Promise.all([
          apiFetch<{ incidents: IncidentItem[] }>("/api/incidents"),
          apiFetch<{ items?: QueueItem[]; queue?: QueueItem[] }>("/api/queue"),
        ]);
        setIncidents(incRes.incidents || []);
        setQueue(qRes.items || qRes.queue || []);
      }
    } catch (err: unknown) {
      setError((err as Error).message || "Không thể tải dữ liệu vận hành. Vui lòng thử lại.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [activeTab]);

  const filteredRuns = aiRuns.filter((r) => {
    if (!filterText.trim()) return true;
    const term = filterText.toLowerCase();
    return (
      (r.model && r.model.toLowerCase().includes(term)) ||
      (r.status && r.status.toLowerCase().includes(term)) ||
      (r.id && r.id.toLowerCase().includes(term)) ||
      (r.responseSnapshot?.content && r.responseSnapshot.content.toLowerCase().includes(term))
    );
  });

  return (
    <div style={{ padding: "20px", maxWidth: "1400px", margin: "0 auto" }}>
      {/* Page Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", flexWrap: "wrap", gap: "12px" }}>
        <div>
          <h1 style={{ fontSize: "1.35rem", fontWeight: "700", color: "#0f172a", margin: 0, display: "flex", alignItems: "center", gap: "8px" }}>
            <Workflow size={22} style={{ color: "#3b82f6" }} />
            Không gian Vận hành
          </h1>
          <p style={{ margin: "4px 0 0", color: "#64748b", fontSize: "0.85rem" }}>
            Điều phối toàn kênh, kiểm soát hàng đợi, hoạt động AI và giám sát sự cố kỹ thuật.
          </p>
        </div>

        <button
          onClick={loadData}
          disabled={loading}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "6px",
            padding: "8px 14px",
            backgroundColor: "#ffffff",
            border: "1px solid #cbd5e1",
            borderRadius: "6px",
            fontSize: "0.85rem",
            fontWeight: 500,
            color: "#334155",
            cursor: loading ? "not-allowed" : "pointer",
          }}
        >
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Làm mới
        </button>
      </div>

      {/* Error Notice */}
      {error && (
        <div
          style={{
            padding: "12px 16px",
            backgroundColor: "#fef2f2",
            border: "1px solid #fecaca",
            borderRadius: "6px",
            color: "#991b1b",
            fontSize: "0.85rem",
            marginBottom: "16px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <AlertCircle size={16} />
            <span>{error}</span>
          </div>
          <button
            onClick={loadData}
            style={{
              background: "none",
              border: "1px solid #dc2626",
              color: "#991b1b",
              borderRadius: "4px",
              padding: "2px 8px",
              cursor: "pointer",
              fontSize: "0.78rem",
              fontWeight: 600,
            }}
          >
            Thử lại
          </button>
        </div>
      )}

      {/* Tabs Bar */}
      <div style={{ display: "flex", gap: "8px", borderBottom: "1px solid #e2e8f0", marginBottom: "20px", overflowX: "auto" }}>
        <button
          onClick={() => setTab("dispatch")}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            padding: "10px 18px",
            border: "none",
            borderBottom: activeTab === "dispatch" ? "2px solid #3b82f6" : "2px solid transparent",
            backgroundColor: "transparent",
            color: activeTab === "dispatch" ? "#1d4ed8" : "#64748b",
            fontWeight: activeTab === "dispatch" ? 600 : 500,
            fontSize: "0.9rem",
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
        >
          <ListOrdered size={16} />
          Điều phối & Hàng đợi
          {queue.length > 0 && (
            <span style={{ backgroundColor: "#dbeafe", color: "#1e40af", padding: "1px 6px", borderRadius: "10px", fontSize: "11px" }}>
              {queue.length}
            </span>
          )}
        </button>

        <button
          onClick={() => setTab("airuns")}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            padding: "10px 18px",
            border: "none",
            borderBottom: activeTab === "airuns" ? "2px solid #3b82f6" : "2px solid transparent",
            backgroundColor: "transparent",
            color: activeTab === "airuns" ? "#1d4ed8" : "#64748b",
            fontWeight: activeTab === "airuns" ? 600 : 500,
            fontSize: "0.9rem",
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
        >
          <FileText size={16} />
          Hoạt động AI (Toàn kênh)
          {aiRuns.length > 0 && (
            <span style={{ backgroundColor: "#f1f5f9", color: "#475569", padding: "1px 6px", borderRadius: "10px", fontSize: "11px" }}>
              {aiRuns.length}
            </span>
          )}
        </button>

        <button
          onClick={() => setTab("tech")}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            padding: "10px 18px",
            border: "none",
            borderBottom: activeTab === "tech" ? "2px solid #3b82f6" : "2px solid transparent",
            backgroundColor: "transparent",
            color: activeTab === "tech" ? "#1d4ed8" : "#64748b",
            fontWeight: activeTab === "tech" ? 600 : 500,
            fontSize: "0.9rem",
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
        >
          <AlertTriangle size={16} />
          Kỹ thuật & Sự cố
          {incidents.filter((i) => i.status === "OPEN").length > 0 && (
            <span style={{ backgroundColor: "#fee2e2", color: "#b91c1c", padding: "1px 6px", borderRadius: "10px", fontSize: "11px" }}>
              {incidents.filter((i) => i.status === "OPEN").length}
            </span>
          )}
        </button>
      </div>

      {/* Tab 1: Dispatch / Queue */}
      {activeTab === "dispatch" && (
        <div style={{ backgroundColor: "#ffffff", borderRadius: "8px", border: "1px solid #e2e8f0", overflow: "hidden" }}>
          <div style={{ padding: "14px 16px", borderBottom: "1px solid #e2e8f0", backgroundColor: "#f8fafc", fontWeight: 600, color: "#1e293b", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>Các lượt đang chờ xử lý hoặc gom tin (Debouncing / Queue)</span>
            <span style={{ fontSize: "12px", color: "#64748b" }}>{queue.length} tác vụ</span>
          </div>
          {queue.length === 0 ? (
            <div style={{ padding: "40px", textAlign: "center", color: "#94a3b8" }}>
              Hàng đợi trống. Tất cả hội thoại đang ở trạng thái nhàn rỗi hoặc đã được xử lý xong.
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
                <thead>
                  <tr style={{ backgroundColor: "#f1f5f9", textAlign: "left", color: "#475569" }}>
                    <th style={{ padding: "10px 16px" }}>Hội thoại</th>
                    <th style={{ padding: "10px 16px" }}>Inbound Version</th>
                    <th style={{ padding: "10px 16px" }}>Thời gian vào hàng đợi</th>
                    <th style={{ padding: "10px 16px" }}>Thời điểm sẵn sàng</th>
                    <th style={{ padding: "10px 16px", textAlign: "right" }}>Thao tác</th>
                  </tr>
                </thead>
                <tbody>
                  {queue.map((q) => (
                    <tr key={q.queueId || q.conversationId} style={{ borderBottom: "1px solid #f1f5f9" }}>
                      <td style={{ padding: "12px 16px", fontWeight: 500, color: "#0f172a" }}>
                        <Link to={`/inbox/${q.conversationId}`} style={{ color: "#2563eb", textDecoration: "none" }}>
                          {q.conversationId}
                        </Link>
                      </td>
                      <td style={{ padding: "12px 16px" }}>v{q.inboundVersion}</td>
                      <td style={{ padding: "12px 16px", color: "#64748b" }}>{formatTime(q.queuedAt)}</td>
                      <td style={{ padding: "12px 16px", color: "#64748b" }}>{formatTime(q.readyAt)}</td>
                      <td style={{ padding: "12px 16px", textAlign: "right" }}>
                        <Link
                          to={`/inbox/${q.conversationId}`}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "4px",
                            padding: "4px 8px",
                            backgroundColor: "#f1f5f9",
                            borderRadius: "4px",
                            color: "#334155",
                            textDecoration: "none",
                            fontSize: "12px",
                          }}
                        >
                          Mở chat <ArrowRight size={12} />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Tab 2: AI Runs (Inspector Integrated) */}
      {activeTab === "airuns" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          {/* Search bar */}
          <div style={{ display: "flex", gap: "8px", maxWidth: "450px" }}>
            <div style={{ position: "relative", flex: 1 }}>
              <Search size={15} style={{ position: "absolute", left: "10px", top: "10px", color: "#94a3b8" }} />
              <input
                type="text"
                value={filterText}
                onChange={(e) => setFilterText(e.target.value)}
                placeholder="Lọc theo model, trạng thái, ID, nội dung..."
                style={{
                  width: "100%",
                  padding: "7px 10px 7px 32px",
                  borderRadius: "6px",
                  border: "1px solid #cbd5e1",
                  fontSize: "13px",
                  boxSizing: "border-box",
                }}
              />
            </div>
            {filterText && (
              <button
                onClick={() => setFilterText("")}
                style={{
                  padding: "6px 12px",
                  backgroundColor: "#f1f5f9",
                  border: "1px solid #cbd5e1",
                  borderRadius: "6px",
                  fontSize: "12px",
                  cursor: "pointer",
                }}
              >
                Xóa lọc
              </button>
            )}
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))",
              gap: "16px",
              alignItems: "start",
            }}
          >
            {/* Runs Table */}
            <div style={{ backgroundColor: "#ffffff", borderRadius: "8px", border: "1px solid #e2e8f0", overflow: "hidden" }}>
              <div style={{ padding: "12px 16px", borderBottom: "1px solid #e2e8f0", backgroundColor: "#f8fafc", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontWeight: 600, color: "#1e293b", fontSize: "13px" }}>Lượt gọi AI ({filteredRuns.length})</span>
                <span style={{ fontSize: "11px", color: "#64748b" }}>Nhấp dòng để xem chi tiết</span>
              </div>

              {filteredRuns.length === 0 ? (
                <div style={{ padding: "30px", textAlign: "center", color: "#94a3b8" }}>
                  {aiRuns.length === 0 ? "Chưa có bản ghi AI Run nào." : "Không có kết quả nào khớp bộ lọc."}
                </div>
              ) : (
                <div style={{ maxHeight: "580px", overflowY: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                    <thead>
                      <tr style={{ backgroundColor: "#f1f5f9", textAlign: "left", color: "#475569" }}>
                        <th style={{ padding: "8px 10px" }}>Model</th>
                        <th style={{ padding: "8px 10px" }}>Trạng thái</th>
                        <th style={{ padding: "8px 10px" }}>Thời gian</th>
                        <th style={{ padding: "8px 10px" }}>Phản hồi</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredRuns.map((r) => {
                        const isSelected = selectedRun?.id === r.id;
                        const isSuccess = r.status === "SUCCESS";
                        return (
                          <tr
                            key={r.id}
                            onClick={() => setSelectedRun(r)}
                            style={{
                              borderBottom: "1px solid #f1f5f9",
                              backgroundColor: isSelected ? "#eff6ff" : "transparent",
                              cursor: "pointer",
                            }}
                          >
                            <td style={{ padding: "9px 10px", fontWeight: 500, color: "#0f172a" }}>
                              {r.model || "—"}
                            </td>
                            <td style={{ padding: "9px 10px" }}>
                              <span
                                style={{
                                  fontSize: "10px",
                                  padding: "2px 5px",
                                  borderRadius: "4px",
                                  fontWeight: 600,
                                  backgroundColor: isSuccess ? "#dcfce7" : "#fee2e2",
                                  color: isSuccess ? "#15803d" : "#b91c1c",
                                }}
                              >
                                {r.status}
                              </span>
                            </td>
                            <td style={{ padding: "9px 10px", color: "#64748b", whiteSpace: "nowrap" }}>
                              {formatTime(r.createdAt)}
                            </td>
                            <td style={{ padding: "9px 10px", color: "#334155", maxWidth: "200px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {r.parsedOutput?.messages?.[0] || r.responseSnapshot?.content || "—"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Integrated AiRunInspector */}
            <div style={{ backgroundColor: "#ffffff", borderRadius: "8px", border: "1px solid #e2e8f0", overflow: "hidden", maxHeight: "640px" }}>
              <AiRunInspector run={selectedRun} />
            </div>
          </div>
        </div>
      )}

      {/* Tab 3: Technical & Incidents */}
      {activeTab === "tech" && (
        <div style={{ backgroundColor: "#ffffff", borderRadius: "8px", border: "1px solid #e2e8f0", overflow: "hidden" }}>
          <div style={{ padding: "14px 16px", borderBottom: "1px solid #e2e8f0", backgroundColor: "#f8fafc", fontWeight: 600, color: "#1e293b", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>Sự cố kỹ thuật kênh & phiên</span>
            <span style={{ fontSize: "12px", color: "#64748b" }}>{incidents.length} sự cố</span>
          </div>
          {incidents.length === 0 ? (
            <div style={{ padding: "40px", textAlign: "center", color: "#94a3b8" }}>Không có sự cố nào cần xử lý.</div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
                <thead>
                  <tr style={{ backgroundColor: "#f1f5f9", textAlign: "left", color: "#475569" }}>
                    <th style={{ padding: "10px 16px" }}>Loại sự cố</th>
                    <th style={{ padding: "10px 16px" }}>Trạng thái</th>
                    <th style={{ padding: "10px 16px" }}>Thời gian tạo</th>
                    <th style={{ padding: "10px 16px" }}>Mô tả</th>
                    <th style={{ padding: "10px 16px", textAlign: "right" }}>Thao tác</th>
                  </tr>
                </thead>
                <tbody>
                  {incidents.map((inc) => (
                    <tr key={inc.id} style={{ borderBottom: "1px solid #f1f5f9" }}>
                      <td style={{ padding: "12px 16px", fontWeight: 600, color: "#0f172a" }}>{inc.type}</td>
                      <td style={{ padding: "12px 16px" }}>
                        <span
                          style={{
                            fontSize: "11px",
                            padding: "2px 6px",
                            borderRadius: "4px",
                            fontWeight: 600,
                            backgroundColor: inc.status === "OPEN" ? "#fee2e2" : "#dcfce7",
                            color: inc.status === "OPEN" ? "#b91c1c" : "#15803d",
                          }}
                        >
                          {inc.status}
                        </span>
                      </td>
                      <td style={{ padding: "12px 16px", color: "#64748b" }}>{formatTime(inc.createdAt)}</td>
                      <td style={{ padding: "12px 16px", color: "#334155" }}>{inc.description || inc.title || "—"}</td>
                      <td style={{ padding: "12px 16px", textAlign: "right" }}>
                        {inc.conversationId && (
                          <Link
                            to={`/inbox/${inc.conversationId}`}
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: "4px",
                              padding: "4px 8px",
                              backgroundColor: "#f1f5f9",
                              borderRadius: "4px",
                              color: "#334155",
                              textDecoration: "none",
                              fontSize: "12px",
                            }}
                          >
                            Mở chat <ArrowRight size={12} />
                          </Link>
                        )}
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
