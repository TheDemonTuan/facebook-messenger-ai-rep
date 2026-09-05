import React, { useEffect, useState } from "react";
import { apiFetch } from "../api";
import type { SettingItem, NonSecretSettings } from "../types";
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
      // Ensure no secret fields leak into form state
      setFormData(sanitizeSettingsForSave(res.settings));
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
      // Send only non-secret model parameter
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
          model: formData.aiModel,
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
      const updated = await apiFetch<SettingItem>("/api/settings", {
        method: "POST",
        body: JSON.stringify({
          ...sanitized,
          reason: reason.trim() || "Cập nhật từ trang cài đặt",
        }),
      });
      setData(updated);
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
            Cấu hình thời gian phản hồi, mô hình AI và quy tắc điều phối hội thoại
          </div>
        </div>
        <div style={{ fontSize: "0.85rem", color: "#64748b", display: "flex", alignItems: "center", gap: "6px", backgroundColor: "#f1f5f9", padding: "6px 12px", borderRadius: "6px" }}>
          <History size={16} /> Revision hiện tại: <span style={{ fontWeight: "bold", color: "#2563eb" }}>#{data?.revision || 1}</span>
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
                <Cpu size={18} color="#2563eb" /> Mô hình AI & Kiểm tra sức khỏe (Health)
              </h2>
              <span style={{ fontSize: "0.8rem", color: "#64748b" }}>
                Khóa bí mật (API Key) và Endpoint được bảo vệ tại máy chủ, không hiển thị trên trình duyệt.
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
                  {aiTestResult.model && ` • Model: ${aiTestResult.model}`}
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

          <div>
            <label style={labelStyle}>Mô hình AI (Model Identifier)</label>
            <input
              type="text"
              value={formData.aiModel || ""}
              onChange={(e) => setFormData({ ...formData, aiModel: e.target.value })}
              placeholder="grok-4.5"
              style={inputStyle}
            />
            <span style={{ fontSize: "0.75rem", color: "#64748b" }}>
              Tên model AI gửi tới Gateway (mặc định cấu hình từ môi trường máy chủ)
            </span>
          </div>
        </div>

        {/* 2. Debounce & Queue Pacing */}
        <div style={{ borderBottom: "1px solid #e2e8f0", paddingBottom: "20px" }}>
          <h2 style={{ fontSize: "1.05rem", fontWeight: "700", margin: "0 0 14px 0", color: "#1e293b", display: "flex", alignItems: "center", gap: "6px" }}>
            <Clock size={18} color="#2563eb" /> Debounce & Điều phối hàng đợi
          </h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "16px" }}>
            <div>
              <label style={labelStyle}>Debounce Inbound (ms)</label>
              <input
                type="number"
                value={formData.debounceMs || 3000}
                onChange={(e) => setFormData({ ...formData, debounceMs: parseInt(e.target.value, 10) })}
                style={inputStyle}
                min={500}
                max={30000}
              />
              <span style={{ fontSize: "0.75rem", color: "#64748b" }}>Thời gian gộp tin nhắn của khách (500ms - 30000ms)</span>
            </div>

            <div>
              <label style={labelStyle}>Sticky Window (ms)</label>
              <input
                type="number"
                value={formData.stickyWindowMs || 45000}
                onChange={(e) => setFormData({ ...formData, stickyWindowMs: parseInt(e.target.value, 10) })}
                style={inputStyle}
                min={5000}
                max={300000}
              />
              <span style={{ fontSize: "0.75rem", color: "#64748b" }}>Cửa sổ giữ phiên hội thoại ưu tiên (5s - 300s)</span>
            </div>

            <div>
              <label style={labelStyle}>Tối đa lượt Sticky (Turns)</label>
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
              <label style={labelStyle}>Tối đa thời gian Sticky (ms)</label>
              <input
                type="number"
                value={formData.stickyMaxDurationMs || 120000}
                onChange={(e) => setFormData({ ...formData, stickyMaxDurationMs: parseInt(e.target.value, 10) })}
                style={inputStyle}
                min={10000}
                max={600000}
              />
              <span style={{ fontSize: "0.75rem", color: "#64748b" }}>Sau thời gian này buộc yield cho hàng đợi</span>
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
              <label style={labelStyle}>Tốc độ gõ tối thiểu (WPM)</label>
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
              <label style={labelStyle}>Tốc độ gõ tối đa (WPM)</label>
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
              <span>Tự động phản hồi tin nhắn (Auto Reply)</span>
            </label>

            <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "0.85rem", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={formData.busyMode ?? false}
                onChange={(e) => setFormData({ ...formData, busyMode: e.target.checked })}
              />
              <span>Chế độ bận (Busy Mode - tăng pacing)</span>
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
            Persona & Thông tin kinh doanh
          </h2>
          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            <div>
              <label style={labelStyle}>System Persona (Tính cách trợ lý AI)</label>
              <textarea
                value={formData.aiSystemPersona || ""}
                onChange={(e) => setFormData({ ...formData, aiSystemPersona: e.target.value })}
                rows={4}
                style={{ ...inputStyle, resize: "vertical" }}
                placeholder="Nhân viên chăm sóc khách hàng thân thiện, trung thực..."
              />
            </div>

            <div>
              <label style={labelStyle}>Business Profile (Dữ liệu sản phẩm / dịch vụ)</label>
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
          <label style={labelStyle}>Lý do cập nhật (Audit Reason)</label>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Ví dụ: Điều chỉnh debounce theo lưu lượng cao điểm"
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
            {saving ? "Đang lưu cấu hình..." : "Lưu cấu hình hệ thống"}
          </button>
        </div>
      </form>
    </div>
  );
};
