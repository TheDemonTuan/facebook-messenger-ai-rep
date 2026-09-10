import React, { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { apiFetch } from "../api";
import { formatTime } from "../helpers/date-helpers";
import { AiRunInspector } from "../components/messages/AiRunInspector";
import { useSseWakeup } from "../context/SseContext";
import { shouldRefetchAiRuns, shouldRefetchIncidents, shouldRefetchQueue } from "../helpers/sse-helpers";
import {
  getIncidentSafetyPolicy,
  isCheckpoint,
  isDomDegraded,
} from "../helpers/incident-helpers";
import type { AiRunItem, IncidentItem, JobItem, OutboundActionItem, PaginatedResponse, QueueItem } from "../types";
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Cpu,
  ListOrdered,
  RefreshCw,
  Search,
} from "lucide-react";

type OperationsTab = "dispatch" | "airuns" | "tech";
type IncidentStatusFilter = "OPEN" | "RESOLVED" | "ALL";

const tabs: OperationsTab[] = ["dispatch", "airuns", "tech"];

function hasItems<T>(response: PaginatedResponse<T>, endpoint: string): T[] {
  if (!Array.isArray(response.items)) {
    throw new Error(`Phản hồi ${endpoint} không hợp lệ. Vui lòng thử lại hoặc liên hệ quản trị viên.`);
  }
  return response.items;
}

const buttonStyle: React.CSSProperties = {
  border: "1px solid #cbd5e1",
  borderRadius: "6px",
  background: "#fff",
  color: "#334155",
  cursor: "pointer",
  fontSize: "12px",
  fontWeight: 600,
  padding: "6px 9px",
};

export const OperationsPage: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get("tab");
  const activeTab: OperationsTab = tabs.includes(tabParam as OperationsTab) ? (tabParam as OperationsTab) : "dispatch";
  const requestVersion = useRef(0);

  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [jobs, setJobs] = useState<JobItem[]>([]);
  const [incidents, setIncidents] = useState<IncidentItem[]>([]);
  const [aiRuns, setAiRuns] = useState<AiRunItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRunDetail, setSelectedRunDetail] = useState<AiRunItem | null>(null);
  const [selectedRunActions, setSelectedRunActions] = useState<OutboundActionItem[]>([]);
  const [filterText, setFilterText] = useState("");

  // Server-side filters & pagination for AI Runs
  const [aiStatusFilter, setAiStatusFilter] = useState("ALL");
  const [aiOffset, setAiOffset] = useState(0);
  const [aiTotal, setAiTotal] = useState(0);
  const [aiHasMore, setAiHasMore] = useState(false);
  const aiLimit = 20;

  // Server-side filters & pagination for Incidents
  const [incidentStatus, setIncidentStatus] = useState<IncidentStatusFilter>("OPEN");
  const [incidentType, setIncidentType] = useState("ALL");
  const [incidentOffset, setIncidentOffset] = useState(0);
  const [incidentTotal, setIncidentTotal] = useState(0);
  const [incidentHasMore, setIncidentHasMore] = useState(false);
  const [incidentOpenTotal, setIncidentOpenTotal] = useState(0);
  const [incidentTypes, setIncidentTypes] = useState<string[]>([]);
  const incidentLimit = 25;

  const [expandedIncidentIds, setExpandedIncidentIds] = useState<Set<string>>(new Set());
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);

  const setTab = (tab: OperationsTab) => setSearchParams({ tab });

  const loadData = useCallback(async () => {
    const version = ++requestVersion.current;
    setLoading(true);
    setError(null);
    try {
      if (activeTab === "dispatch") {
        const response = await apiFetch<{ items: QueueItem[]; jobs: JobItem[] }>("/api/queue?limit=50");
        if (!Array.isArray(response.items) || !Array.isArray(response.jobs)) {
          throw new Error("Phản hồi /api/queue không hợp lệ.");
        }
        if (version === requestVersion.current) {
          setQueue(response.items);
          setJobs(response.jobs);
        }
      } else if (activeTab === "airuns") {
        const params = new URLSearchParams();
        params.set("limit", String(aiLimit));
        params.set("offset", String(aiOffset));
        if (filterText.trim()) params.set("q", filterText.trim());
        if (aiStatusFilter !== "ALL") params.set("status", aiStatusFilter);

        const response = await apiFetch<PaginatedResponse<AiRunItem>>(`/api/ai-runs?${params.toString()}`);
        const items = hasItems(response, "/api/ai-runs");
        if (version === requestVersion.current) {
          setAiRuns(items);
          setAiTotal(response.total ?? items.length);
          setAiHasMore(Boolean(response.hasMore));
          setSelectedRunId((current) =>
            current && items.some((item) => item.id === current) ? current : items[0]?.id ?? null
          );
        }
      } else {
        const incParams = new URLSearchParams();
        incParams.set("limit", String(incidentLimit));
        incParams.set("offset", String(incidentOffset));
        if (incidentStatus !== "ALL") incParams.set("status", incidentStatus);
        if (incidentType !== "ALL") incParams.set("type", incidentType);
        if (filterText.trim()) incParams.set("q", filterText.trim());

        const [incidentResponse, queueResponse] = await Promise.all([
          apiFetch<PaginatedResponse<IncidentItem>>(`/api/incidents?${incParams.toString()}`),
          apiFetch<{ items: QueueItem[]; jobs: JobItem[] }>("/api/queue?limit=50"),
        ]);
        const incidentItems = hasItems(incidentResponse, "/api/incidents");
        if (!Array.isArray(queueResponse.items) || !Array.isArray(queueResponse.jobs)) {
          throw new Error("Phản hồi /api/queue không hợp lệ.");
        }
        if (version === requestVersion.current) {
          setIncidents(incidentItems);
          setIncidentTotal(incidentResponse.total ?? incidentItems.length);
          setIncidentHasMore(Boolean(incidentResponse.hasMore));
          setIncidentOpenTotal(typeof incidentResponse.openTotal === "number" ? incidentResponse.openTotal : incidentItems.filter((item) => item.status === "OPEN").length);
          setIncidentTypes(Array.isArray(incidentResponse.typeFacets) ? incidentResponse.typeFacets.map((facet) => typeof facet === "string" ? facet : facet.type).filter((type): type is string => typeof type === "string").sort() : Array.from(new Set(incidentItems.map((item) => item.type))).sort());
          setQueue(queueResponse.items);
          setJobs(queueResponse.jobs);
        }
      }
    } catch (cause) {
      if (version === requestVersion.current) {
        setError(cause instanceof Error ? cause.message : "Không thể tải dữ liệu vận hành");
      }
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }, [activeTab, aiLimit, aiOffset, aiStatusFilter, filterText, incidentLimit, incidentOffset, incidentStatus, incidentType]);

  useEffect(() => {
    if (tabParam && !tabs.includes(tabParam as OperationsTab)) setSearchParams({ tab: "dispatch" }, { replace: true });
  }, [setSearchParams, tabParam]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useSseWakeup(shouldRefetchQueue, () => {
    if (activeTab === "dispatch" || activeTab === "tech") void loadData();
  });
  useSseWakeup(shouldRefetchIncidents, () => {
    if (activeTab === "tech") void loadData();
  });
  useSseWakeup(shouldRefetchAiRuns, () => {
    if (activeTab === "airuns") void loadData();
  });

  const selectedRun = selectedRunDetail?.id === selectedRunId
    ? selectedRunDetail
    : aiRuns.find((run) => run.id === selectedRunId) ?? null;

  useEffect(() => {
    if (!selectedRunId) {
      setSelectedRunDetail(null);
      setSelectedRunActions([]);
      return;
    }
    let cancelled = false;
    void apiFetch<AiRunItem & { actions: OutboundActionItem[] }>(`/api/ai-runs/${selectedRunId}`)
      .then((response) => {
        if (!cancelled) {
          setSelectedRunDetail(response);
          setSelectedRunActions(Array.isArray(response.actions) ? response.actions : []);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSelectedRunDetail(null);
          setSelectedRunActions([]);
        }
      });
    return () => { cancelled = true; };
  }, [selectedRunId]);

  const openIncidentCount = incidentOpenTotal;

  const prioritize = async (conversationId: string) => {
    setActionInProgress(`queue:${conversationId}`);
    try {
      await apiFetch(`/api/queue/${conversationId}/prioritize`, { method: "POST" });
      await loadData();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Không thể ưu tiên hội thoại");
    } finally {
      setActionInProgress(null);
    }
  };

  const resolveIncident = async (incident: IncidentItem, defaultNote = "Đã xử lý") => {
    const note = window.prompt("Nhập ghi chú xử lý sự cố (hoặc để trống):", defaultNote);
    if (note === null) return;
    setActionInProgress(incident.id);
    try {
      await apiFetch(`/api/incidents/${incident.id}/resolve`, {
        method: "POST",
        body: JSON.stringify({ resolutionNote: note }),
      });
      await loadData();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Không thể giải quyết sự cố");
    } finally {
      setActionInProgress(null);
    }
  };

  const resolveAll = async () => {
    if (openIncidentCount === 0 || !window.confirm(`Đóng tất cả ${openIncidentCount} sự cố đang mở của toàn kênh? Bộ lọc hiện tại sẽ không giới hạn thao tác này.`)) return;
    setActionInProgress("resolve-all");
    try {
      await apiFetch("/api/incidents/resolve-all", { method: "POST" });
      await loadData();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Không thể giải quyết các sự cố");
    } finally {
      setActionInProgress(null);
    }
  };

  const toggleIncident = (id: string) => setExpandedIncidentIds((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <div style={{ maxWidth: 1400, margin: "0 auto", padding: "4px 0", color: "#1e293b" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap", marginBottom: 16 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: "1.5rem" }}>Vận hành</h1>
          <p style={{ margin: "4px 0 0", color: "#64748b", fontSize: "0.9rem" }}>Điều phối hàng đợi, theo dõi AI và xử lý sự cố.</p>
        </div>
        <button type="button" style={buttonStyle} disabled={loading} onClick={() => void loadData()}>
          <RefreshCw size={14} style={{ verticalAlign: "-2px", marginRight: 5 }} className={loading ? "animate-spin" : ""} /> Làm mới
        </button>
      </div>

      {error && <div role="alert" style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", padding: 12, marginBottom: 14, border: "1px solid #fecaca", borderRadius: 6, background: "#fef2f2", color: "#991b1b" }}>
        <span><AlertCircle size={16} style={{ verticalAlign: "-3px", marginRight: 6 }} />{error}</span>
        <button type="button" style={{ ...buttonStyle, borderColor: "#dc2626", color: "#991b1b" }} onClick={() => void loadData()}>Thử lại</button>
      </div>}

      <nav aria-label="Khu vực vận hành" style={{ display: "flex", gap: 6, borderBottom: "1px solid #e2e8f0", overflowX: "auto", marginBottom: 16 }}>
        {([
          ["dispatch", ListOrdered, "Điều phối"],
          ["airuns", Cpu, "Hoạt động AI"],
          ["tech", AlertTriangle, "Kỹ thuật & Sự cố"],
        ] as const).map(([tab, Icon, label]) => <button key={tab} type="button" onClick={() => setTab(tab)} style={{ border: "none", borderBottom: activeTab === tab ? "2px solid #2563eb" : "2px solid transparent", background: "transparent", padding: "10px 14px", color: activeTab === tab ? "#1d4ed8" : "#64748b", fontWeight: activeTab === tab ? 700 : 500, cursor: "pointer", whiteSpace: "nowrap" }}>
          <Icon size={16} style={{ verticalAlign: "-3px", marginRight: 6 }} />{label}{tab === "tech" && openIncidentCount > 0 ? ` (${openIncidentCount})` : ""}
        </button>)}
      </nav>

      {activeTab !== "dispatch" && <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, border: "1px solid #cbd5e1", borderRadius: 6, background: "#fff", padding: "6px 9px", flex: "1 1 260px" }}>
          <Search size={15} color="#64748b" /><input aria-label="Tìm kiếm" value={filterText} onChange={(event) => { setFilterText(event.target.value); setAiOffset(0); setIncidentOffset(0); }} placeholder="Tìm kiếm theo từ khóa..." style={{ border: 0, outline: 0, width: "100%" }} />
        </label>
        {activeTab === "airuns" && (
          <select aria-label="Trạng thái AI" value={aiStatusFilter} onChange={(event) => { setAiStatusFilter(event.target.value); setAiOffset(0); }} style={buttonStyle}>
            <option value="ALL">Mọi trạng thái</option>
            <option value="SUCCESS">Thành công (SUCCESS)</option>
            <option value="GUARD_REJECTED">Bị chặn an toàn (GUARD_REJECTED)</option>
            <option value="ERROR">Lỗi (ERROR)</option>
            <option value="STALE_ABORTED">Bị hủy do tin mới (STALE_ABORTED)</option>
          </select>
        )}
        {activeTab === "tech" && <>
          <select aria-label="Trạng thái sự cố" value={incidentStatus} onChange={(event) => { setIncidentStatus(event.target.value as IncidentStatusFilter); setIncidentOffset(0); }} style={buttonStyle}>
            <option value="OPEN">Đang mở</option>
            <option value="RESOLVED">Đã xử lý</option>
            <option value="ALL">Tất cả</option>
          </select>
          <select aria-label="Loại sự cố" value={incidentType} onChange={(event) => { setIncidentType(event.target.value); setIncidentOffset(0); }} style={buttonStyle}>
            <option value="ALL">Mọi loại</option>
            {incidentTypes.map((type) => <option key={type} value={type}>{type}</option>)}
          </select>
        </>}
      </div>}

      {activeTab === "dispatch" && <Dispatch queue={queue} jobs={jobs} loading={loading} actionInProgress={actionInProgress} onPrioritize={prioritize} />}
      {activeTab === "airuns" && (
        <AiRuns
          runs={aiRuns}
          total={aiTotal}
          offset={aiOffset}
          limit={aiLimit}
          hasMore={aiHasMore}
          onPrevPage={() => setAiOffset((prev) => Math.max(0, prev - aiLimit))}
          onNextPage={() => setAiOffset((prev) => prev + aiLimit)}
          selectedRunId={selectedRunId}
          onSelect={setSelectedRunId}
          loading={loading}
          selectedRun={selectedRun}
          actions={selectedRunActions}
        />
      )}
      {activeTab === "tech" && (
        <Tech
          incidents={incidents}
          total={incidentTotal}
          offset={incidentOffset}
          limit={incidentLimit}
          hasMore={incidentHasMore}
          onPrevPage={() => setIncidentOffset((prev) => Math.max(0, prev - incidentLimit))}
          onNextPage={() => setIncidentOffset((prev) => prev + incidentLimit)}
          jobs={jobs}
          loading={loading}
          actionInProgress={actionInProgress}
          expandedIds={expandedIncidentIds}
          openIncidentCount={openIncidentCount}
          onToggle={toggleIncident}
          onResolve={resolveIncident}
          onResolveAll={resolveAll}
        />
      )}
    </div>
  );
};

function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: 36, color: "#64748b", textAlign: "center" }}>{children}</div>;
}

function Panel({ title, children, action, footer }: { title: string; children: React.ReactNode; action?: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <section style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, overflow: "hidden", marginBottom: 16 }}>
      <header style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", padding: "12px 16px", background: "#f8fafc", borderBottom: "1px solid #e2e8f0", fontWeight: 700 }}>
        {title}{action}
      </header>
      {children}
      {footer && (
        <footer style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 16px", background: "#f8fafc", borderTop: "1px solid #e2e8f0", fontSize: "12px", color: "#64748b" }}>
          {footer}
        </footer>
      )}
    </section>
  );
}

function Dispatch({ queue, jobs, loading, actionInProgress, onPrioritize }: { queue: QueueItem[]; jobs: JobItem[]; loading: boolean; actionInProgress: string | null; onPrioritize: (id: string) => Promise<void> }) {
  return <><Panel title={`Hàng đợi (${queue.length})`}><Table><thead><tr><th>Khách hàng</th><th>Lượt</th><th>Vào hàng đợi</th><th>Sẵn sàng</th><th /></tr></thead><tbody>{queue.map((item) => <tr key={item.queueId}><td><Link to={`/inbox/${item.conversationId}`}>{item.customerName || item.conversationId}</Link></td><td>v{item.inboundVersion}</td><td>{formatTime(item.queuedAt)}</td><td>{formatTime(item.readyAt)}</td><td><button type="button" style={buttonStyle} disabled={actionInProgress === `queue:${item.conversationId}`} onClick={() => void onPrioritize(item.conversationId)}>Ưu tiên</button></td></tr>)}</tbody></Table>{!loading && queue.length === 0 && <Empty>Hàng đợi trống.</Empty>}</Panel><Panel title={`Tác vụ nền (${jobs.length})`}><Table><thead><tr><th>Loại</th><th>Trạng thái</th><th>Lần thử</th><th>Sẵn sàng</th><th>Lỗi gần nhất</th></tr></thead><tbody>{jobs.map((job) => <tr key={job.id}><td>{job.jobType}</td><td>{job.status}</td><td>{job.attempts}/{job.maxAttempts}</td><td>{formatTime(job.availableAt)}</td><td>{job.lastError || "—"}</td></tr>)}</tbody></Table>{!loading && jobs.length === 0 && <Empty>Không có tác vụ nền gần đây.</Empty>}</Panel></>;
}

function AiRuns({
  runs,
  total,
  offset,
  limit,
  hasMore,
  onPrevPage,
  onNextPage,
  selectedRunId,
  onSelect,
  loading,
  selectedRun,
  actions,
}: {
  runs: AiRunItem[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  onPrevPage: () => void;
  onNextPage: () => void;
  selectedRunId: string | null;
  onSelect: (id: string) => void;
  loading: boolean;
  selectedRun: AiRunItem | null;
  actions: OutboundActionItem[];
}) {
  const pageNum = Math.floor(offset / limit) + 1;
  const maxPage = Math.ceil(total / limit) || 1;

  const paginationControls = (
    <>
      <span>Trang {pageNum} / {maxPage} ({total} lượt)</span>
      <div style={{ display: "flex", gap: 6 }}>
        <button type="button" style={buttonStyle} disabled={offset === 0} onClick={onPrevPage}>Trước</button>
        <button type="button" style={buttonStyle} disabled={!hasMore} onClick={onNextPage}>Sau</button>
      </div>
    </>
  );

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(300px, 420px)", gap: 16 }}>
      <Panel title={`Lượt chạy AI (${total})`} footer={total > limit ? paginationControls : undefined}>
        <Table>
          <thead>
            <tr>
              <th>Khách hàng / lượt</th>
              <th>Xử lý</th>
              <th>Model</th>
              <th>Thời điểm</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={run.id} onClick={() => onSelect(run.id)} style={{ cursor: "pointer", background: selectedRunId === run.id ? "#eff6ff" : undefined }}>
                <td>{run.customerName || run.conversationTitle || run.conversationId}<br /><small>v{run.inboundVersion}</small></td>
                <td>{run.status}</td>
                <td>{run.model}</td>
                <td>{formatTime(run.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
        {!loading && runs.length === 0 && <Empty>Không có lượt chạy AI phù hợp.</Empty>}
      </Panel>
      <div style={{ minHeight: 340, border: "1px solid #e2e8f0", borderRadius: 8, overflow: "hidden" }}>
        <AiRunInspector run={selectedRun} actions={actions} />
      </div>
    </div>
  );
}

function Tech({
  incidents,
  total,
  offset,
  limit,
  hasMore,
  onPrevPage,
  onNextPage,
  jobs,
  loading,
  actionInProgress,
  expandedIds,
  openIncidentCount,
  onToggle,
  onResolve,
  onResolveAll,
}: {
  incidents: IncidentItem[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  onPrevPage: () => void;
  onNextPage: () => void;
  jobs: JobItem[];
  loading: boolean;
  actionInProgress: string | null;
  expandedIds: Set<string>;
  openIncidentCount: number;
  onToggle: (id: string) => void;
  onResolve: (item: IncidentItem, note?: string) => Promise<void>;
  onResolveAll: () => Promise<void>;
}) {
  const pageNum = Math.floor(offset / limit) + 1;
  const maxPage = Math.ceil(total / limit) || 1;

  const paginationControls = (
    <>
      <span>Trang {pageNum} / {maxPage} ({total} sự cố)</span>
      <div style={{ display: "flex", gap: 6 }}>
        <button type="button" style={buttonStyle} disabled={offset === 0} onClick={onPrevPage}>Trước</button>
        <button type="button" style={buttonStyle} disabled={!hasMore} onClick={onNextPage}>Sau</button>
      </div>
    </>
  );

  return (
    <>
      <Panel
        title={`Sự cố (${total})`}
        action={openIncidentCount > 0 ? <button type="button" style={{ ...buttonStyle, borderColor: "#dc2626", color: "#991b1b" }} disabled={actionInProgress === "resolve-all"} onClick={() => void onResolveAll()}>Đóng tất cả</button> : undefined}
        footer={total > limit ? paginationControls : undefined}
      >
        <div>
          {incidents.map((incident) => {
            const expanded = expandedIds.has(incident.id);
            const safety = getIncidentSafetyPolicy(incident);
            return (
              <article key={incident.id} style={{ padding: 14, borderBottom: "1px solid #e2e8f0" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
                  <button type="button" onClick={() => onToggle(incident.id)} style={{ border: 0, background: "transparent", textAlign: "left", cursor: "pointer", padding: 0, fontWeight: 700, color: "#1e293b" }}>
                    {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />} {incident.title} <small style={{ color: "#64748b" }}>({incident.type} · {incident.status})</small>
                  </button>
                  {incident.status === "OPEN" && (
                    <button type="button" style={buttonStyle} disabled={actionInProgress === incident.id} onClick={() => void onResolve(incident, "Đã xử lý")}>
                      Giải quyết
                    </button>
                  )}
                </div>
                <p style={{ margin: "7px 0 0", color: "#475569" }}>{incident.description}</p>
                {expanded && (
                  <div style={{ marginTop: 10, padding: 10, background: "#f8fafc", borderRadius: 6, fontSize: "13px" }}>
                    <p style={{ margin: 0 }}>{safety.warningMessage}</p>
                    {incident.conversationId && (
                      <p>
                        <Link to={`/inbox/${incident.conversationId}`}>
                          Mở hội thoại liên quan <ArrowRight size={12} />
                        </Link>
                      </p>
                    )}
                    {(isCheckpoint(incident) || isDomDegraded(incident)) && (
                      <p style={{ marginBottom: 0, color: "#92400e" }}>
                        Việc giải quyết sự cố không tự tiếp tục kênh hoặc nhả chế độ người xử lý. Chỉ resume kênh sau khi đã xác minh điều kiện phục hồi.
                      </p>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
        {!loading && incidents.length === 0 && <Empty><CheckCircle2 size={22} /> Không có sự cố phù hợp.</Empty>}
      </Panel>
      <Panel title={`Tác vụ nền gần đây (${jobs.length})`}>
        <Table>
          <thead>
            <tr>
              <th>Loại</th>
              <th>Trạng thái</th>
              <th>Lần thử</th>
              <th>Khóa đến</th>
              <th>Lỗi</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <tr key={job.id}>
                <td>{job.jobType}</td>
                <td>{job.status}</td>
                <td>{job.attempts}/{job.maxAttempts}</td>
                <td>{job.lockedUntil ? formatTime(job.lockedUntil) : "—"}</td>
                <td>{job.lastError || "—"}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Panel>
    </>
  );
}

function Table({ children }: { children: React.ReactNode }) {
  return <div style={{ overflowX: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>{children}</table><style>{"th, td { padding: 10px 14px; text-align: left; border-bottom: 1px solid #f1f5f9; } th { color: #64748b; background: #f8fafc; font-size: 12px; }"}</style></div>;
}
