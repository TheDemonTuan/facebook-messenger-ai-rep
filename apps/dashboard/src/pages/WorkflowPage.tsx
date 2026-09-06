import React, { useEffect, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "../api";
import type { WorkflowLiveData, WorkflowNode } from "../types";
import { useSseWakeup } from "../context/SseContext";
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

  const loadWorkflow = useCallback(async () => {
    try {
      const res = await apiFetch<WorkflowLiveData>("/api/workflow/live");
      setData(res);
      // Keep selected node up to date if open
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

  // SSE wakeup: refetch immediately on any channel/turn/message event
  useSseWakeup(() => true, loadWorkflow);

  const getNodeIcon = (id: string) => {
    switch (id) {
      case "inbound":
        return <Radio className="w-5 h-5" />;
      case "debounce":
        return <Layers className="w-5 h-5" />;
      case "policy":
        return <ShieldCheck className="w-5 h-5" />;
      case "context":
        return <BookOpen className="w-5 h-5" />;
      case "llm":
        return <Cpu className="w-5 h-5" />;
      case "guards":
        return <CheckCircle2 className="w-5 h-5" />;
      case "typing":
        return <Keyboard className="w-5 h-5" />;
      case "delivery":
        return <Send className="w-5 h-5" />;
      default:
        return <Workflow className="w-5 h-5" />;
    }
  };

  const getStatusBadge = (status: WorkflowNode["status"]) => {
    switch (status) {
      case "active":
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-blue-100 text-blue-800 animate-pulse border border-blue-300">
            <span className="w-2 h-2 rounded-full bg-blue-600"></span>
            Đang xử lý
          </span>
        );
      case "waiting":
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-800 border border-amber-300">
            <span className="w-2 h-2 rounded-full bg-amber-500 animate-ping"></span>
            Đang chờ
          </span>
        );
      case "completed":
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-800 border border-emerald-300">
            <CheckCheck className="w-3.5 h-3.5 text-emerald-600" />
            Đã xong
          </span>
        );
      case "error":
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-rose-100 text-rose-800 border border-rose-300">
            <AlertTriangle className="w-3.5 h-3.5 text-rose-600" />
            Sự cố
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-gray-100 text-gray-600 border border-gray-200">
            <span className="w-1.5 h-1.5 rounded-full bg-gray-400"></span>
            Sẵn sàng
          </span>
        );
    }
  };

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center min-h-[400px] gap-3 text-slate-500">
        <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
        <span className="font-medium text-base">Đang tải sơ đồ luồng workflow...</span>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="p-6 max-w-xl mx-auto my-8 bg-rose-50 border border-rose-200 rounded-xl text-rose-900">
        <div className="flex items-center gap-2 font-semibold text-lg mb-2 text-rose-800">
          <AlertTriangle className="w-5 h-5 text-rose-600" />
          Không thể tải luồng xử lý
        </div>
        <p className="text-sm mb-4">{error}</p>
        <button
          onClick={loadWorkflow}
          className="px-4 py-2 bg-rose-600 text-white rounded-lg text-sm font-medium hover:bg-rose-700 transition shadow"
        >
          Thử lại
        </button>
      </div>
    );
  }

  const nodes = data?.nodes || [];

  return (
    <div className="space-y-6 pb-12">
      {/* 1. Header & Live Telemetry Bar */}
      <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-5 border-b border-slate-100">
          <div>
            <div className="flex items-center gap-3">
              <div className="p-2.5 bg-blue-50 text-blue-600 rounded-xl border border-blue-100 shadow-sm">
                <Workflow className="w-6 h-6" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-slate-900 tracking-tight">
                  Luồng xử lý AI (Workflow Graph)
                </h1>
                <p className="text-sm text-slate-500 mt-0.5">
                  Sơ đồ đường đi thời gian thực: tiếp nhận tin nhắn, hàng đợi, suy luận AI, kiểm tra an toàn đến gõ phím & gửi
                </p>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2.5 flex-wrap">
            {/* View switcher */}
            <div className="inline-flex p-1 bg-slate-100 rounded-xl border border-slate-200 text-xs font-medium">
              <button
                onClick={() => setViewMode("graph")}
                className={`px-3 py-1.5 rounded-lg transition ${
                  viewMode === "graph"
                    ? "bg-white text-blue-700 shadow-xs font-semibold"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                Sơ đồ n8n
              </button>
              <button
                onClick={() => setViewMode("trace")}
                className={`px-3 py-1.5 rounded-lg transition ${
                  viewMode === "trace"
                    ? "bg-white text-blue-700 shadow-xs font-semibold"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                Nhật ký vết (Trace)
              </button>
            </div>

            <button
              onClick={loadWorkflow}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-xl hover:bg-slate-50 transition shadow-2xs"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Làm mới
            </button>

            <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-xl text-xs font-medium">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
              Thời gian thực
            </div>
          </div>
        </div>

        {/* Real-time Status Callout */}
        <div className="mt-5 grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Waiting For / Stage */}
          <div className="md:col-span-2 p-4 rounded-xl bg-gradient-to-r from-blue-50/70 to-indigo-50/70 border border-blue-100 flex items-start gap-3.5">
            <div className="p-2 bg-blue-600 text-white rounded-lg shadow-sm shrink-0 mt-0.5">
              <Activity className="w-5 h-5 animate-pulse" />
            </div>
            <div className="min-w-0">
              <div className="text-xs font-semibold uppercase tracking-wider text-blue-700 mb-0.5">
                Đang xử lý & Chờ đợi
              </div>
              <div className="text-sm font-bold text-slate-900 truncate">
                {data?.waitingReason}
              </div>
              {data?.activeConversation && (
                <div className="flex items-center gap-2 text-xs text-slate-600 mt-1">
                  <User className="w-3.5 h-3.5 text-blue-500" />
                  <span>Đối tượng: <strong className="text-slate-800">{data.activeConversation.title}</strong></span>
                  <Link
                    to={`/inbox/${data.activeConversation.id}`}
                    className="text-blue-600 hover:underline inline-flex items-center gap-0.5"
                  >
                    Xem chat <ChevronRight className="w-3 h-3" />
                  </Link>
                </div>
              )}
            </div>
          </div>

          {/* Incidents or Healthy Indicator */}
          {data?.openIncidents && data.openIncidents.length > 0 ? (
            <div className="p-4 rounded-xl bg-rose-50 border border-rose-200 flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-rose-600 shrink-0 mt-0.5" />
              <div>
                <div className="text-xs font-semibold uppercase tracking-wider text-rose-700 mb-0.5">
                  Cảnh báo sự cố ({data.openIncidents.length})
                </div>
                <div className="text-sm font-semibold text-rose-900 truncate">
                  {data.openIncidents[0]!.title}
                </div>
                <Link
                  to="/incidents"
                  className="text-xs font-medium text-rose-700 hover:underline mt-1 inline-flex items-center gap-1"
                >
                  Đối soát ngay <ChevronRight className="w-3 h-3" />
                </Link>
              </div>
            </div>
          ) : (
            <div className="p-4 rounded-xl bg-emerald-50/60 border border-emerald-100 flex items-start gap-3">
              <ShieldCheck className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
              <div>
                <div className="text-xs font-semibold uppercase tracking-wider text-emerald-700 mb-0.5">
                  Tình trạng hệ thống
                </div>
                <div className="text-sm font-semibold text-emerald-900">
                  Không có sự cố nào bị nghẽn
                </div>
                <div className="text-xs text-emerald-700/80 mt-1">
                  Tất cả 8 cổng xử lý đang vận hành trơn tru
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 2. Visual Workflow Graph (n8n canvas style) */}
      {viewMode === "graph" ? (
        <div className="relative bg-slate-900/95 border border-slate-800 rounded-3xl p-6 lg:p-8 shadow-xl overflow-x-auto text-slate-100">
          {/* Canvas Background Grid Pattern */}
          <div
            className="absolute inset-0 rounded-3xl pointer-events-none opacity-20"
            style={{
              backgroundImage: "radial-gradient(circle, #94a3b8 1px, transparent 1px)",
              backgroundSize: "24px 24px",
            }}
          />

          <div className="relative z-10 flex flex-col gap-8 min-w-[900px]">
            {/* Top Row: Nodes 1 -> 4 */}
            <div>
              <div className="text-xs font-semibold uppercase tracking-widest text-slate-400 mb-4 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-blue-400"></span>
                Giai đoạn 1: Tiếp nhận & Chuẩn bị ngữ cảnh
              </div>
              <div className="grid grid-cols-4 gap-4 relative">
                {nodes.slice(0, 4).map((node, idx) => (
                  <div key={node.id} className="relative flex items-center">
                    <NodeCard
                      node={node}
                      icon={getNodeIcon(node.id)}
                      statusBadge={getStatusBadge(node.status)}
                      isSelected={selectedNode?.id === node.id}
                      onClick={() => setSelectedNode(node)}
                    />
                    {idx < 3 && (
                      <div className="hidden lg:flex absolute -right-4 top-1/2 -translate-y-1/2 z-20 text-slate-500">
                        <ArrowRight className="w-5 h-5 text-slate-600" />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Connecting transition pipe */}
            <div className="flex justify-end pr-16 text-slate-600">
              <div className="flex items-center gap-2 text-xs font-mono text-indigo-400 bg-slate-800/80 px-3 py-1 rounded-full border border-slate-700">
                <Sparkles className="w-3.5 h-3.5 text-yellow-400 animate-spin" />
                Truyền ngữ cảnh sang LLM Inference
              </div>
            </div>

            {/* Bottom Row: Nodes 5 -> 8 */}
            <div>
              <div className="text-xs font-semibold uppercase tracking-widest text-slate-400 mb-4 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
                Giai đoạn 2: Suy luận, Chuẩn hóa & Gửi tin nhắn
              </div>
              <div className="grid grid-cols-4 gap-4 relative">
                {nodes.slice(4, 8).map((node, idx) => (
                  <div key={node.id} className="relative flex items-center">
                    <NodeCard
                      node={node}
                      icon={getNodeIcon(node.id)}
                      statusBadge={getStatusBadge(node.status)}
                      isSelected={selectedNode?.id === node.id}
                      onClick={() => setSelectedNode(node)}
                    />
                    {idx < 3 && (
                      <div className="hidden lg:flex absolute -right-4 top-1/2 -translate-y-1/2 z-20 text-slate-500">
                        <ArrowRight className="w-5 h-5 text-slate-600" />
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
        <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm space-y-6">
          <div className="flex items-center justify-between pb-4 border-b border-slate-100">
            <div>
              <h2 className="text-lg font-bold text-slate-900">Vết xử lý gần nhất (Execution Trace)</h2>
              <p className="text-xs text-slate-500">
                Toàn bộ dữ liệu chuyển giao từ lúc khách nhắn tin đến khi bot hoàn tất gửi tin
              </p>
            </div>
            <div className="text-xs text-slate-400 font-mono">
              Model: {data?.latestTrace.aiModel || "auto"}
            </div>
          </div>

          <div className="space-y-4">
            {/* Step 1 */}
            <div className="p-4 bg-slate-50 rounded-xl border border-slate-200 flex items-start gap-4">
              <div className="p-2 bg-blue-100 text-blue-700 rounded-lg shrink-0 mt-0.5">
                <Radio className="w-5 h-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold text-slate-900">1. Khách gửi tin nhắn đến</div>
                  <div className="text-xs text-slate-500">
                    {data?.latestTrace.inboundTime ? new Date(data.latestTrace.inboundTime).toLocaleTimeString("vi-VN") : "—"}
                  </div>
                </div>
                <div className="text-xs text-slate-700 bg-white p-3 rounded-lg border border-slate-200 mt-2 font-mono whitespace-pre-wrap">
                  {data?.latestTrace.inboundText || "Chưa có nội dung tin nhắn gần đây"}
                </div>
              </div>
            </div>

            {/* Step 2 */}
            <div className="p-4 bg-slate-50 rounded-xl border border-slate-200 flex items-start gap-4">
              <div className="p-2 bg-purple-100 text-purple-700 rounded-lg shrink-0 mt-0.5">
                <Cpu className="w-5 h-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold text-slate-900">2. Mô hình AI suy luận & tạo câu trả lời</div>
                  <div className="text-xs text-slate-500">
                    Độ trễ: <strong className="text-slate-800">{data?.latestTrace.aiLatencyMs || 0}ms</strong>
                  </div>
                </div>
                <div className="text-xs text-slate-600 mt-1">
                  Đã qua bộ lọc rò rỉ và áp dụng quy tắc gộp danh sách sản phẩm thành 1 tin nhắn, tách câu hỏi kết thúc làm tin thứ 2.
                </div>
              </div>
            </div>

            {/* Step 3 */}
            <div className="p-4 bg-slate-50 rounded-xl border border-slate-200 flex items-start gap-4">
              <div className="p-2 bg-emerald-100 text-emerald-700 rounded-lg shrink-0 mt-0.5">
                <Send className="w-5 h-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold text-slate-900">3. Gõ phím ảo & Đã gửi đến khách hàng</div>
                  <div className="text-xs font-semibold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">
                    {data?.latestTrace.outboundStatus || "CONFIRMED"}
                  </div>
                </div>
                <div className="text-xs text-slate-700 bg-white p-3 rounded-lg border border-slate-200 mt-2 font-mono whitespace-pre-wrap">
                  {data?.latestTrace.outboundText || "Chưa có nội dung tin gửi gần đây"}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 4. Selected Node Inspector Drawer (Slide-out or Card) */}
      {selectedNode && (
        <div className="fixed inset-y-0 right-0 z-50 w-full max-w-md bg-white border-l border-slate-200 shadow-2xl p-6 flex flex-col justify-between overflow-y-auto animate-in slide-in-from-right duration-200">
          <div>
            <div className="flex items-center justify-between pb-4 border-b border-slate-100">
              <div className="flex items-center gap-2.5">
                <div className="p-2 bg-blue-50 text-blue-600 rounded-lg">
                  {getNodeIcon(selectedNode.id)}
                </div>
                <div>
                  <h3 className="font-bold text-base text-slate-900">{selectedNode.name}</h3>
                  <div className="text-xs text-slate-500 font-mono">{selectedNode.subtitle}</div>
                </div>
              </div>
              <button
                onClick={() => setSelectedNode(null)}
                className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-100 transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="mt-5 space-y-5">
              {/* Status */}
              <div>
                <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
                  Trạng thái hiện tại
                </div>
                <div>{getStatusBadge(selectedNode.status)}</div>
              </div>

              {/* Activity */}
              <div>
                <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">
                  Hoạt động tức thì
                </div>
                <div className="p-3 bg-slate-50 rounded-xl text-xs font-mono text-slate-800 border border-slate-200 break-words">
                  {selectedNode.activity}
                </div>
              </div>

              {/* Metrics */}
              <div>
                <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
                  Chỉ số thời gian thực
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {selectedNode.metrics.map((m, i) => (
                    <div key={i} className="p-3 bg-slate-50 rounded-xl border border-slate-200">
                      <div className="text-xs text-slate-500">{m.label}</div>
                      <div className="text-sm font-bold text-slate-900 mt-0.5">{m.value}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Technical Config / Payload */}
              <div>
                <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
                  Chi tiết kỹ thuật & Cấu hình
                </div>
                <pre className="p-3 bg-slate-900 text-slate-200 rounded-xl text-xs font-mono overflow-x-auto max-h-56">
                  {JSON.stringify(selectedNode.details, null, 2)}
                </pre>
              </div>
            </div>
          </div>

          <div className="pt-6 border-t border-slate-100 flex gap-2">
            <button
              onClick={() => setSelectedNode(null)}
              className="w-full py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-semibold rounded-xl transition"
            >
              Đóng
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

const NodeCard: React.FC<NodeCardProps> = ({ node, icon, statusBadge, isSelected, onClick }) => {
  const isGlowing = node.status === "active";
  const isError = node.status === "error";

  return (
    <div
      onClick={onClick}
      className={`w-full text-left p-4 rounded-2xl transition-all duration-200 cursor-pointer border ${
        isSelected
          ? "ring-2 ring-blue-400 bg-slate-800 border-blue-500 shadow-lg scale-[1.02]"
          : isError
          ? "bg-rose-950/40 border-rose-500/80 hover:border-rose-400"
          : isGlowing
          ? "bg-blue-950/40 border-blue-400 shadow-md shadow-blue-500/20 hover:scale-[1.01]"
          : "bg-slate-800/80 border-slate-700/80 hover:border-slate-600 hover:bg-slate-800"
      }`}
    >
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <div
            className={`p-2 rounded-xl shrink-0 ${
              isGlowing
                ? "bg-blue-600 text-white shadow-sm shadow-blue-500/50"
                : isError
                ? "bg-rose-600 text-white"
                : "bg-slate-700 text-slate-300"
            }`}
          >
            {icon}
          </div>
          <span className="text-xs font-bold text-slate-400">Node {node.step}</span>
        </div>
        <div>{statusBadge}</div>
      </div>

      <div className="mb-2">
        <div className="font-bold text-sm text-white truncate">{node.name}</div>
        <div className="text-xs text-slate-400 truncate mt-0.5">{node.subtitle}</div>
      </div>

      <div className="p-2.5 rounded-xl bg-slate-900/60 border border-slate-700/60 text-xs font-mono text-slate-300 truncate mb-3">
        {node.activity}
      </div>

      <div className="grid grid-cols-2 gap-1.5 pt-2 border-t border-slate-700/60 text-xs">
        {node.metrics.slice(0, 2).map((m, i) => (
          <div key={i} className="truncate">
            <span className="text-slate-400">{m.label}:</span>{" "}
            <strong className="text-slate-200">{m.value}</strong>
          </div>
        ))}
      </div>
    </div>
  );
};
