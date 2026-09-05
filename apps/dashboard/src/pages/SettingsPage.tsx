import React, { useEffect, useState } from "react";
import { apiFetch } from "../api";
import type { AiProviderSettings, SettingItem, NonSecretSettings } from "../types";
import { sanitizeSettingsForSave } from "../helpers/settings-helpers";
import { useSseWakeup } from "../context/SseContext";
import {
  Save,
  History,
  CheckCircle2,
  AlertCircle,
  Activity,
  Loader2,
  Cpu,
  Clock,
  Shield,
  RefreshCw,
} from "lucide-react";

export const SettingsPage: React.FC = () => {
  const [data, setData] = useState<SettingItem | null>(null);
  const [formData, setFormData] = useState<Partial<NonSecretSettings>>({});
  const [aiProvider, setAiProvider] = useState<AiProviderSettings>({
    apiFormat: "OPENAI_COMPATIBLE",
    baseUrl: "https://api.openai.com/v1",
    model: "",
    apiKeyConfigured: false,
  });
  const [aiApiKey, setAiApiKey] = useState("");
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testingAi, setTestingAi] = useState(false);
  const [aiTestResult, setAiTestResult] = useState<{
    healthy?: boolean;
    status?: string;
    model?: string;
    latencyMs?: number;
    message?: string;
    error?: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);

  const loadSettings = async () => {
    setError(null);
    try {
      const res = await apiFetch<SettingItem>("/api/settings");
      setData(res);
      setFormData(sanitizeSettingsForSave(res.settings));
      setAiProvider(res.aiProvider);
    } catch (err: unknown) {
      setError((err as Error).message || "Không thể tải cấu hình hệ thống");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSettings();
  }, []);

  // SSE wakeup on settings update
  useSseWakeup(
    (type) => type === "settings:updated",
    () => loadSettings()
  );

  const handleTestAi = async () => {
    setTestingAi(true);
    setAiTestResult(null);
    try {
      const res = await apiFetch<{
        healthy?: boolean;
        status?: string;
        model?: string;
        latencyMs?: number;
        message?: string;
        error?: string;
      }>("/api/settings/test-ai", {
        method: "POST",
        body: JSON.stringify({
          apiFormat: aiProvider.apiFormat,
          baseUrl: aiProvider.baseUrl,
          model: aiProvider.model,
          apiKey: aiApiKey || undefined,
        }),
      });
      setAiTestResult(res);
    } catch (err: unknown) {
      setAiTestResult({
        healthy: false,
        status: "error",
        error: (err as Error).message,
      });
    } finally {
      setTestingAi(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSaveSuccess(null);

    const sanitized = sanitizeSettingsForSave(formData);

    try {
      await apiFetch<{ aiProvider: AiProviderSettings }>("/api/settings/ai-provider", {
        method: "PUT",
        body: JSON.stringify({
          apiFormat: aiProvider.apiFormat,
          baseUrl: aiProvider.baseUrl,
          model: aiProvider.model,
          apiKey: aiApiKey || undefined,
        }),
      });
      const updated = await apiFetch<SettingItem>("/api/settings", {
        method: "POST",
        body: JSON.stringify({
          ...sanitized,
          aiModel: aiProvider.model,
          reason: reason.trim() || "Cập nhật từ trang cài đặt",
        }),
      });
      setData(updated);
      setAiProvider(updated.aiProvider);
      setAiApiKey("");
      setFormData(sanitizeSettingsForSave(updated.settings));
      setReason("");
      setSaveSuccess(`Đã lưu cấu hình mới thành công (Revision #${updated.revision})`);
      setTimeout(() => setSaveSuccess(null), 4000);
    } catch (err: unknown) {
      setError((err as Error).message || "Không thể lưu cấu hình");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "300px", gap: "10px", color: "#64748b" }}>
        <Loader2 size={24} className="animate-spin" />
        <span>Đang tải cấu hình hệ thống...</span>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div style={{ backgroundColor: "#fef2f2", border: "1px solid #fecaca", borderRadius: "8px", padding: "20px", color: "#991b1b" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", fontWeight: "bold", marginBottom: "8px" }}>
          <AlertCircle size={20} /> Lỗi tải cấu hình
        </div>
        <div>{error}</div>
        <button
          onClick={loadSettings}
          style={{ marginTop: "12px", display: "flex", alignItems: "center", gap: "6px", padding: "6px 12px", borderRadius: "6px", backgroundColor: "#dc2626", color: "#fff", border: "none", cursor: "pointer" }}
        >
          <RefreshCw size={14} /> Thử lại
        </button>
      </div>
    );
  }

  const labelStyle: React.CSSProperties = {
    display: "block",
    fontSize: "0.82rem",
    fontWeight: "600",
    color: "#334155",
    marginBottom: "4px",
  };

  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "8px 12px",
    borderRadius: "6px",
    border: "1px solid #cbd5e1",
    fontSize: "0.9rem",
    boxSizing: "border-box",
  };

  return (
    <div style={{ maxWidth: "860px", width: "100%", margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px", marginBottom: "20px" }}>
        <div>
          <h1 style={{ margin: "0 0 4px 0", fontSize: "1.5rem", fontWeight: "bold" }}>Cài đặt hệ thống</h1>
          <div style={{ fontSize: "0.85rem", color: "#64748b" }}>
            Cấu hình dịch vụ AI, thời gian phản hồi và quy tắc điều phối hội thoại
          </div>
        </div>
        <div style={{ fontSize: "0.85rem", color: "#64748b", display: "flex", alignItems: "center", gap: "6px", backgroundColor: "#f1f5f9", padding: "6px 12px", borderRadius: "6px" }}>
          <History size={16} /> Phiên bản hiện tại: <span style={{ fontWeight: "bold", color: "#2563eb" }}>#{data?.revision || 1}</span>
        </div>
      </div>

      {saveSuccess && (
        <div style={{ display: "flex", alignItems: "center", gap: "8px", padding: "12px 16px", borderRadius: "6px", backgroundColor: "#f0fdf4", border: "1px solid #86efac", color: "#166534", marginBottom: "16px", fontSize: "0.9rem" }}>
          <CheckCircle2 size={18} />
          <span>{saveSuccess}</span>
        </div>
      )}

      {error && (
        <div style={{ display: "flex", alignItems: "center", gap: "8px", padding: "12px 16px", borderRadius: "6px", backgroundColor: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", marginBottom: "16px", fontSize: "0.9rem" }}>
          <AlertCircle size={18} />
          <span>{error}</span>
        </div>
      )}

      <form onSubmit={handleSubmit} style={{ backgroundColor: "#ffffff", padding: "24px", borderRadius: "10px", boxShadow: "0 1px 3px rgba(0,0,0,0.06)", display: "flex", flexDirection: "column", gap: "24px" }}>

        {/* 1. AI Model & Non-Secret Health Check */}
        <div style={{ borderBottom: "1px solid #e2e8f0", paddingBottom: "20px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "10px", marginBottom: "14px" }}>
            <div>
              <h2 style={{ fontSize: "1.05rem", fontWeight: "700", margin: "0 0 2px 0", color: "#1e293b", display: "flex", alignItems: "center", gap: "6px" }}>
                <Cpu size={18} color="#2563eb" /> Dịch vụ AI & Kiểm tra kết nối
              </h2>
              <span style={{ fontSize: "0.8rem", color: "#64748b" }}>
                Thông tin kết nối được bảo mật an toàn trên máy chủ.
              </span>
            </div>
            <button
              type="button"
              onClick={handleTestAi}
              disabled={testingAi}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "6px",
                padding: "8px 14px",
                borderRadius: "6px",
                border: "1px solid #cbd5e1",
                backgroundColor: "#f8fafc",
                color: "#1e293b",
                fontSize: "0.85rem",
                fontWeight: "600",
                cursor: testingAi ? "not-allowed" : "pointer",
              }}
            >
              {testingAi ? <Loader2 size={16} className="animate-spin" /> : <Activity size={16} color="#2563eb" />}
              {testingAi ? "Đang kiểm tra..." : "Kiểm tra kết nối AI"}
            </button>
          </div>

          {/* AI Health result banner */}
          {aiTestResult && (
            <div
              style={{
                marginBottom: "16px",
                padding: "12px 16px",
                borderRadius: "6px",
                border: `1px solid ${aiTestResult.healthy !== false && aiTestResult.status !== "error" ? "#86efac" : "#fca5a5"}`,
                backgroundColor: aiTestResult.healthy !== false && aiTestResult.status !== "error" ? "#f0fdf4" : "#fef2f2",
                color: aiTestResult.healthy !== false && aiTestResult.status !== "error" ? "#166534" : "#991b1b",
                fontSize: "0.85rem",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                flexWrap: "wrap",
                gap: "8px",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                {aiTestResult.healthy !== false && aiTestResult.status !== "error" ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
                <span>
                  Trạng thái: <strong>{aiTestResult.healthy !== false && aiTestResult.status !== "error" ? "Sẵn sàng (Healthy)" : "Lỗi kết nối"}</strong>
                  {aiTestResult.model && ` • Mô hình: ${aiTestResult.model}`}
                  {aiTestResult.error && ` (${aiTestResult.error})`}
                </span>
              </div>
              {aiTestResult.latencyMs !== undefined && (
                <span style={{ fontSize: "0.8rem", color: "#475569" }}>
                  Độ trễ: {aiTestResult.latencyMs}ms
                </span>
              )}
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "16px" }}>
            <div>
              <label style={labelStyle}>Loại dịch vụ AI</label>
              <select
                value={aiProvider.apiFormat}
                onChange={(e) => setAiProvider({ ...aiProvider, apiFormat: e.target.value as AiProviderSettings["apiFormat"] })}
                style={inputStyle}
              >
                <option value="OPENAI_COMPATIBLE">OpenAI-compatible</option>
                <option value="ANTHROPIC_COMPATIBLE">Anthropic-compatible (Claude API)</option>
              </select>
            </div>
            <div>
              <label style={labelStyle}>Tên mô hình</label>
              <input
                type="text"
                value={aiProvider.model}
                onChange={(e) => setAiProvider({ ...aiProvider, model: e.target.value })}
                placeholder="auto/best-chat, gpt-4.1, claude-sonnet-4-6..."
                style={inputStyle}
              />
            </div>
          </div>

          <div style={{ marginTop: "16px" }}>
            <label style={labelStyle}>Địa chỉ dịch vụ</label>
            <input
              type="url"
              value={aiProvider.baseUrl}
              onChange={(e) => setAiProvider({ ...aiProvider, baseUrl: e.target.value })}
              placeholder={aiProvider.apiFormat === "OPENAI_COMPATIBLE" ? "https://gateway.example.com/v1" : "https://api.anthropic.com/v1"}
              style={inputStyle}
            />
            <span style={{ fontSize: "0.75rem", color: "#64748b" }}>
              Địa chỉ kết nối đến nhà cung cấp dịch vụ AI.
            </span>
          </div>

          <div style={{ marginTop: "16px" }}>
            <label style={labelStyle}>Mật khẩu kết nối</label>
            <input
              type="password"
              value={aiApiKey}
              onChange={(e) => setAiApiKey(e.target.value)}
              placeholder={aiProvider.apiKeyConfigured ? "Đã cấu hình — để trống để giữ nguyên" : "Nhập mật khẩu kết nối"}
              autoComplete="new-password"
              style={inputStyle}
            />
            <span style={{ fontSize: "0.75rem", color: "#64748b" }}>
              Mật khẩu kết nối được mã hóa trên máy chủ và bảo mật tuyệt đối.
            </span>
          </div>
        </div>

        {/* 2. Debounce & Queue Pacing */}
        <div style={{ borderBottom: "1px solid #e2e8f0", paddingBottom: "20px" }}>
          <h2 style={{ fontSize: "1.05rem", fontWeight: "700", margin: "0 0 14px 0", color: "#1e293b", display: "flex", alignItems: "center", gap: "6px" }}>
            <Clock size={18} color="#2563eb" /> Thời gian gom tin & Điều phối hội thoại
          </h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "16px" }}>
            <div>
              <label style={labelStyle}>Thời gian chờ gom tin nhắn (mili-giây)</label>
              <input
                type="number"
                value={formData.debounceMs || 3000}
                onChange={(e) => setFormData({ ...formData, debounceMs: parseInt(e.target.value, 10) })}
                style={inputStyle}
                min={500}
                max={30000}
              />
              <span style={{ fontSize: "0.75rem", color: "#64748b" }}>Thời gian chờ khách nhắn tiếp trước khi AI phản hồi (500ms - 30000ms)</span>
            </div>

            <div>
              <label style={labelStyle}>Thời gian ưu tiên giữ lượt (mili-giây)</label>
              <input
                type="number"
                value={formData.stickyWindowMs || 45000}
                onChange={(e) => setFormData({ ...formData, stickyWindowMs: parseInt(e.target.value, 10) })}
                style={inputStyle}
                min={5000}
                max={300000}
              />
              <span style={{ fontSize: "0.75rem", color: "#64748b" }}>Thời gian ưu tiên trả lời tiếp khách đang trò chuyện (5s - 300s)</span>
            </div>

            <div>
              <label style={labelStyle}>Số lượt trả lời ưu tiên liên tiếp</label>
              <input
                type="number"
                value={formData.stickyMaxTurns || 3}
                onChange={(e) => setFormData({ ...formData, stickyMaxTurns: parseInt(e.target.value, 10) })}
                style={inputStyle}
                min={1}
                max={10}
              />
              <span style={{ fontSize: "0.75rem", color: "#64748b" }}>Lượt phản hồi liên tiếp trước khi nhường cho khách khác</span>
            </div>

            <div>
              <label style={labelStyle}>Tổng thời gian ưu tiên tối đa (mili-giây)</label>
              <input
                type="number"
                value={formData.stickyMaxDurationMs || 120000}
                onChange={(e) => setFormData({ ...formData, stickyMaxDurationMs: parseInt(e.target.value, 10) })}
                style={inputStyle}
                min={10000}
                max={600000}
              />
              <span style={{ fontSize: "0.75rem", color: "#64748b" }}>Sau thời gian này sẽ nhường lượt cho khách trong hàng đợi</span>
            </div>
          </div>
        </div>

        {/* 3. Typing Speed & Operational Controls */}
        <div style={{ borderBottom: "1px solid #e2e8f0", paddingBottom: "20px" }}>
          <h2 style={{ fontSize: "1.05rem", fontWeight: "700", margin: "0 0 14px 0", color: "#1e293b", display: "flex", alignItems: "center", gap: "6px" }}>
            <Shield size={18} color="#2563eb" /> Tốc độ gõ phím & Chế độ vận hành
          </h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "16px", marginBottom: "16px" }}>
            <div>
              <label style={labelStyle}>Tốc độ gõ tối thiểu (từ/phút)</label>
              <input
                type="number"
                value={formData.typingTargetWpmMin || 80}
                onChange={(e) => setFormData({ ...formData, typingTargetWpmMin: parseInt(e.target.value, 10) })}
                style={inputStyle}
                min={20}
                max={300}
              />
            </div>
            <div>
              <label style={labelStyle}>Tốc độ gõ tối đa (từ/phút)</label>
              <input
                type="number"
                value={formData.typingTargetWpmMax || 140}
                onChange={(e) => setFormData({ ...formData, typingTargetWpmMax: parseInt(e.target.value, 10) })}
                style={inputStyle}
                min={20}
                max={300}
              />
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "12px" }}>
            <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "0.85rem", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={formData.autoReplyEnabled ?? true}
                onChange={(e) => setFormData({ ...formData, autoReplyEnabled: e.target.checked })}
              />
              <span>Tự động phản hồi tin nhắn</span>
            </label>

            <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "0.85rem", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={formData.busyMode ?? false}
                onChange={(e) => setFormData({ ...formData, busyMode: e.target.checked })}
              />
              <span>Chế độ bận (Giãn cách thời gian trả lời khi đông khách)</span>
            </label>

            <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "0.85rem", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={formData.pauseIntakeProcessing ?? false}
                onChange={(e) => setFormData({ ...formData, pauseIntakeProcessing: e.target.checked })}
              />
              <span>Tạm dừng tiếp nhận tin nhắn mới</span>
            </label>
          </div>
        </div>

        {/* 4. Persona & Business Profile */}
        <div style={{ borderBottom: "1px solid #e2e8f0", paddingBottom: "20px" }}>
          <h2 style={{ fontSize: "1.05rem", fontWeight: "700", margin: "0 0 14px 0", color: "#1e293b" }}>
            Tính cách trợ lý & Thông tin cửa hàng
          </h2>
          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            <div>
              <label style={labelStyle}>Tính cách và vai trò của trợ lý AI</label>
              <textarea
                value={formData.aiSystemPersona || ""}
                onChange={(e) => setFormData({ ...formData, aiSystemPersona: e.target.value })}
                rows={4}
                style={{ ...inputStyle, resize: "vertical" }}
                placeholder="Nhân viên chăm sóc khách hàng thân thiện, trung thực..."
              />
            </div>

            <div>
              <label style={labelStyle}>Thông tin cửa hàng, sản phẩm và dịch vụ</label>
              <textarea
                value={formData.businessProfile || ""}
                onChange={(e) => setFormData({ ...formData, businessProfile: e.target.value })}
                rows={4}
                style={{ ...inputStyle, resize: "vertical" }}
                placeholder="Thông tin cửa hàng, bảng giá, chính sách bảo hành..."
              />
            </div>
          </div>
        </div>

        {/* 5. Revision Reason & Submit */}
        <div>
          <label style={labelStyle}>Ghi chú lý do thay đổi</label>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Ví dụ: Cập nhật thời gian phản hồi vào giờ cao điểm"
            style={{ ...inputStyle, marginBottom: "16px" }}
          />

          <button
            type="submit"
            disabled={saving}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "8px",
              padding: "10px 20px",
              backgroundColor: "#2563eb",
              color: "#ffffff",
              border: "none",
              borderRadius: "6px",
              fontWeight: "600",
              fontSize: "0.95rem",
              cursor: saving ? "not-allowed" : "pointer",
            }}
          >
            {saving ? <Loader2 size={18} className="animate-spin" /> : <Save size={18} />}
            {saving ? "Đang lưu cấu hình..." : "Lưu cấu hình"}
          </button>
        </div>
      </form>
    </div>
  );
};
