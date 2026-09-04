import React, { useEffect, useState } from "react";
import { apiFetch } from "../api";
import type { SettingItem } from "../types";
import { Save, History } from "lucide-react";

export const SettingsPage: React.FC = () => {
  const [data, setData] = useState<SettingItem | null>(null);
  const [formData, setFormData] = useState<any>({});
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  const loadSettings = async () => {
    try {
      const res = await apiFetch<SettingItem>("/api/settings");
      setData(res);
      setFormData(res.settings);
    } catch {
      // Handled
    }
  };

  useEffect(() => {
    loadSettings();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await apiFetch("/api/settings", {
        method: "PUT",
        body: JSON.stringify({
          ...formData,
          reason: reason || "Updated from dashboard",
        }),
      });
      alert("Đã lưu cấu hình mới thành công!");
      setReason("");
      await loadSettings();
    } catch (err: unknown) {
      alert((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (!data) return <div>Đang tải cấu hình hệ thống...</div>;

  const labelStyle: React.CSSProperties = {
    display: "block",
    fontSize: "0.85rem",
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
    <div style={{ maxWidth: "800px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px" }}>
        <h1 style={{ margin: 0, fontSize: "1.5rem", fontWeight: "bold" }}>Cài đặt hệ thống</h1>
        <div style={{ fontSize: "0.9rem", color: "#64748b", display: "flex", alignItems: "center", gap: "6px" }}>
          <History size={16} /> Revision hiện tại: <span style={{ fontWeight: "bold", color: "#2563eb" }}>#{data.revision}</span>
        </div>
      </div>

      <form onSubmit={handleSubmit} style={{ backgroundColor: "#ffffff", padding: "24px", borderRadius: "8px", boxShadow: "0 1px 3px rgba(0,0,0,0.05)", display: "flex", flexDirection: "column", gap: "20px" }}>
        {/* Debounce & Pacing */}
        <div>
          <h2 style={{ fontSize: "1.1rem", fontWeight: "bold", margin: "0 0 12px 0", color: "#1e293b" }}>Debounce & Xếp hàng</h2>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
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
              <span style={{ fontSize: "0.75rem", color: "#64748b" }}>Thời gian gộp tin nhắn của khách (mặc định 3000ms)</span>
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
              <span style={{ fontSize: "0.75rem", color: "#64748b" }}>Cửa sổ giữ phiên ưu tiên (mặc định 45s)</span>
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
              <span style={{ fontSize: "0.75rem", color: "#64748b" }}>Giới hạn lượt liên tiếp khi có khách khác chờ</span>
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
              <span style={{ fontSize: "0.75rem", color: "#64748b" }}>Sau thời gian này buộc yield cho khách khác (120s)</span>
            </div>
          </div>
        </div>

        {/* AI Model & Persona */}
        <div style={{ borderTop: "1px solid #f1f5f9", paddingTop: "20px" }}>
          <h2 style={{ fontSize: "1.1rem", fontWeight: "bold", margin: "0 0 12px 0", color: "#1e293b" }}>Mô hình AI & Persona</h2>
          <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            <div>
              <label style={labelStyle}>AI Model</label>
              <input
                type="text"
                value={formData.aiModel || "gemini-3.7-flash-low"}
                onChange={(e) => setFormData({ ...formData, aiModel: e.target.value })}
                style={inputStyle}
              />
            </div>

            <div>
              <label style={labelStyle}>Thông tin doanh nghiệp (Business Profile)</label>
              <textarea
                rows={3}
                value={formData.businessProfile || ""}
                onChange={(e) => setFormData({ ...formData, businessProfile: e.target.value })}
                style={{ ...inputStyle, resize: "vertical" }}
              />
            </div>

            <div>
              <label style={labelStyle}>System Persona</label>
              <textarea
                rows={4}
                value={formData.aiSystemPersona || ""}
                onChange={(e) => setFormData({ ...formData, aiSystemPersona: e.target.value })}
                style={{ ...inputStyle, resize: "vertical" }}
              />
            </div>
          </div>
        </div>

        {/* Typing Speed */}
        <div style={{ borderTop: "1px solid #f1f5f9", paddingTop: "20px" }}>
          <h2 style={{ fontSize: "1.1rem", fontWeight: "bold", margin: "0 0 12px 0", color: "#1e293b" }}>Tốc độ gõ phím mô phỏng</h2>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
            <div>
              <label style={labelStyle}>Tốc độ tối thiểu (WPM)</label>
              <input
                type="number"
                value={formData.typingTargetWpmMin || 55}
                onChange={(e) => setFormData({ ...formData, typingTargetWpmMin: parseInt(e.target.value, 10) })}
                style={inputStyle}
                min={20}
                max={150}
              />
            </div>
            <div>
              <label style={labelStyle}>Tốc độ tối đa (WPM)</label>
              <input
                type="number"
                value={formData.typingTargetWpmMax || 65}
                onChange={(e) => setFormData({ ...formData, typingTargetWpmMax: parseInt(e.target.value, 10) })}
                style={inputStyle}
                min={20}
                max={150}
              />
            </div>
          </div>
        </div>

        {/* Reason for change */}
        <div style={{ borderTop: "1px solid #f1f5f9", paddingTop: "20px" }}>
          <label style={labelStyle}>Lý do thay đổi cấu hình (Audit log)</label>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Ví dụ: Tăng debounce lên 4000ms do khách hay gõ ngắt câu..."
            style={inputStyle}
          />
        </div>

        <button
          type="submit"
          disabled={saving}
          style={{
            backgroundColor: "#2563eb",
            color: "#ffffff",
            border: "none",
            borderRadius: "6px",
            padding: "12px 20px",
            fontWeight: "bold",
            cursor: saving ? "not-allowed" : "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "8px",
            fontSize: "0.95rem",
          }}
        >
          <Save size={18} />
          {saving ? "Đang lưu..." : "Lưu thay đổi"}
        </button>
      </form>
    </div>
  );
};
