import React, { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { apiFetch } from "../api";
import type { AiRunItem } from "../types";
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
} from "lucide-react";

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
  const [testResult, setTestResult] = useState<any>(null);
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
      const res = await apiFetch<any>("/api/ai-runs/test", {
        method: "POST",
        body: JSON.stringify({ message: testMessage.trim() }),
      });
      setTestResult(res);
      // Reload logs to show new entry if created
      loadRuns(convFilter, statusFilter);
    } catch (err: unknown) {
      setTestResult({
        success: false,
        errorMessage: (err as Error).message || "Unknown error during test",
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
    switch (status) {
      case "SUCCESS":
        return (
          <span
            style={{
              backgroundColor: "#dcfce7",
              color: "#166534",
              padding: "2px 8px",
              borderRadius: "4px",
              fontSize: "0.75rem",
              fontWeight: "bold",
              display: "inline-flex",
              alignItems: "center",
              gap: "4px",
            }}
          >
            <CheckCircle2 size={12} /> SUCCESS
          </span>
        );
      case "GUARD_REJECTED":
        return (
          <span
            style={{
              backgroundColor: "#fef3c7",
              color: "#92400e",
              padding: "2px 8px",
              borderRadius: "4px",
              fontSize: "0.75rem",
              fontWeight: "bold",
              display: "inline-flex",
              alignItems: "center",
              gap: "4px",
            }}
          >
            <AlertTriangle size={12} /> GUARD REJECTED
          </span>
        );
      case "ERROR":
        return (
          <span
            style={{
              backgroundColor: "#fee2e2",
              color: "#991b1b",
              padding: "2px 8px",
              borderRadius: "4px",
              fontSize: "0.75rem",
              fontWeight: "bold",
              display: "inline-flex",
              alignItems: "center",
              gap: "4px",
            }}
          >
            <XCircle size={12} /> ERROR
          </span>
        );
      default:
        return (
          <span
            style={{
              backgroundColor: "#f1f5f9",
              color: "#475569",
              padding: "2px 8px",
              borderRadius: "4px",
              fontSize: "0.75rem",
              fontWeight: "bold",
            }}
          >
            {status}
          </span>
        );
    }
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
            }}
          >
            <Cpu size={26} color="#2563eb" />
            Nhật ký AI & Proxy Gateway (AI Proxy Logs)
          </h1>
          <div style={{ color: "#64748b", fontSize: "0.9rem" }}>
            Xem chi tiết toàn bộ lượt gọi AI, độ trễ, token, prompt/response hash và kết quả parsed output để kiểm tra & gỡ lỗi (debug).
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
            {showTester ? "Đóng Test Tool" : "Test gửi chat lên Proxy"}
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
          <div style={{ fontWeight: "bold", fontSize: "1rem", color: "#1e3a8a", marginBottom: "8px" }}>
            ⚡ Thử nghiệm gửi Chat trực tiếp lên AI Gateway & Xem phản hồi Realtime
          </div>
          <form onSubmit={handleRunLiveTest} style={{ display: "flex", gap: "8px", marginBottom: "12px" }}>
            <input
              type="text"
              value={testMessage}
              onChange={(e) => setTestMessage(e.target.value)}
              placeholder="Nhập tin nhắn khách hàng giả lập..."
              disabled={testLoading}
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
              {testLoading ? "Đang gửi lên proxy..." : "Gửi Test"}
            </button>
          </form>

          {testResult && (
            <div
              style={{
                backgroundColor: "#ffffff",
                border: "1px solid #e2e8f0",
                borderRadius: "6px",
                padding: "12px",
                fontSize: "0.85rem",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px" }}>
                <div>
                  <span style={{ fontWeight: "bold" }}>Trạng thái: </span>
                  {testResult.success ? (
                    <span style={{ color: "#166534", fontWeight: "bold" }}>THÀNH CÔNG (200 OK)</span>
                  ) : (
                    <span style={{ color: "#991b1b", fontWeight: "bold" }}>THẤT BẠI: {testResult.errorMessage}</span>
                  )}
                </div>
                <div style={{ color: "#64748b" }}>
                  Model: <b>{testResult.model}</b> | Latency: <b>{testResult.latencyMs}ms</b> | Tokens:{" "}
                  <b>{testResult.totalTokens}</b>
                </div>
              </div>

              <div style={{ display: "flex", gap: "12px", marginBottom: "8px", fontSize: "0.8rem", color: "#475569" }}>
                {testResult.promptHash && (
                  <div>Prompt Hash: <code style={{ backgroundColor: "#f1f5f9", padding: "2px 6px", borderRadius: "4px" }}>{testResult.promptHash.slice(0, 16)}...</code></div>
                )}
                {testResult.responseHash && (
                  <div>Response Hash: <code style={{ backgroundColor: "#f1f5f9", padding: "2px 6px", borderRadius: "4px" }}>{testResult.responseHash.slice(0, 16)}...</code></div>
                )}
              </div>

              {testResult.data?.messages && testResult.data.messages.length > 0 && (
                <div style={{ marginBottom: "8px" }}>
                  <div style={{ fontWeight: "600", color: "#334155", marginBottom: "4px" }}>Câu trả lời được sinh:</div>
                  {testResult.data.messages.map((m: string, idx: number) => (
                    <div
                      key={idx}
                      style={{
                        backgroundColor: "#f0fdf4",
                        border: "1px solid #bbf7d0",
                        borderRadius: "4px",
                        padding: "6px 10px",
                        marginBottom: "4px",
                        color: "#166534",
                        fontSize: "0.85rem",
                      }}
                    >
                      <b>Câu #{idx + 1}:</b> {m}
                    </div>
                  ))}
                </div>
              )}

              {testResult.errorMessage && (
                <div style={{ marginTop: "8px", padding: "8px", backgroundColor: "#fef2f2", borderRadius: "4px", color: "#991b1b", fontSize: "0.8rem" }}>
                  <b>Lỗi:</b> {testResult.errorMessage}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Filter Bar */}
      <div
        style={{
          display: "flex",
          gap: "12px",
          alignItems: "center",
          backgroundColor: "#ffffff",
          padding: "12px 16px",
          borderRadius: "8px",
          boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
          marginBottom: "16px",
          flexWrap: "wrap",
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
            }}
          >
            <option value="ALL">Tất cả trạng thái</option>
            <option value="SUCCESS">Chỉ SUCCESS</option>
            <option value="ERROR">Chỉ ERROR (Lỗi AI/Proxy)</option>
            <option value="GUARD_REJECTED">Chỉ GUARD_REJECTED</option>
          </select>
        </div>

        <form onSubmit={handleFilterSubmit} style={{ display: "flex", gap: "6px", flex: 1, minWidth: "240px" }}>
          <input
            type="text"
            value={convFilter}
            onChange={(e) => setConvFilter(e.target.value)}
            placeholder="Lọc theo Conversation ID..."
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
            <span>Danh sách lượt gọi AI ({runs.length})</span>
            {loading && <span style={{ fontSize: "0.75rem", color: "#64748b" }}>Đang tải...</span>}
          </div>

          <div style={{ overflowY: "auto", flex: 1 }}>
            {runs.length === 0 ? (
              <div style={{ padding: "32px 16px", textAlign: "center", color: "#94a3b8", fontSize: "0.85rem" }}>
                Không tìm thấy lượt gọi AI nào phù hợp bộ lọc.
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
                      transition: "background-color 0.15s",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
                      {getStatusBadge(run.status)}
                      <span style={{ fontSize: "0.75rem", color: "#64748b", display: "flex", alignItems: "center", gap: "4px" }}>
                        <Clock size={12} />
                        {new Date(run.createdAt).toLocaleTimeString("vi-VN")}
                      </span>
                    </div>

                    <div style={{ fontSize: "0.8rem", fontWeight: "600", color: "#1e293b", marginBottom: "4px" }}>
                      {run.model}
                    </div>

                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.75rem", color: "#64748b" }}>
                      <span>Độ trễ: {run.latencyMs}ms</span>
                      <span>Tokens: {run.totalTokens || 0}</span>
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
                  alignItems: "center",
                  paddingBottom: "16px",
                  borderBottom: "1px solid #e2e8f0",
                  marginBottom: "16px",
                }}
              >
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <span style={{ fontWeight: "bold", fontSize: "1.1rem" }}>Chi tiết lượt gọi AI</span>
                    {getStatusBadge(selectedRun.status)}
                  </div>
                  <div style={{ fontSize: "0.8rem", color: "#64748b", marginTop: "4px" }}>
                    ID: <code style={{ backgroundColor: "#f1f5f9", padding: "1px 4px", borderRadius: "3px" }}>{selectedRun.id}</code> |
                    Thời gian: {new Date(selectedRun.createdAt).toLocaleString("vi-VN")} |
                    Hội thoại: <code style={{ backgroundColor: "#f1f5f9", padding: "1px 4px", borderRadius: "3px" }}>{selectedRun.conversationId}</code> (v{selectedRun.inboundVersion})
                  </div>
                </div>

                <div style={{ textAlign: "right", fontSize: "0.8rem", color: "#475569" }}>
                  <div>Model: <b>{selectedRun.model}</b></div>
                  <div>Độ trễ: <b>{selectedRun.latencyMs}ms</b> | Token: <b>{selectedRun.totalTokens}</b> (P:{selectedRun.promptTokens} / C:{selectedRun.completionTokens})</div>
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
                    <XCircle size={16} /> Lỗi xảy ra trong quá trình gọi AI / Proxy:
                  </div>
                  <div style={{ marginTop: "4px", fontSize: "0.9rem", fontFamily: "monospace", wordBreak: "break-word" }}>
                    {selectedRun.errorMessage}
                  </div>
                </div>
              )}

              {/* Inspector Content: Two Halves (Request vs Response) */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
                {/* Column 1: Run Metadata & Hashes */}
                <div
                  style={{
                    border: "1px solid #e2e8f0",
                    borderRadius: "6px",
                    overflow: "hidden",
                    display: "flex",
                    flexDirection: "column",
                  }}
                >
                  <div
                    style={{
                      padding: "8px 12px",
                      backgroundColor: "#f8fafc",
                      borderBottom: "1px solid #e2e8f0",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <span style={{ fontWeight: "600", fontSize: "0.85rem", color: "#1e293b" }}>
                      🔒 Metadata & Hashes (Bảo mật - Không lưu raw prompt)
                    </span>
                  </div>

                  <div style={{ padding: "12px", overflowY: "auto", maxHeight: "500px", fontSize: "0.85rem" }}>
                    <div style={{ marginBottom: "12px" }}>
                      <div style={{ fontWeight: "600", color: "#475569", marginBottom: "4px", fontSize: "0.8rem" }}>
                        Prompt SHA-256 Hash:
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                        <code style={{ backgroundColor: "#f1f5f9", padding: "4px 8px", borderRadius: "4px", fontSize: "0.75rem", wordBreak: "break-all" }}>
                          {selectedRun.promptHash || "(Chưa có hash)"}
                        </code>
                        {selectedRun.promptHash && (
                          <button
                            onClick={() => copyToClipboard(selectedRun.promptHash || "", "Prompt Hash")}
                            style={{ border: "none", background: "none", color: "#2563eb", cursor: "pointer" }}
                          >
                            <Copy size={12} />
                          </button>
                        )}
                      </div>
                    </div>

                    <div style={{ marginBottom: "12px" }}>
                      <div style={{ fontWeight: "600", color: "#475569", marginBottom: "4px", fontSize: "0.8rem" }}>
                        Response SHA-256 Hash:
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                        <code style={{ backgroundColor: "#f1f5f9", padding: "4px 8px", borderRadius: "4px", fontSize: "0.75rem", wordBreak: "break-all" }}>
                          {selectedRun.responseHash || "(Chưa có hash)"}
                        </code>
                        {selectedRun.responseHash && (
                          <button
                            onClick={() => copyToClipboard(selectedRun.responseHash || "", "Response Hash")}
                            style={{ border: "none", background: "none", color: "#2563eb", cursor: "pointer" }}
                          >
                            <Copy size={12} />
                          </button>
                        )}
                      </div>
                    </div>

                    <div style={{ marginBottom: "12px" }}>
                      <div style={{ fontWeight: "600", color: "#475569", marginBottom: "4px", fontSize: "0.8rem" }}>
                        Token Usage Breakdown:
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "8px", textAlign: "center" }}>
                        <div style={{ backgroundColor: "#f8fafc", padding: "8px", borderRadius: "4px" }}>
                          <div style={{ fontSize: "0.7rem", color: "#64748b" }}>Prompt</div>
                          <div style={{ fontWeight: "bold" }}>{selectedRun.promptTokens}</div>
                        </div>
                        <div style={{ backgroundColor: "#f8fafc", padding: "8px", borderRadius: "4px" }}>
                          <div style={{ fontSize: "0.7rem", color: "#64748b" }}>Completion</div>
                          <div style={{ fontWeight: "bold" }}>{selectedRun.completionTokens}</div>
                        </div>
                        <div style={{ backgroundColor: "#f8fafc", padding: "8px", borderRadius: "4px" }}>
                          <div style={{ fontSize: "0.7rem", color: "#64748b" }}>Total</div>
                          <div style={{ fontWeight: "bold" }}>{selectedRun.totalTokens}</div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Column 2: Response from AI / Proxy */}
                <div
                  style={{
                    border: "1px solid #e2e8f0",
                    borderRadius: "6px",
                    overflow: "hidden",
                    display: "flex",
                    flexDirection: "column",
                  }}
                >
                  <div
                    style={{
                      padding: "8px 12px",
                      backgroundColor: "#f8fafc",
                      borderBottom: "1px solid #e2e8f0",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <span style={{ fontWeight: "600", fontSize: "0.85rem", color: "#1e293b" }}>
                      📥 Chat từ AI trả về (Parsed Output)
                    </span>
                  </div>

                  <div style={{ padding: "12px", overflowY: "auto", maxHeight: "500px", fontSize: "0.85rem" }}>
                    {/* Parsed Output Messages preview if available */}
                    {selectedRun.parsedOutput?.messages && (
                      <div style={{ marginBottom: "16px" }}>
                        <div style={{ fontWeight: "bold", color: "#166534", marginBottom: "6px" }}>
                          ✓ Nội dung soạn thảo đề xuất ({selectedRun.parsedOutput.messages.length} câu):
                        </div>
                        {selectedRun.parsedOutput.messages.map((m, idx) => (
                          <div
                            key={idx}
                            style={{
                              backgroundColor: "#f0fdf4",
                              border: "1px solid #bbf7d0",
                              borderRadius: "4px",
                              padding: "8px 10px",
                              marginBottom: "6px",
                              color: "#166534",
                            }}
                          >
                            <b>Câu #{idx + 1}:</b> {m}
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Needs clarification indicator */}
                    {(selectedRun.parsedOutput?.needsClarification ||
                      (selectedRun.parsedOutput?.data as any)?.needsClarification) && (
                      <div
                        style={{
                          backgroundColor: "#fef3c7",
                          border: "1px solid #fde68a",
                          borderRadius: "4px",
                          padding: "8px 10px",
                          marginBottom: "12px",
                          color: "#92400e",
                          fontSize: "0.8rem",
                        }}
                      >
                        ⚠️ AI yêu cầu làm rõ thêm thông tin từ khách hàng (needsClarification: true)
                      </div>
                    )}

                    {/* Error display if status is ERROR */}
                    {selectedRun.status === "ERROR" && selectedRun.errorMessage && (
                      <div
                        style={{
                          backgroundColor: "#fef2f2",
                          border: "1px solid #fecaca",
                          borderRadius: "4px",
                          padding: "10px",
                          color: "#991b1b",
                          fontSize: "0.8rem",
                          lineHeight: "1.4",
                        }}
                      >
                        <div style={{ fontWeight: "bold", marginBottom: "4px" }}>Lỗi xử lý AI:</div>
                        <div style={{ wordBreak: "break-word" }}>{selectedRun.errorMessage}</div>
                      </div>
                    )}

                    {selectedRun.status !== "ERROR" &&
                      !selectedRun.parsedOutput?.messages &&
                      !(selectedRun.parsedOutput?.data as any)?.messages && (
                        <div style={{ color: "#64748b", fontSize: "0.8rem", fontStyle: "italic" }}>
                          (Không có nội dung tin nhắn được trích xuất)
                        </div>
                      )}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div style={{ padding: "40px", textAlign: "center", color: "#94a3b8" }}>
              Chọn một lượt gọi AI ở danh sách bên trái để xem chi tiết kết quả.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
