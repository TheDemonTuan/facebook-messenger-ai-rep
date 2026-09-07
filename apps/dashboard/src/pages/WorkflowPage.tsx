import React, { useEffect, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "../api";
import type { WorkflowLiveData, WorkflowNode } from "../types";
import { useSseWakeup } from "../context/SseContext";
import { useAuth } from "../context/AuthContext";
import {
  Workflow,
  Radio,
  Layers,
  ShieldCheck,
  BookOpen,
  Cpu,
  CheckCircle2,
  Keyboard,
  Send,
  AlertTriangle,
  User,
  ArrowRight,
  RefreshCw,
  Loader2,
  ChevronRight,
  X,
  Activity,
  CheckCheck,
  Sparkles,
} from "lucide-react";

export const WorkflowPage: React.FC = () => {
  const [data, setData] = useState<WorkflowLiveData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<WorkflowNode | null>(null);
  const [viewMode, setViewMode] = useState<"graph" | "trace">("graph");
  const [resolvingAll, setResolvingAll] = useState(false);
  const { user } = useAuth();
  const canResolveIncidents = user?.role === "OWNER" || user?.role === "OPERATOR";

  const loadWorkflow = useCallback(async () => {
    try {
      const res = await apiFetch<WorkflowLiveData>("/api/workflow/live");
      setData(res);
      if (selectedNode) {
        const updated = res.nodes.find((n) => n.id === selectedNode.id);
        if (updated) setSelectedNode(updated);
      }
    } catch (err: unknown) {
      setError((err as Error).message || "Không thể tải dữ liệu luồng xử lý");
    } finally {
      setLoading(false);
    }
  }, [selectedNode]);

  useEffect(() => {
    loadWorkflow();
    const interval = setInterval(loadWorkflow, 4000);
    return () => clearInterval(interval);
  }, [loadWorkflow]);

  useSseWakeup(() => true, loadWorkflow);

  const handleResolveAllIncidents = async () => {
    if (!canResolveIncidents || !data?.openIncidents?.length) return;
    if (!confirm(`Bạn có chắc muốn đóng và giải quyết TOÀN BỘ ${data.openIncidents.length} sự cố đang mở?`)) {
      return;
    }
    setResolvingAll(true);
    try {
      await apiFetch("/api/incidents/resolve-all", { method: "POST" });
      await loadWorkflow();
    } catch (err: unknown) {
      alert((err as Error).message);
    } finally {
      setResolvingAll(false);
    }
  };

  const getNodeIcon = (id: string) => {
    const iconSize = 20;
    switch (id) {
      case "inbound":
        return <Radio size={iconSize} />;
      case "debounce":
        return <Layers size={iconSize} />;
      case "policy":
        return <ShieldCheck size={iconSize} />;
      case "context":
        return <BookOpen size={iconSize} />;
      case "llm":
        return <Cpu size={iconSize} />;
      case "guards":
        return <CheckCircle2 size={iconSize} />;
      case "typing":
        return <Keyboard size={iconSize} />;
      case "delivery":
        return <Send size={iconSize} />;
      default:
        return <Workflow size={iconSize} />;
    }
  };

  const renderStatusBadge = (status: WorkflowNode["status"]) => {
    const badgeStyle: React.CSSProperties = {
      display: "inline-flex",
      alignItems: "center",
      gap: "6px",
      padding: "3px 10px",
      borderRadius: "9999px",
      fontSize: "0.75rem",
      fontWeight: 600,
    };

    switch (status) {
      case "active":
        return (
          <span style={{ ...badgeStyle, backgroundColor: "#dbeafe", color: "#1e40af", border: "1px solid #93c5fd" }}>
            <span style={{ width: "8px", height: "8px", borderRadius: "50%", backgroundColor: "#2563eb", display: "inline-block" }}></span>
            Đang xử lý
          </span>
        );
      case "waiting":
        return (
          <span style={{ ...badgeStyle, backgroundColor: "#fef3c7", color: "#92400e", border: "1px solid #fcd34d" }}>
            <span style={{ width: "8px", height: "8px", borderRadius: "50%", backgroundColor: "#d97706", display: "inline-block" }}></span>
            Đang chờ
          </span>
        );
      case "completed":
        return (
          <span style={{ ...badgeStyle, backgroundColor: "#d1fae5", color: "#065f46", border: "1px solid #6ee7b7" }}>
            <CheckCheck size={14} color="#059669" />
            Đã xong
          </span>
        );
      case "error":
        return (
          <span style={{ ...badgeStyle, backgroundColor: "#fee2e2", color: "#991b1b", border: "1px solid #fca5a5" }}>
            <AlertTriangle size={14} color="#dc2626" />
            Sự cố
          </span>
        );
      default:
        return (
          <span style={{ ...badgeStyle, backgroundColor: "#f1f5f9", color: "#475569", border: "1px solid #e2e8f0" }}>
            <span style={{ width: "6px", height: "6px", borderRadius: "50%", backgroundColor: "#94a3b8", display: "inline-block" }}></span>
            Sẵn sàng
          </span>
        );
    }
  };

  if (loading && !data) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "350px", gap: "10px", color: "#64748b" }}>
        <Loader2 size={24} className="animate-spin" />
        <span style={{ fontWeight: 500, fontSize: "1rem" }}>Đang tải sơ đồ luồng workflow...</span>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div style={{ padding: "24px", maxWidth: "600px", margin: "32px auto", backgroundColor: "#fef2f2", border: "1px solid #fecaca", borderRadius: "12px", color: "#991b1b" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", fontWeight: "bold", fontSize: "1.1rem", marginBottom: "8px" }}>
          <AlertTriangle size={20} color="#dc2626" />
          Không thể tải luồng xử lý
        </div>
        <p style={{ fontSize: "0.875rem", marginBottom: "16px" }}>{error}</p>
        <button
          onClick={loadWorkflow}
          style={{ padding: "8px 16px", backgroundColor: "#dc2626", color: "#ffffff", borderRadius: "8px", border: "none", fontWeight: 600, cursor: "pointer" }}
        >
          Thử lại
        </button>
      </div>
    );
  }

  const nodes = data?.nodes || [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px", paddingBottom: "40px" }}>
      {/* 1. Header & Live Telemetry Bar */}
      <div style={{ backgroundColor: "#ffffff", border: "1px solid #e2e8f0", borderRadius: "16px", padding: "20px", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "16px", paddingBottom: "16px", borderBottom: "1px solid #f1f5f9" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <div style={{ padding: "10px", backgroundColor: "#eff6ff", color: "#2563eb", borderRadius: "12px", border: "1px solid #dbeafe" }}>
              <Workflow size={24} />
            </div>
            <div>
              <h1 style={{ margin: 0, fontSize: "1.35rem", fontWeight: "bold", color: "#0f172a" }}>
                Luồng xử lý AI (Workflow Graph)
              </h1>
              <div style={{ fontSize: "0.85rem", color: "#64748b", marginTop: "2px" }}>
                Sơ đồ thời gian thực: tiếp nhận tin nhắn, hàng đợi, suy luận AI, kiểm tra an toàn đến gõ phím & gửi
              </div>
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
            {/* View switcher */}
            <div style={{ display: "inline-flex", padding: "3px", backgroundColor: "#f1f5f9", borderRadius: "10px", border: "1px solid #e2e8f0" }}>
              <button
                onClick={() => setViewMode("graph")}
                style={{
                  padding: "6px 14px",
                  borderRadius: "8px",
                  fontSize: "0.8rem",
                  fontWeight: viewMode === "graph" ? 700 : 500,
                  border: "none",
                  cursor: "pointer",
                  backgroundColor: viewMode === "graph" ? "#ffffff" : "transparent",
                  color: viewMode === "graph" ? "#1d4ed8" : "#64748b",
                  boxShadow: viewMode === "graph" ? "0 1px 3px rgba(0,0,0,0.1)" : "none",
                }}
              >
                Sơ đồ n8n
              </button>
              <button
                onClick={() => setViewMode("trace")}
                style={{
                  padding: "6px 14px",
                  borderRadius: "8px",
                  fontSize: "0.8rem",
                  fontWeight: viewMode === "trace" ? 700 : 500,
                  border: "none",
                  cursor: "pointer",
                  backgroundColor: viewMode === "trace" ? "#ffffff" : "transparent",
                  color: viewMode === "trace" ? "#1d4ed8" : "#64748b",
                  boxShadow: viewMode === "trace" ? "0 1px 3px rgba(0,0,0,0.1)" : "none",
                }}
              >
                Nhật ký vết (Trace)
              </button>
            </div>

            <button
              onClick={loadWorkflow}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                padding: "7px 12px",
                fontSize: "0.8rem",
                fontWeight: 600,
                color: "#334155",
                backgroundColor: "#ffffff",
                border: "1px solid #cbd5e1",
                borderRadius: "10px",
                cursor: "pointer",
              }}
            >
              <RefreshCw size={14} />
              Làm mới
            </button>

            <div style={{ display: "inline-flex", alignItems: "center", gap: "6px", padding: "7px 12px", backgroundColor: "#ecfdf5", color: "#065f46", border: "1px solid #a7f3d0", borderRadius: "10px", fontSize: "0.8rem", fontWeight: 600 }}>
              <span style={{ width: "8px", height: "8px", borderRadius: "50%", backgroundColor: "#10b981", display: "inline-block" }}></span>
              Thời gian thực
            </div>
          </div>
        </div>

        {/* Real-time Status Callout */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "12px", marginTop: "16px" }}>
          {/* Waiting For / Stage */}
          <div style={{ padding: "14px", borderRadius: "12px", backgroundColor: "#f0fdf4", border: "1px solid #bbf7d0", display: "flex", alignItems: "flex-start", gap: "12px" }}>
            <div style={{ padding: "8px", backgroundColor: "#16a34a", color: "#ffffff", borderRadius: "8px", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Activity size={18} />
            </div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: "0.75rem", fontWeight: 700, textTransform: "uppercase", color: "#15803d", letterSpacing: "0.05em", marginBottom: "2px" }}>
                Đang xử lý & Chờ đợi
              </div>
              <div style={{ fontSize: "0.9rem", fontWeight: 700, color: "#0f172a", wordBreak: "break-word" }}>
                {data?.waitingReason}
              </div>
              {data?.activeConversation && (
                <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "0.8rem", color: "#475569", marginTop: "4px" }}>
                  <User size={14} color="#2563eb" />
                  <span>Đối tượng: <strong style={{ color: "#0f172a" }}>{data.activeConversation.title}</strong></span>
                  <Link
                    to={`/inbox/${data.activeConversation.id}`}
                    style={{ color: "#2563eb", textDecoration: "underline", display: "inline-flex", alignItems: "center", gap: "2px" }}
                  >
                    Xem chat <ChevronRight size={12} />
                  </Link>
                </div>
              )}
            </div>
          </div>

          {/* Incidents / Alert bar */}
          {data?.openIncidents && data.openIncidents.length > 0 ? (
            <div style={{ padding: "14px", borderRadius: "12px", backgroundColor: "#fef2f2", border: "1px solid #fecaca", display: "flex", alignItems: "flex-start", gap: "12px" }}>
              <div style={{ padding: "8px", backgroundColor: "#dc2626", color: "#ffffff", borderRadius: "8px", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <AlertTriangle size={18} />
              </div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ fontSize: "0.75rem", fontWeight: 700, textTransform: "uppercase", color: "#b91c1c", letterSpacing: "0.05em" }}>
                    Cảnh báo sự cố ({data.openIncidents.length})
                  </div>
                  {canResolveIncidents ? (
                    <button
                      onClick={handleResolveAllIncidents}
                      disabled={resolvingAll}
                      style={{
                        padding: "3px 8px",
                        fontSize: "0.75rem",
                        fontWeight: 600,
                        backgroundColor: "#fee2e2",
                        color: "#991b1b",
                        border: "1px solid #f87171",
                        borderRadius: "6px",
                        cursor: resolvingAll ? "wait" : "pointer",
                      }}
                    >
                      {resolvingAll ? "Đang đóng..." : "Đóng tất cả"}
                    </button>
                  ) : (
                    <span
                      title="Chỉ Quản trị viên hoặc Chủ sở hữu mới có thể đóng sự cố"
                      style={{ fontSize: "0.75rem", color: "#991b1b", fontWeight: 600 }}
                    >
                      Chỉ xem
                    </span>
                  )}
                </div>
                <div style={{ fontSize: "0.85rem", fontWeight: 600, color: "#7f1d1d", marginTop: "2px", wordBreak: "break-word" }}>
                  {data.openIncidents[0]!.title}
                </div>
                <div style={{ marginTop: "4px" }}>
                  <Link
                    to="/incidents"
                    style={{ fontSize: "0.75rem", fontWeight: 600, color: "#dc2626", textDecoration: "underline", display: "inline-flex", alignItems: "center", gap: "4px" }}
                  >
                    Đối soát trong trang Sự cố <ChevronRight size={12} />
                  </Link>
                </div>
              </div>
            </div>
          ) : (
            <div style={{ padding: "14px", borderRadius: "12px", backgroundColor: "#f8fafc", border: "1px solid #e2e8f0", display: "flex", alignItems: "flex-start", gap: "12px" }}>
              <div style={{ padding: "8px", backgroundColor: "#059669", color: "#ffffff", borderRadius: "8px", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <ShieldCheck size={18} />
              </div>
              <div>
                <div style={{ fontSize: "0.75rem", fontWeight: 700, textTransform: "uppercase", color: "#047857", letterSpacing: "0.05em", marginBottom: "2px" }}>
                  Tình trạng kiểm soát
                </div>
                <div style={{ fontSize: "0.9rem", fontWeight: 700, color: "#0f172a" }}>
                  Không có sự cố nào bị kẹt
                </div>
                <div style={{ fontSize: "0.8rem", color: "#64748b", marginTop: "2px" }}>
                  Tất cả 8 cổng xử lý đang sẵn sàng và hoạt động bình thường
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 2. Visual Workflow Graph (n8n canvas style with rich dark theme) */}
      {viewMode === "graph" ? (
        <div
          style={{
            position: "relative",
            backgroundColor: "#0f172a",
            border: "1px solid #1e293b",
            borderRadius: "20px",
            padding: "24px",
            boxShadow: "0 10px 25px -5px rgba(0, 0, 0, 0.3)",
            overflowX: "auto",
            color: "#f8fafc",
          }}
        >
          {/* Canvas header banner */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px", paddingBottom: "12px", borderBottom: "1px solid #1e293b" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "0.85rem", fontWeight: 700, color: "#94a3b8" }}>
              <Sparkles size={16} color="#38bdf8" />
              <span>SƠ ĐỒ TIẾN TRÌNH XỬ LÝ (PIPELINE DAG - 8 NODES)</span>
            </div>
            <div style={{ fontSize: "0.75rem", color: "#64748b" }}>
              Bấm vào từng Node để xem chi tiết thông số và dữ liệu thô
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "28px", minWidth: "980px" }}>
            {/* Giai đoạn 1: Nodes 1 -> 4 */}
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "0.75rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: "#38bdf8", marginBottom: "12px" }}>
                <span style={{ width: "8px", height: "8px", borderRadius: "50%", backgroundColor: "#38bdf8", display: "inline-block" }}></span>
                Giai đoạn 1: Tiếp nhận tin nhắn & Chuẩn bị ngữ cảnh
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "14px", position: "relative" }}>
                {nodes.slice(0, 4).map((node, idx) => (
                  <div key={node.id} style={{ position: "relative" }}>
                    <NodeCardComponent
                      node={node}
                      icon={getNodeIcon(node.id)}
                      statusBadge={renderStatusBadge(node.status)}
                      isSelected={selectedNode?.id === node.id}
                      onClick={() => setSelectedNode(node)}
                    />
                    {idx < 3 && (
                      <div
                        style={{
                          position: "absolute",
                          right: "-12px",
                          top: "50%",
                          transform: "translateY(-50%)",
                          zIndex: 10,
                          color: "#64748b",
                          pointerEvents: "none",
                        }}
                      >
                        <ArrowRight size={18} />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Connecting Transition Connector */}
            <div style={{ display: "flex", justifyContent: "flex-end", paddingRight: "40px" }}>
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "8px",
                  fontSize: "0.75rem",
                  fontFamily: "monospace",
                  color: "#a5b4fc",
                  backgroundColor: "#1e1b4b",
                  border: "1px solid #4338ca",
                  padding: "4px 14px",
                  borderRadius: "9999px",
                }}
              >
                <ArrowRight size={14} color="#818cf8" />
                <span>Nạp Prompt & Lịch sử sang Giai đoạn 2 (Inference & Gửi)</span>
              </div>
            </div>

            {/* Giai đoạn 2: Nodes 5 -> 8 */}
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "0.75rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: "#34d399", marginBottom: "12px" }}>
                <span style={{ width: "8px", height: "8px", borderRadius: "50%", backgroundColor: "#34d399", display: "inline-block" }}></span>
                Giai đoạn 2: Suy luận AI, Chuẩn hóa gộp/tách tin & Gõ phím gửi
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "14px", position: "relative" }}>
                {nodes.slice(4, 8).map((node, idx) => (
                  <div key={node.id} style={{ position: "relative" }}>
                    <NodeCardComponent
                      node={node}
                      icon={getNodeIcon(node.id)}
                      statusBadge={renderStatusBadge(node.status)}
                      isSelected={selectedNode?.id === node.id}
                      onClick={() => setSelectedNode(node)}
                    />
                    {idx < 3 && (
                      <div
                        style={{
                          position: "absolute",
                          right: "-12px",
                          top: "50%",
                          transform: "translateY(-50%)",
                          zIndex: 10,
                          color: "#64748b",
                          pointerEvents: "none",
                        }}
                      >
                        <ArrowRight size={18} />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : (
        /* 3. Live Execution Trace View */
        <div style={{ backgroundColor: "#ffffff", border: "1px solid #e2e8f0", borderRadius: "16px", padding: "24px", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingBottom: "16px", borderBottom: "1px solid #f1f5f9", marginBottom: "16px" }}>
            <div>
              <h2 style={{ margin: 0, fontSize: "1.15rem", fontWeight: "bold", color: "#0f172a" }}>
                Vết xử lý gần nhất (Execution Trace)
              </h2>
              <div style={{ fontSize: "0.8rem", color: "#64748b", marginTop: "2px" }}>
                Chi tiết dữ liệu chuyển giao qua từng bước của tin nhắn gần nhất
              </div>
            </div>
            <div style={{ fontSize: "0.8rem", color: "#475569", fontFamily: "monospace", padding: "4px 10px", backgroundColor: "#f1f5f9", borderRadius: "8px" }}>
              Model: {data?.latestTrace.aiModel || "auto"}
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            {/* Step 1 */}
            <div style={{ padding: "16px", backgroundColor: "#f8fafc", borderRadius: "12px", border: "1px solid #e2e8f0", display: "flex", gap: "14px" }}>
              <div style={{ padding: "10px", backgroundColor: "#dbeafe", color: "#1d4ed8", borderRadius: "10px", height: "fit-content" }}>
                <Radio size={20} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ fontWeight: 700, fontSize: "0.95rem", color: "#0f172a" }}>
                    1. Khách hàng gửi tin nhắn đến
                  </div>
                  <div style={{ fontSize: "0.75rem", color: "#64748b" }}>
                    {data?.latestTrace.inboundTime ? new Date(data.latestTrace.inboundTime).toLocaleTimeString("vi-VN") : "—"}
                  </div>
                </div>
                <div style={{ marginTop: "8px", padding: "12px", backgroundColor: "#ffffff", borderRadius: "8px", border: "1px solid #cbd5e1", fontSize: "0.85rem", color: "#1e293b", fontFamily: "monospace", whiteSpace: "pre-wrap" }}>
                  {data?.latestTrace.inboundText || "Chưa có nội dung tin nhắn gần đây"}
                </div>
              </div>
            </div>

            {/* Step 2 */}
            <div style={{ padding: "16px", backgroundColor: "#f8fafc", borderRadius: "12px", border: "1px solid #e2e8f0", display: "flex", gap: "14px" }}>
              <div style={{ padding: "10px", backgroundColor: "#f3e8ff", color: "#7e22ce", borderRadius: "10px", height: "fit-content" }}>
                <Cpu size={20} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ fontWeight: 700, fontSize: "0.95rem", color: "#0f172a" }}>
                    2. Mô hình AI suy luận & Tạo câu trả lời
                  </div>
                  <div style={{ fontSize: "0.8rem", color: "#475569" }}>
                    Thời gian phản hồi: <strong style={{ color: "#0f172a" }}>{data?.latestTrace.aiLatencyMs || 0}ms</strong>
                  </div>
                </div>
                <div style={{ marginTop: "6px", fontSize: "0.8rem", color: "#64748b" }}>
                  Đã kiểm tra an toàn, áp dụng quy tắc gộp toàn bộ danh sách sản phẩm thành 1 tin nhắn và tách câu hỏi gợi mở kết thúc làm tin nhắn thứ 2.
                </div>
              </div>
            </div>

            {/* Step 3 */}
            <div style={{ padding: "16px", backgroundColor: "#f8fafc", borderRadius: "12px", border: "1px solid #e2e8f0", display: "flex", gap: "14px" }}>
              <div style={{ padding: "10px", backgroundColor: "#d1fae5", color: "#047857", borderRadius: "10px", height: "fit-content" }}>
                <Send size={20} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ fontWeight: 700, fontSize: "0.95rem", color: "#0f172a" }}>
                    3. Gõ phím ảo & Đã gửi đến khách hàng
                  </div>
                  <div style={{ fontSize: "0.75rem", fontWeight: 700, color: "#065f46", backgroundColor: "#d1fae5", padding: "2px 8px", borderRadius: "6px" }}>
                    {data?.latestTrace.outboundStatus || "CONFIRMED"}
                  </div>
                </div>
                <div style={{ marginTop: "8px", padding: "12px", backgroundColor: "#ffffff", borderRadius: "8px", border: "1px solid #cbd5e1", fontSize: "0.85rem", color: "#1e293b", fontFamily: "monospace", whiteSpace: "pre-wrap" }}>
                  {data?.latestTrace.outboundText || "Chưa có nội dung tin gửi gần đây"}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 4. Selected Node Inspector Drawer (Slide-out panel) */}
      {selectedNode && (
        <div
          style={{
            position: "fixed",
            top: 0,
            right: 0,
            bottom: 0,
            width: "440px",
            maxWidth: "90vw",
            backgroundColor: "#ffffff",
            borderLeft: "1px solid #cbd5e1",
            boxShadow: "-8px 0 25px rgba(0,0,0,0.2)",
            zIndex: 100,
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            padding: "24px",
            overflowY: "auto",
          }}
        >
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingBottom: "16px", borderBottom: "1px solid #e2e8f0" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <div style={{ padding: "8px", backgroundColor: "#eff6ff", color: "#2563eb", borderRadius: "10px" }}>
                  {getNodeIcon(selectedNode.id)}
                </div>
                <div>
                  <h3 style={{ margin: 0, fontSize: "1.1rem", fontWeight: "bold", color: "#0f172a" }}>
                    {selectedNode.name}
                  </h3>
                  <div style={{ fontSize: "0.75rem", color: "#64748b", fontFamily: "monospace" }}>
                    {selectedNode.subtitle}
                  </div>
                </div>
              </div>
              <button
                onClick={() => setSelectedNode(null)}
                style={{ background: "none", border: "none", color: "#94a3b8", cursor: "pointer", padding: "4px" }}
              >
                <X size={20} />
              </button>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "18px", marginTop: "20px" }}>
              {/* Status */}
              <div>
                <div style={{ fontSize: "0.75rem", fontWeight: 700, textTransform: "uppercase", color: "#64748b", letterSpacing: "0.05em", marginBottom: "6px" }}>
                  Trạng thái hiện tại
                </div>
                <div>{renderStatusBadge(selectedNode.status)}</div>
              </div>

              {/* Activity */}
              <div>
                <div style={{ fontSize: "0.75rem", fontWeight: 700, textTransform: "uppercase", color: "#64748b", letterSpacing: "0.05em", marginBottom: "6px" }}>
                  Hoạt động tức thì
                </div>
                <div style={{ padding: "12px", backgroundColor: "#f8fafc", borderRadius: "10px", fontSize: "0.8rem", fontFamily: "monospace", color: "#1e293b", border: "1px solid #e2e8f0", wordBreak: "break-word" }}>
                  {selectedNode.activity}
                </div>
              </div>

              {/* Metrics */}
              <div>
                <div style={{ fontSize: "0.75rem", fontWeight: 700, textTransform: "uppercase", color: "#64748b", letterSpacing: "0.05em", marginBottom: "6px" }}>
                  Chỉ số thời gian thực
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                  {selectedNode.metrics.map((m, i) => (
                    <div key={i} style={{ padding: "10px", backgroundColor: "#f8fafc", borderRadius: "10px", border: "1px solid #e2e8f0" }}>
                      <div style={{ fontSize: "0.75rem", color: "#64748b" }}>{m.label}</div>
                      <div style={{ fontSize: "0.95rem", fontWeight: "bold", color: "#0f172a", marginTop: "2px" }}>
                        {m.value}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Technical Details JSON */}
              <div>
                <div style={{ fontSize: "0.75rem", fontWeight: 700, textTransform: "uppercase", color: "#64748b", letterSpacing: "0.05em", marginBottom: "6px" }}>
                  Chi tiết cấu hình & Thông số
                </div>
                <pre style={{ padding: "12px", backgroundColor: "#0f172a", color: "#38bdf8", borderRadius: "10px", fontSize: "0.75rem", fontFamily: "monospace", overflowX: "auto", maxHeight: "200px" }}>
                  {JSON.stringify(selectedNode.details, null, 2)}
                </pre>
              </div>
            </div>
          </div>

          <div style={{ paddingTop: "16px", borderTop: "1px solid #e2e8f0" }}>
            <button
              onClick={() => setSelectedNode(null)}
              style={{
                width: "100%",
                padding: "10px",
                backgroundColor: "#f1f5f9",
                color: "#334155",
                fontSize: "0.85rem",
                fontWeight: 600,
                borderRadius: "10px",
                border: "none",
                cursor: "pointer",
              }}
            >
              Đóng chi tiết
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

interface NodeCardProps {
  node: WorkflowNode;
  icon: React.ReactNode;
  statusBadge: React.ReactNode;
  isSelected: boolean;
  onClick: () => void;
}

const NodeCardComponent: React.FC<NodeCardProps> = ({ node, icon, statusBadge, isSelected, onClick }) => {
  const isGlowing = node.status === "active";
  const isError = node.status === "error";

  return (
    <div
      onClick={onClick}
      style={{
        width: "100%",
        padding: "14px",
        borderRadius: "14px",
        cursor: "pointer",
        transition: "all 0.2s ease",
        backgroundColor: isError ? "rgba(153, 27, 27, 0.2)" : isGlowing ? "rgba(30, 58, 138, 0.3)" : "#1e293b",
        border: isSelected
          ? "2px solid #60a5fa"
          : isError
          ? "1px solid #f87171"
          : isGlowing
          ? "1px solid #60a5fa"
          : "1px solid #334155",
        boxShadow: isSelected
          ? "0 0 16px rgba(96, 165, 250, 0.5)"
          : isGlowing
          ? "0 0 12px rgba(59, 130, 246, 0.3)"
          : "none",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <div
            style={{
              padding: "7px",
              borderRadius: "8px",
              backgroundColor: isError ? "#dc2626" : isGlowing ? "#2563eb" : "#334155",
              color: "#ffffff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {icon}
          </div>
          <span style={{ fontSize: "0.75rem", fontWeight: 700, color: "#94a3b8" }}>Node {node.step}</span>
        </div>
        <div>{statusBadge}</div>
      </div>

      <div style={{ marginBottom: "8px" }}>
        <div style={{ fontWeight: 700, fontSize: "0.9rem", color: "#ffffff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {node.name}
        </div>
        <div style={{ fontSize: "0.75rem", color: "#94a3b8", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: "2px" }}>
          {node.subtitle}
        </div>
      </div>

      <div
        style={{
          padding: "8px",
          borderRadius: "8px",
          backgroundColor: "rgba(15, 23, 42, 0.7)",
          border: "1px solid #334155",
          fontSize: "0.75rem",
          fontFamily: "monospace",
          color: "#cbd5e1",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          marginBottom: "10px",
        }}
      >
        {node.activity}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px", paddingTop: "8px", borderTop: "1px solid #334155", fontSize: "0.75rem" }}>
        {node.metrics.slice(0, 2).map((m, i) => (
          <div key={i} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            <span style={{ color: "#94a3b8" }}>{m.label}:</span>{" "}
            <strong style={{ color: "#f8fafc" }}>{m.value}</strong>
          </div>
        ))}
      </div>
    </div>
  );
};
