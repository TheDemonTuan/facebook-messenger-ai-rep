import React, { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { apiFetch } from "../api";
import type { AiRunItem } from "../types";
import { formatDateTime, formatTime } from "../helpers/date-helpers";
import {
  Cpu,
  RefreshCw,
  Search,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Clock,
  Send,
  Copy,
  Sparkles,
  Terminal,
  ShieldCheck,
  MessageSquare,
  ArrowRight,
} from "lucide-react";

interface AiTestResult {
  success: boolean;
  latencyMs?: number;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  promptHash?: string;
  responseHash?: string;
  requestSnapshot?: {
    apiFormat?: "OPENAI_COMPATIBLE" | "ANTHROPIC_COMPATIBLE";
    endpoint?: string;
    method?: string;
    model?: string;
    payload?: unknown;
    [key: string]: unknown;
  };
  responseSnapshot?: {
    status?: number;
    raw?: unknown;
    content?: string | null;
    error?: string;
    [key: string]: unknown;
  };
  usedResult?: {
    messages?: string[];
    needsClarification?: boolean;
    [key: string]: unknown;
  };
  data?: {
    messages?: string[];
    needsClarification?: boolean;
    [key: string]: unknown;
  } | null;
  errorMessage?: string;
}

function formatProviderVi(apiFormat?: string, endpoint?: string): string {
  const isAnthropic = apiFormat === "ANTHROPIC_COMPATIBLE" || (endpoint && endpoint.includes("/messages"));
  if (isAnthropic) {
    return "Dịch vụ AI chuẩn Anthropic Claude";
  }
  return "Dịch vụ AI chuẩn OpenAI";
}

function formatDurationVi(ms?: number): string {
  if (ms == null || ms < 0) return "Chưa có thông tin";
  if (ms < 1000) return `${ms} mili-giây`;
  return `${(ms / 1000).toFixed(1).replace(".", ",")} giây`;
}

function formatUsageVi(total?: number, prompt?: number, completion?: number): string {
  if (total == null || total === 0) {
    if ((prompt && prompt > 0) || (completion && completion > 0)) {
      return `Nội dung gửi đi: ${prompt || 0}, nội dung nhận về: ${completion || 0}`;
    }
    return "Chưa có số liệu";
  }
  const parts: string[] = [];
  if (prompt != null && prompt > 0) parts.push(`gửi đi: ${prompt}`);
  if (completion != null && completion > 0) parts.push(`nhận về: ${completion}`);
  const details = parts.length > 0 ? ` (${parts.join(", ")})` : "";
  return `${total} đơn vị xử lý${details}`;
}

function formatStatusVi(status: string): { label: string; color: string; bgColor: string } {
  switch (status) {
    case "SUCCESS":
      return { label: "Thành công", color: "#166534", bgColor: "#dcfce7" };
    case "GUARD_REJECTED":
      return { label: "Từ chối an toàn", color: "#92400e", bgColor: "#fef3c7" };
    case "STALE_ABORTED":
      return { label: "Đã hủy do tin nhắn mới", color: "#475569", bgColor: "#f1f5f9" };
    case "ERROR":
      return { label: "Lỗi xử lý", color: "#991b1b", bgColor: "#fee2e2" };
    default:
      return { label: status, color: "#475569", bgColor: "#f1f5f9" };
  }
}

function getStatusIcon(status: string) {
  switch (status) {
    case "SUCCESS":
      return <CheckCircle2 size={13} />;
    case "GUARD_REJECTED":
      return <AlertTriangle size={13} />;
    case "ERROR":
      return <XCircle size={13} />;
    default:
      return <Clock size={13} />;
  }
}

export const AiLogsPage: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialConvId = searchParams.get("conversationId") || "";

  const [runs, setRuns] = useState<AiRunItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedRun, setSelectedRun] = useState<AiRunItem | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [convFilter, setConvFilter] = useState<string>(initialConvId);

  // Live test runner state
  const [showTester, setShowTester] = useState(false);
  const [testMessage, setTestMessage] = useState("Xin chào, shop có bán áo thun không?");
  const [testLoading, setTestLoading] = useState(false);
  const [testResult, setTestResult] = useState<AiTestResult | null>(null);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);

  const loadRuns = async (conversationId?: string, status?: string) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (conversationId && conversationId.trim()) {
        params.append("conversationId", conversationId.trim());
      }
      if (status && status !== "ALL") {
        params.append("status", status);
      }
      params.append("limit", "100");

      const res = await apiFetch<{ items: AiRunItem[] }>(`/api/ai-runs?${params.toString()}`);
      setRuns(res.items || []);
      if (res.items && res.items.length > 0 && !selectedRun) {
        setSelectedRun(res.items[0]);
      } else if (res.items && selectedRun) {
        const matched = res.items.find((r) => r.id === selectedRun.id);
        if (matched) setSelectedRun(matched);
      }
    } catch {
      // Handled
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadRuns(convFilter, statusFilter);
  }, [statusFilter]);

  const handleFilterSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (convFilter.trim()) {
      setSearchParams({ conversationId: convFilter.trim() });
    } else {
      setSearchParams({});
    }
    loadRuns(convFilter, statusFilter);
  };

  const handleRunLiveTest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!testMessage.trim() || testLoading) return;
    setTestLoading(true);
    setTestResult(null);
    try {
      const res = await apiFetch<AiTestResult>("/api/ai-runs/test", {
        method: "POST",
        body: JSON.stringify({ message: testMessage.trim() }),
      });
      setTestResult(res);
      loadRuns(convFilter, statusFilter);
    } catch (err: unknown) {
      setTestResult({
        success: false,
        errorMessage: (err as Error).message || "Lỗi không xác định trong quá trình thử nghiệm",
      });
    } finally {
      setTestLoading(false);
    }
  };

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopyNotice(label);
    setTimeout(() => setCopyNotice(null), 2000);
  };

  const getStatusBadge = (status: string) => {
    const s = formatStatusVi(status);
    return (
      <span
        style={{
          backgroundColor: s.bgColor,
          color: s.color,
          padding: "3px 8px",
          borderRadius: "4px",
          fontSize: "0.75rem",
          fontWeight: "600",
          display: "inline-flex",
          alignItems: "center",
          gap: "4px",
        }}
      >
        {getStatusIcon(status)} {s.label}
      </span>
    );
  };

  // Helper to extract customer output messages safely (never expose internalReasoning)
  const getCustomerOutputMessages = (run: AiRunItem): string[] => {
    if (run.usedResult?.messages && Array.isArray(run.usedResult.messages)) {
      return run.usedResult.messages;
    }
    const parsed = run.parsedOutput;
    if (parsed?.messages && Array.isArray(parsed.messages)) {
      return parsed.messages;
    }
    const nestedData = parsed?.data as { messages?: string[] } | undefined;
    if (nestedData?.messages && Array.isArray(nestedData.messages)) {
      return nestedData.messages;
    }
    return [];
  };

  const getCustomerOutputClarification = (run: AiRunItem): boolean => {
    if (typeof run.usedResult?.needsClarification === "boolean") {
      return run.usedResult.needsClarification;
    }
    if (typeof run.parsedOutput?.needsClarification === "boolean") {
      return run.parsedOutput.needsClarification;
    }
    const nestedData = run.parsedOutput?.data as { needsClarification?: boolean } | undefined;
    if (typeof nestedData?.needsClarification === "boolean") {
      return nestedData.needsClarification;
    }
    return false;
  };

  const renderRequestSnapshotContent = (req?: AiRunItem["requestSnapshot"]) => {
    if (!req) {
      return (
        <div style={{ color: "#64748b", fontStyle: "italic", fontSize: "0.85rem" }}>
          Lượt chạy này được ghi nhận từ phiên bản trước; chưa có bản chụp chi tiết yêu cầu.
        </div>
      );
    }

    const payload = req.payload as {
      model?: string;
      system?: string;
      messages?: Array<{ role: string; content: string }>;
    } | undefined;

    return (
      <div>
        <div
          style={{
            backgroundColor: "#f8fafc",
            border: "1px solid #e2e8f0",
            borderRadius: "6px",
            padding: "10px 12px",
            marginBottom: "12px",
            fontSize: "0.82rem",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
            <span style={{ color: "#475569" }}>Dịch vụ AI:</span>
            <span style={{ fontWeight: "600", color: "#1e293b" }}>
              {formatProviderVi(req.apiFormat, req.endpoint)}
            </span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={{ color: "#475569" }}>Mô hình xử lý:</span>
            <span style={{ fontWeight: "600", color: "#1e293b" }}>
              {req.model || payload?.model || "Mặc định"}
            </span>
          </div>
        </div>

        {/* System Prompt (if Anthropic format or system message) */}
        {payload?.system && (
          <div style={{ marginBottom: "12px" }}>
            <div style={{ fontWeight: "600", color: "#334155", fontSize: "0.8rem", marginBottom: "4px" }}>
              Hướng dẫn dành cho AI:
            </div>
            <div
              style={{
                backgroundColor: "#f8fafc",
                border: "1px solid #cbd5e1",
                borderRadius: "6px",
                padding: "8px 10px",
                fontSize: "0.8rem",
                color: "#334155",
                whiteSpace: "pre-wrap",
                maxHeight: "150px",
                overflowY: "auto",
              }}
            >
              {payload.system}
            </div>
          </div>
        )}

        {/* Message history sent to provider */}
        {payload?.messages && Array.isArray(payload.messages) && (
          <div>
            <div style={{ fontWeight: "600", color: "#334155", fontSize: "0.8rem", marginBottom: "6px" }}>
              Nội dung hội thoại gửi đi ({payload.messages.length} phần):
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "8px", maxHeight: "280px", overflowY: "auto" }}>
              {payload.messages.map((m, idx) => {
                const isUser = m.role === "user";
                const isSystem = m.role === "system";
                return (
                  <div
                    key={idx}
                    style={{
                      backgroundColor: isUser ? "#eff6ff" : isSystem ? "#f1f5f9" : "#f0fdf4",
                      border: `1px solid ${isUser ? "#bfdbfe" : isSystem ? "#cbd5e1" : "#bbf7d0"}`,
                      borderRadius: "6px",
                      padding: "8px 10px",
                      fontSize: "0.82rem",
                    }}
                  >
                    <div style={{ fontWeight: "600", fontSize: "0.75rem", color: isUser ? "#1d4ed8" : isSystem ? "#475569" : "#15803d", marginBottom: "2px" }}>
                      {isUser ? "Khách hàng" : isSystem ? "Hướng dẫn hệ thống" : "Trợ lý phản hồi trước"}:
                    </div>
                    <div style={{ whiteSpace: "pre-wrap", color: "#1e293b" }}>{m.content}</div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    );
  };

  const renderResponseSnapshotContent = (res?: AiRunItem["responseSnapshot"], fallbackError?: string | null) => {
    const rawContent = res?.content || (typeof res?.raw === "string" ? res.raw : undefined);
    const hasError = Boolean(res?.error || fallbackError);

    return (
      <div>
        <div
          style={{
            backgroundColor: "#f8fafc",
            border: "1px solid #e2e8f0",
            borderRadius: "6px",
            padding: "8px 12px",
            marginBottom: "12px",
            fontSize: "0.82rem",
            display: "flex",
            justifyContent: "space-between",
          }}
        >
          <span style={{ color: "#475569" }}>Trạng thái nhận được:</span>
          <span style={{ fontWeight: "600", color: hasError ? "#b91c1c" : "#15803d" }}>
            {res?.status ? `Mã HTTP ${res.status}` : hasError ? "Lỗi tiếp nhận" : "Đã hoàn tất (200)"}
          </span>
        </div>

        {rawContent ? (
          <div>
            <div style={{ fontWeight: "600", color: "#334155", fontSize: "0.8rem", marginBottom: "4px" }}>
              Nội dung gốc từ nhà cung cấp AI:
            </div>
            <div
              style={{
                backgroundColor: "#ffffff",
                border: "1px solid #cbd5e1",
                borderRadius: "6px",
                padding: "10px",
                fontSize: "0.82rem",
                color: "#0f172a",
                whiteSpace: "pre-wrap",
                maxHeight: "320px",
                overflowY: "auto",
                fontFamily: "ui-monospace, monospace",
              }}
            >
              {rawContent}
            </div>
          </div>
        ) : res?.raw && typeof res.raw === "object" ? (
          <div>
            <div style={{ fontWeight: "600", color: "#334155", fontSize: "0.8rem", marginBottom: "4px" }}>
              Nội dung trả về dạng cấu trúc:
            </div>
            <pre
              style={{
                backgroundColor: "#f8fafc",
                border: "1px solid #e2e8f0",
                borderRadius: "6px",
                padding: "10px",
                fontSize: "0.78rem",
                color: "#1e293b",
                maxHeight: "320px",
                overflowY: "auto",
              }}
            >
              {JSON.stringify(res.raw, null, 2)}
            </pre>
          </div>
        ) : (
          <div style={{ color: "#64748b", fontStyle: "italic", fontSize: "0.85rem" }}>
            {hasError ? "Không nhận được nội dung phản hồi hợp lệ từ nhà cung cấp AI." : "Không có dữ liệu phản hồi dạng văn bản."}
          </div>
        )}
      </div>
    );
  };

  const renderUsedResultContent = (run: AiRunItem) => {
    const messages = getCustomerOutputMessages(run);
    const needsClarification = getCustomerOutputClarification(run);

    if (messages.length === 0) {
      return (
        <div style={{ color: "#64748b", fontStyle: "italic", fontSize: "0.85rem", padding: "12px 0" }}>
          Hệ thống không sử dụng kết quả nào từ lượt gọi này (lượt gọi chưa thành công hoặc không tạo ra câu trả lời hợp lệ).
        </div>
      );
    }

    return (
      <div>
        <div style={{ marginBottom: "12px" }}>
          <div style={{ fontWeight: "600", color: "#166534", fontSize: "0.85rem", marginBottom: "8px" }}>
            Tin nhắn gửi đến khách hàng ({messages.length} câu phản hồi):
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {messages.map((msg, idx) => (
              <div
                key={idx}
                style={{
                  backgroundColor: "#f0fdf4",
                  border: "1px solid #bbf7d0",
                  borderRadius: "6px",
                  padding: "10px 12px",
                  color: "#166534",
                  fontSize: "0.85rem",
                  lineHeight: "1.4",
                }}
              >
                <div style={{ fontWeight: "600", fontSize: "0.75rem", marginBottom: "4px" }}>
                  Câu phản hồi #{idx + 1}:
                </div>
                <div>{msg}</div>
              </div>
            ))}
          </div>
        </div>

        <div
          style={{
            backgroundColor: needsClarification ? "#fef3c7" : "#f8fafc",
            border: `1px solid ${needsClarification ? "#fde68a" : "#e2e8f0"}`,
            borderRadius: "6px",
            padding: "8px 12px",
            fontSize: "0.82rem",
            color: needsClarification ? "#92400e" : "#475569",
            display: "flex",
            alignItems: "center",
            gap: "8px",
          }}
        >
          {needsClarification ? <AlertTriangle size={15} /> : <CheckCircle2 size={15} />}
          <span>
            <b>Cần khách hàng làm rõ thêm:</b> {needsClarification ? "Có (Chờ khách bổ sung thông tin)" : "Không (Đã đủ thông tin giải đáp)"}
          </span>
        </div>
      </div>
    );
  };

  return (
    <div>
      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          marginBottom: "16px",
        }}
      >
        <div>
          <h1
            style={{
              margin: "0 0 4px 0",
              fontSize: "1.5rem",
              fontWeight: "bold",
              display: "flex",
              alignItems: "center",
              gap: "8px",
              color: "#1e293b",
            }}
          >
            <Cpu size={24} color="#2563eb" /> Nhật ký hoạt động AI
          </h1>
          <div style={{ color: "#64748b", fontSize: "0.9rem" }}>
            Xem chi tiết các lượt xử lý AI: nội dung đã gửi, phản hồi nhận được và kết quả hệ thống sử dụng phản hồi khách hàng.
          </div>
        </div>

        <div style={{ display: "flex", gap: "8px" }}>
          <button
            onClick={() => setShowTester(!showTester)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "6px",
              backgroundColor: showTester ? "#3b82f6" : "#ffffff",
              color: showTester ? "#ffffff" : "#1e293b",
              border: "1px solid #cbd5e1",
              padding: "8px 14px",
              borderRadius: "6px",
              cursor: "pointer",
              fontWeight: "600",
              fontSize: "0.85rem",
            }}
          >
            <Sparkles size={16} color={showTester ? "#ffffff" : "#2563eb"} />
            {showTester ? "Đóng công cụ thử nghiệm" : "Thử nghiệm gửi tin"}
          </button>
          <button
            onClick={() => loadRuns(convFilter, statusFilter)}
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

      {/* Interactive Live Tester Section */}
      {showTester && (
        <div
          style={{
            backgroundColor: "#f8fafc",
            border: "1px solid #93c5fd",
            borderRadius: "8px",
            padding: "16px",
            marginBottom: "16px",
          }}
        >
          <div
            style={{
              fontWeight: "bold",
              marginBottom: "8px",
              fontSize: "0.95rem",
              display: "flex",
              alignItems: "center",
              gap: "6px",
              color: "#1e3a8a",
            }}
          >
            <Sparkles size={16} /> Thử nghiệm gửi tin nhắn lên dịch vụ AI
          </div>
          <div style={{ color: "#475569", fontSize: "0.85rem", marginBottom: "12px" }}>
            Mô phỏng tin nhắn của khách hàng để kiểm tra cấu hình dịch vụ AI và quan sát dữ liệu gửi/nhận.
          </div>

          <form onSubmit={handleRunLiveTest} style={{ display: "flex", gap: "8px", marginBottom: "12px" }}>
            <input
              type="text"
              value={testMessage}
              onChange={(e) => setTestMessage(e.target.value)}
              placeholder="Nhập nội dung khách hàng gửi đến..."
              style={{
                flex: 1,
                padding: "8px 12px",
                borderRadius: "6px",
                border: "1px solid #cbd5e1",
                fontSize: "0.9rem",
              }}
            />
            <button
              type="submit"
              disabled={testLoading || !testMessage.trim()}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "6px",
                backgroundColor: "#2563eb",
                color: "#ffffff",
                border: "none",
                padding: "8px 16px",
                borderRadius: "6px",
                fontWeight: "600",
                cursor: testLoading || !testMessage.trim() ? "not-allowed" : "pointer",
              }}
            >
              <Send size={16} />
              {testLoading ? "Đang gửi xử lý..." : "Gửi tin thử nghiệm"}
            </button>
          </form>

          {testResult && (
            <div
              style={{
                backgroundColor: "#ffffff",
                border: "1px solid #e2e8f0",
                borderRadius: "6px",
                padding: "14px",
                fontSize: "0.85rem",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "12px" }}>
                <div>
                  <span style={{ fontWeight: "bold" }}>Trạng thái: </span>
                  {testResult.success ? (
                    <span style={{ color: "#166534", fontWeight: "bold" }}>Thành công</span>
                  ) : (
                    <span style={{ color: "#991b1b", fontWeight: "bold" }}>Thất bại: {testResult.errorMessage}</span>
                  )}
                </div>
                <div style={{ color: "#475569" }}>
                  Mô hình: <b>{testResult.model}</b> | Thời gian: <b>{formatDurationVi(testResult.latencyMs)}</b> | Dung lượng:{" "}
                  <b>{formatUsageVi(testResult.totalTokens, testResult.promptTokens, testResult.completionTokens)}</b>
                </div>
              </div>

              {/* Three main sections for test result */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginBottom: "12px" }}>
                <div style={{ border: "1px solid #e2e8f0", borderRadius: "6px", padding: "10px" }}>
                  <div style={{ fontWeight: "600", color: "#1e293b", marginBottom: "8px", display: "flex", alignItems: "center", gap: "6px" }}>
                    <ArrowRight size={14} color="#2563eb" /> Nội dung đã gửi đến dịch vụ AI
                  </div>
                  {renderRequestSnapshotContent(testResult.requestSnapshot)}
                </div>

                <div style={{ border: "1px solid #e2e8f0", borderRadius: "6px", padding: "10px" }}>
                  <div style={{ fontWeight: "600", color: "#1e293b", marginBottom: "8px", display: "flex", alignItems: "center", gap: "6px" }}>
                    <MessageSquare size={14} color="#166534" /> Phản hồi nhận được
                  </div>
                  {renderResponseSnapshotContent(testResult.responseSnapshot, testResult.errorMessage)}
                </div>
              </div>

              {testResult.usedResult && (
                <div style={{ border: "1px solid #bbf7d0", borderRadius: "6px", padding: "10px", backgroundColor: "#f0fdf4", marginBottom: "12px" }}>
                  <div style={{ fontWeight: "600", color: "#166534", marginBottom: "8px", display: "flex", alignItems: "center", gap: "6px" }}>
                    <ShieldCheck size={14} color="#166534" /> Kết quả hệ thống đã sử dụng
                  </div>
                  {renderUsedResultContent({
                    id: "test",
                    channelAccountId: "test",
                    conversationId: "test",
                    inboundVersion: 1,
                    model: testResult.model || "",
                    promptTokens: testResult.promptTokens || 0,
                    completionTokens: testResult.completionTokens || 0,
                    totalTokens: testResult.totalTokens || 0,
                    latencyMs: testResult.latencyMs || 0,
                    status: testResult.success ? "SUCCESS" : "ERROR",
                    usedResult: testResult.usedResult,
                    parsedOutput: testResult.data ? { messages: testResult.data.messages, needsClarification: testResult.data.needsClarification } : null,
                    errorMessage: testResult.errorMessage || null,
                    createdAt: new Date().toISOString(),
                  })}
                </div>
              )}

              {/* Collapsed Technical Details for Test */}
              <details style={{ marginTop: "10px", border: "1px solid #e2e8f0", borderRadius: "6px", padding: "8px 12px", backgroundColor: "#f8fafc" }}>
                <summary style={{ cursor: "pointer", fontWeight: "600", fontSize: "0.8rem", color: "#475569" }}>
                  Chi tiết kỹ thuật
                </summary>
                <div style={{ marginTop: "8px", fontSize: "0.78rem" }}>
                  <div>Độ trễ: {testResult.latencyMs}ms | Token: {testResult.totalTokens} (Đầu vào: {testResult.promptTokens}, Phản hồi: {testResult.completionTokens})</div>
                  {testResult.promptHash && <div>Mã băm gửi: <code>{testResult.promptHash}</code></div>}
                  {testResult.responseHash && <div>Mã băm phản hồi: <code>{testResult.responseHash}</code></div>}
                  {testResult.requestSnapshot && (
                    <pre style={{ backgroundColor: "#ffffff", padding: "8px", borderRadius: "4px", marginTop: "4px", overflowX: "auto" }}>
                      {JSON.stringify(testResult.requestSnapshot, null, 2)}
                    </pre>
                  )}
                </div>
              </details>
            </div>
          )}
        </div>
      )}

      {/* Filter and Search Bar */}
      <div
        style={{
          display: "flex",
          gap: "12px",
          alignItems: "center",
          backgroundColor: "#ffffff",
          padding: "12px 16px",
          borderRadius: "8px",
          marginBottom: "16px",
          boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <span style={{ fontSize: "0.85rem", fontWeight: "600", color: "#475569" }}>Trạng thái:</span>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            style={{
              padding: "6px 10px",
              borderRadius: "6px",
              border: "1px solid #cbd5e1",
              fontSize: "0.85rem",
              color: "#1e293b",
            }}
          >
            <option value="ALL">Tất cả trạng thái</option>
            <option value="SUCCESS">Thành công</option>
            <option value="ERROR">Lỗi xử lý</option>
            <option value="GUARD_REJECTED">Từ chối an toàn</option>
            <option value="STALE_ABORTED">Đã hủy do tin nhắn mới</option>
          </select>
        </div>

        <form onSubmit={handleFilterSubmit} style={{ display: "flex", flex: 1, gap: "8px" }}>
          <input
            type="text"
            value={convFilter}
            onChange={(e) => setConvFilter(e.target.value)}
            placeholder="Lọc theo mã cuộc trò chuyện..."
            style={{
              flex: 1,
              padding: "6px 12px",
              borderRadius: "6px",
              border: "1px solid #cbd5e1",
              fontSize: "0.85rem",
            }}
          />
          <button
            type="submit"
            style={{
              display: "flex",
              alignItems: "center",
              gap: "4px",
              backgroundColor: "#2563eb",
              color: "#ffffff",
              border: "none",
              padding: "6px 14px",
              borderRadius: "6px",
              fontSize: "0.85rem",
              fontWeight: "600",
              cursor: "pointer",
            }}
          >
            <Search size={14} /> Lọc
          </button>
          {convFilter && (
            <button
              type="button"
              onClick={() => {
                setConvFilter("");
                setSearchParams({});
                loadRuns("", statusFilter);
              }}
              style={{
                backgroundColor: "#f1f5f9",
                color: "#475569",
                border: "1px solid #cbd5e1",
                padding: "6px 12px",
                borderRadius: "6px",
                fontSize: "0.85rem",
                cursor: "pointer",
              }}
            >
              Xóa lọc
            </button>
          )}
        </form>
      </div>

      {copyNotice && (
        <div
          style={{
            position: "fixed",
            bottom: "20px",
            right: "20px",
            backgroundColor: "#1e293b",
            color: "#ffffff",
            padding: "8px 16px",
            borderRadius: "6px",
            fontSize: "0.85rem",
            zIndex: 9999,
            boxShadow: "0 4px 6px rgba(0,0,0,0.1)",
          }}
        >
          ✓ Đã sao chép {copyNotice}
        </div>
      )}

      {/* Two Column Layout: Run List (Left) & Inspector (Right) */}
      <div style={{ display: "grid", gridTemplateColumns: "360px 1fr", gap: "16px", alignItems: "flex-start" }}>
        {/* Left: Runs List */}
        <div
          style={{
            backgroundColor: "#ffffff",
            borderRadius: "8px",
            boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
            overflow: "hidden",
            maxHeight: "calc(100vh - 240px)",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div
            style={{
              padding: "12px 16px",
              borderBottom: "1px solid #e2e8f0",
              fontWeight: "bold",
              fontSize: "0.9rem",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              backgroundColor: "#f8fafc",
            }}
          >
            <span>Danh sách lượt xử lý ({runs.length})</span>
            {loading && <span style={{ fontSize: "0.75rem", color: "#64748b" }}>Đang tải...</span>}
          </div>

          <div style={{ overflowY: "auto", flex: 1 }}>
            {runs.length === 0 ? (
              <div style={{ padding: "32px 16px", textAlign: "center", color: "#94a3b8", fontSize: "0.85rem" }}>
                Không tìm thấy lượt xử lý AI nào phù hợp bộ lọc.
              </div>
            ) : (
              runs.map((run) => {
                const isSelected = selectedRun?.id === run.id;
                return (
                  <div
                    key={run.id}
                    onClick={() => setSelectedRun(run)}
                    style={{
                      padding: "12px 16px",
                      borderBottom: "1px solid #f1f5f9",
                      cursor: "pointer",
                      backgroundColor: isSelected ? "#eff6ff" : "#ffffff",
                      borderLeft: isSelected ? "4px solid #2563eb" : "4px solid transparent",
                      transition: "background 0.15s",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
                      {getStatusBadge(run.status)}
                      <span style={{ fontSize: "0.75rem", color: "#64748b" }}>
                        {formatTime(run.createdAt, null, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                      </span>
                    </div>

                    <div style={{ fontSize: "0.82rem", fontWeight: "600", color: "#1e293b", marginBottom: "4px" }}>
                      Mô hình: {run.model}
                    </div>

                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.75rem", color: "#64748b", marginBottom: "4px" }}>
                      <span>Thời gian: {formatDurationVi(run.latencyMs)}</span>
                      <span>Dung lượng: {formatUsageVi(run.totalTokens)}</span>
                    </div>

                    {run.errorMessage && (
                      <div
                        style={{
                          fontSize: "0.75rem",
                          color: "#dc2626",
                          marginTop: "4px",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        ⚠️ {run.errorMessage}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Right: Detailed Request & Response Inspector */}
        <div
          style={{
            backgroundColor: "#ffffff",
            borderRadius: "8px",
            boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
            padding: "20px",
            minHeight: "450px",
          }}
        >
          {selectedRun ? (
            <div>
              {/* Top Meta Bar */}
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "flex-start",
                  paddingBottom: "16px",
                  borderBottom: "1px solid #e2e8f0",
                  marginBottom: "16px",
                }}
              >
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px" }}>
                    <span style={{ fontWeight: "bold", fontSize: "1.05rem", color: "#1e293b" }}>
                      Chi tiết hoạt động AI
                    </span>
                    {getStatusBadge(selectedRun.status)}
                  </div>
                  <div style={{ fontSize: "0.8rem", color: "#64748b" }}>
                    Thời gian: {formatDateTime(selectedRun.createdAt)}
                  </div>
                </div>

                <div style={{ textAlign: "right", fontSize: "0.82rem", color: "#475569" }}>
                  <div>Mô hình: <b>{selectedRun.model}</b></div>
                  <div>
                    Thời gian phản hồi: <b>{formatDurationVi(selectedRun.latencyMs)}</b>
                  </div>
                  <div>
                    Dung lượng xử lý: <b>{formatUsageVi(selectedRun.totalTokens, selectedRun.promptTokens, selectedRun.completionTokens)}</b>
                  </div>
                </div>
              </div>

              {/* Error Alert Box (if present) */}
              {selectedRun.errorMessage && (
                <div
                  style={{
                    backgroundColor: "#fee2e2",
                    border: "1px solid #f87171",
                    borderRadius: "6px",
                    padding: "12px 16px",
                    color: "#991b1b",
                    marginBottom: "16px",
                  }}
                >
                  <div style={{ fontWeight: "bold", display: "flex", alignItems: "center", gap: "6px" }}>
                    <XCircle size={16} /> Lỗi phát sinh trong quá trình xử lý:
                  </div>
                  <div style={{ marginTop: "4px", fontSize: "0.85rem", wordBreak: "break-word" }}>
                    {selectedRun.errorMessage}
                  </div>
                </div>
              )}

              {/* Three Main Understandable Sections */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px", marginBottom: "16px" }}>
                {/* Section 1: What was sent to AI */}
                <div
                  style={{
                    border: "1px solid #e2e8f0",
                    borderRadius: "8px",
                    overflow: "hidden",
                    display: "flex",
                    flexDirection: "column",
                  }}
                >
                  <div
                    style={{
                      padding: "10px 14px",
                      backgroundColor: "#f8fafc",
                      borderBottom: "1px solid #e2e8f0",
                      display: "flex",
                      alignItems: "center",
                      gap: "6px",
                      fontWeight: "600",
                      fontSize: "0.88rem",
                      color: "#1e293b",
                    }}
                  >
                    <ArrowRight size={15} color="#2563eb" /> Nội dung đã gửi đến dịch vụ AI
                  </div>
                  <div style={{ padding: "14px", flex: 1, overflowY: "auto", maxHeight: "480px" }}>
                    {renderRequestSnapshotContent(selectedRun.requestSnapshot)}
                  </div>
                </div>

                {/* Section 2: What provider returned */}
                <div
                  style={{
                    border: "1px solid #e2e8f0",
                    borderRadius: "8px",
                    overflow: "hidden",
                    display: "flex",
                    flexDirection: "column",
                  }}
                >
                  <div
                    style={{
                      padding: "10px 14px",
                      backgroundColor: "#f8fafc",
                      borderBottom: "1px solid #e2e8f0",
                      display: "flex",
                      alignItems: "center",
                      gap: "6px",
                      fontWeight: "600",
                      fontSize: "0.88rem",
                      color: "#1e293b",
                    }}
                  >
                    <MessageSquare size={15} color="#166534" /> Phản hồi nhận được
                  </div>
                  <div style={{ padding: "14px", flex: 1, overflowY: "auto", maxHeight: "480px" }}>
                    {renderResponseSnapshotContent(selectedRun.responseSnapshot, selectedRun.errorMessage)}
                  </div>
                </div>
              </div>

              {/* Section 3: What result application used (Customer Output) */}
              <div
                style={{
                  border: "1px solid #bbf7d0",
                  borderRadius: "8px",
                  overflow: "hidden",
                  marginBottom: "16px",
                }}
              >
                <div
                  style={{
                    padding: "10px 14px",
                    backgroundColor: "#f0fdf4",
                    borderBottom: "1px solid #bbf7d0",
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                    fontWeight: "600",
                    fontSize: "0.88rem",
                    color: "#166534",
                  }}
                >
                  <ShieldCheck size={16} color="#166534" /> Kết quả hệ thống đã sử dụng
                </div>
                <div style={{ padding: "14px", backgroundColor: "#ffffff" }}>
                  {renderUsedResultContent(selectedRun)}
                </div>
              </div>

              {/* Collapsed Technical Details Section */}
              <details
                style={{
                  border: "1px solid #e2e8f0",
                  borderRadius: "8px",
                  padding: "12px 16px",
                  backgroundColor: "#f8fafc",
                }}
              >
                <summary
                  style={{
                    cursor: "pointer",
                    fontWeight: "600",
                    fontSize: "0.85rem",
                    color: "#475569",
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                  }}
                >
                  <Terminal size={14} /> Chi tiết kỹ thuật
                </summary>

                <div style={{ marginTop: "14px", fontSize: "0.8rem", color: "#334155" }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginBottom: "12px" }}>
                    <div>
                      <div style={{ fontWeight: "600", color: "#64748b", marginBottom: "2px" }}>Mã định danh (Run ID):</div>
                      <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                        <code style={{ backgroundColor: "#ffffff", padding: "3px 6px", borderRadius: "4px", border: "1px solid #e2e8f0", fontSize: "0.75rem" }}>
                          {selectedRun.id}
                        </code>
                        <button
                          onClick={() => copyToClipboard(selectedRun.id, "Mã ID")}
                          style={{ border: "none", background: "none", color: "#2563eb", cursor: "pointer" }}
                        >
                          <Copy size={12} />
                        </button>
                      </div>
                    </div>

                    <div>
                      <div style={{ fontWeight: "600", color: "#64748b", marginBottom: "2px" }}>Mã hội thoại (Conversation ID):</div>
                      <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                        <code style={{ backgroundColor: "#ffffff", padding: "3px 6px", borderRadius: "4px", border: "1px solid #e2e8f0", fontSize: "0.75rem" }}>
                          {selectedRun.conversationId}
                        </code>
                        <button
                          onClick={() => copyToClipboard(selectedRun.conversationId, "Mã hội thoại")}
                          style={{ border: "none", background: "none", color: "#2563eb", cursor: "pointer" }}
                        >
                          <Copy size={12} />
                        </button>
                      </div>
                    </div>
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginBottom: "12px" }}>
                    <div>
                      <div style={{ fontWeight: "600", color: "#64748b", marginBottom: "2px" }}>Mã băm gửi đi (Prompt SHA-256):</div>
                      <code style={{ backgroundColor: "#ffffff", padding: "3px 6px", borderRadius: "4px", border: "1px solid #e2e8f0", fontSize: "0.75rem", wordBreak: "break-all" }}>
                        {selectedRun.promptHash || "(Chưa có hash)"}
                      </code>
                    </div>

                    <div>
                      <div style={{ fontWeight: "600", color: "#64748b", marginBottom: "2px" }}>Mã băm phản hồi (Response SHA-256):</div>
                      <code style={{ backgroundColor: "#ffffff", padding: "3px 6px", borderRadius: "4px", border: "1px solid #e2e8f0", fontSize: "0.75rem", wordBreak: "break-all" }}>
                        {selectedRun.responseHash || "(Chưa có hash)"}
                      </code>
                    </div>
                  </div>

                  <div style={{ marginBottom: "12px" }}>
                    <div style={{ fontWeight: "600", color: "#64748b", marginBottom: "4px" }}>
                      Bản chụp yêu cầu đã làm sạch bảo mật (Sanitized Request Snapshot):
                    </div>
                    <pre
                      style={{
                        backgroundColor: "#ffffff",
                        border: "1px solid #e2e8f0",
                        borderRadius: "6px",
                        padding: "10px",
                        fontSize: "0.75rem",
                        maxHeight: "200px",
                        overflowY: "auto",
                      }}
                    >
                      {JSON.stringify(selectedRun.requestSnapshot || {}, null, 2)}
                    </pre>
                  </div>

                  <div>
                    <div style={{ fontWeight: "600", color: "#64748b", marginBottom: "4px" }}>
                      Bản chụp phản hồi nhà cung cấp (Response Snapshot):
                    </div>
                    <pre
                      style={{
                        backgroundColor: "#ffffff",
                        border: "1px solid #e2e8f0",
                        borderRadius: "6px",
                        padding: "10px",
                        fontSize: "0.75rem",
                        maxHeight: "200px",
                        overflowY: "auto",
                      }}
                    >
                      {JSON.stringify(selectedRun.responseSnapshot || {}, null, 2)}
                    </pre>
                  </div>
                </div>
              </details>
            </div>
          ) : (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                height: "350px",
                color: "#94a3b8",
              }}
            >
              <Cpu size={48} strokeWidth={1} style={{ marginBottom: "12px" }} />
              <div>Chọn một lượt xử lý AI từ danh sách bên trái để xem chi tiết.</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
