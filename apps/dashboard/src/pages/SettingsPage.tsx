import React, { useEffect, useState, useMemo } from "react";
import { apiFetch } from "../api";
import type { AiProviderSettings, SettingItem, NonSecretSettings, SafePersonItem, PolicyMemberItem } from "../types";
import { sanitizeSettingsForSave } from "../helpers/settings-helpers";
import { useSseWakeup } from "../context/SseContext";
import { useBusinessTimeZone } from "../context/TimezoneContext";
import {
  Save,
  History,
  CheckCircle2,
  AlertCircle,
  Activity,
  Loader2,
  Cpu,
  Clock,
  ShieldCheck,
  RefreshCw,
  Search,
  UserCheck,
  UserX,
  Users,
  Trash2,
  Info,
  Globe,
  Lock,
  MessageSquare,
} from "lucide-react";

const POPULAR_TIMEZONES = [
  { value: "Asia/Ho_Chi_Minh", label: "Việt Nam (GMT+7) - Asia/Ho_Chi_Minh" },
  { value: "Asia/Bangkok", label: "Thái Lan (GMT+7) - Asia/Bangkok" },
  { value: "Asia/Singapore", label: "Singapore (GMT+8) - Asia/Singapore" },
  { value: "Asia/Tokyo", label: "Nhật Bản (GMT+9) - Asia/Tokyo" },
  { value: "America/New_York", label: "New York (EST/EDT) - America/New_York" },
  { value: "Europe/London", label: "London (GMT/BST) - Europe/London" },
  { value: "UTC", label: "Giờ chuẩn quốc tế (UTC)" },
];

export const SettingsPage: React.FC = () => {
  const { setTimeZone } = useBusinessTimeZone();
  const [data, setData] = useState<SettingItem | null>(null);
  const [formData, setFormData] = useState<Partial<NonSecretSettings>>({});
  const [policyMembers, setPolicyMembers] = useState<PolicyMemberItem[]>([]);
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

  // People Search and Membership state
  const [personSearchQuery, setPersonSearchQuery] = useState("");
  const [isSearchingPeople, setIsSearchingPeople] = useState(false);
  const [searchResults, setSearchResults] = useState<SafePersonItem[]>([]);
  const [memberActionLoading, setMemberActionLoading] = useState<string | null>(null);

  // Live timezone clock
  const [currentTimeStr, setCurrentTimeStr] = useState("");

  const activeTimeZone = formData.businessTimeZone || "Asia/Ho_Chi_Minh";

  useEffect(() => {
    const updateTime = () => {
      try {
        const formatted = new Intl.DateTimeFormat("vi-VN", {
          timeZone: activeTimeZone,
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
          weekday: "short",
        }).format(new Date());
        setCurrentTimeStr(formatted);
      } catch {
        setCurrentTimeStr("Múi giờ không hợp lệ");
      }
    };
    updateTime();
    const timer = setInterval(updateTime, 1000);
    return () => clearInterval(timer);
  }, [activeTimeZone]);

  const loadSettings = async () => {
    setError(null);
    try {
      const res = await apiFetch<SettingItem>("/api/settings");
      setData(res);
      setFormData(sanitizeSettingsForSave(res.settings));
      setPolicyMembers(res.policyMembers || []);
      setAiProvider(res.aiProvider);
      if (typeof res.settings?.businessTimeZone === "string") {
        setTimeZone(res.settings.businessTimeZone);
      }
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

  const handleSearchPeople = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!personSearchQuery.trim()) {
      setSearchResults([]);
      return;
    }
    setIsSearchingPeople(true);
    try {
      const res = await apiFetch<{ people: SafePersonItem[] }>(
        `/api/people?q=${encodeURIComponent(personSearchQuery.trim())}&limit=20`
      );
      setSearchResults(res.people || []);
    } catch (err: unknown) {
      setError((err as Error).message || "Không thể tìm kiếm danh sách người dùng");
    } finally {
      setIsSearchingPeople(false);
    }
  };

  const handleAddPolicyMember = async (person: SafePersonItem, mode: "EXCLUDE" | "INCLUDE") => {
    setMemberActionLoading(person.id);
    setError(null);
    try {
      await apiFetch<{ success: boolean; revision: number }>("/api/settings/members", {
        method: "POST",
        body: JSON.stringify({
          personId: person.id,
          policyMode: mode,
          expectedRevision: data?.revision,
          notes: `Thêm từ giao diện cài đặt (${person.conversationContext})`,
        }),
      });
      setPersonSearchQuery("");
      setSearchResults([]);
      await loadSettings();
      setSaveSuccess(`Đã thêm "${person.name}" vào danh sách ${mode === "EXCLUDE" ? "loại trừ" : "chỉ định"}.`);
      setTimeout(() => setSaveSuccess(null), 3500);
    } catch (err: unknown) {
      const msg = (err as Error).message || "";
      if (msg.includes("409") || msg.includes("xung đột") || msg.includes("Conflict") || msg.includes("revision")) {
        setError("Dữ liệu cấu hình đã bị thay đổi ở một phiên làm việc khác. Đang tải lại phiên bản mới nhất...");
        await loadSettings();
      } else {
        setError(msg || "Không thể thêm người vào danh sách");
      }
    } finally {
      setMemberActionLoading(null);
    }
  };

  const handleRemovePolicyMember = async (personId: string, displayName: string) => {
    setMemberActionLoading(personId);
    setError(null);
    try {
      await apiFetch<{ success: boolean; revision: number }>(
        `/api/settings/members/${encodeURIComponent(personId)}?expectedRevision=${data?.revision || 0}`,
        { method: "DELETE" }
      );
      await loadSettings();
      setSaveSuccess(`Đã xóa "${displayName}" khỏi danh sách thành công.`);
      setTimeout(() => setSaveSuccess(null), 3500);
    } catch (err: unknown) {
      const msg = (err as Error).message || "";
      if (msg.includes("409") || msg.includes("xung đột") || msg.includes("Conflict") || msg.includes("revision")) {
        setError("Dữ liệu cấu hình đã bị thay đổi ở một phiên làm việc khác. Đang tải lại phiên bản mới nhất...");
        await loadSettings();
      } else {
        setError(msg || "Không thể xóa thành viên khỏi danh sách");
      }
    } finally {
      setMemberActionLoading(null);
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
          reason: reason.trim() || "Cập nhật chính sách phản hồi & cài đặt hệ thống",
          expectedRevision: data?.revision,
        }),
      });

      setData(updated);
      setAiProvider(updated.aiProvider);
      setPolicyMembers(updated.policyMembers || []);
      setAiApiKey("");
      setFormData(sanitizeSettingsForSave(updated.settings));
      if (typeof updated.settings?.businessTimeZone === "string") {
        setTimeZone(updated.settings.businessTimeZone);
      }
      setSaveSuccess("Đã lưu cấu hình mới thành công!");
      setReason("");
      setTimeout(() => setSaveSuccess(null), 4000);
    } catch (err: unknown) {
      const msg = (err as Error).message || "Không thể lưu cấu hình";
      if (msg.includes("409") || msg.includes("xung đột") || msg.includes("Conflict") || msg.includes("revision")) {
        setError("Xung đột phiên bản cấu hình: Có người khác vừa cập nhật. Vui lòng tải lại trang và thử lại.");
        await loadSettings();
      } else {
        setError(msg);
      }
    } finally {
      setSaving(false);
    }
  };

  const currentReplyMode = formData.replyMode || "EVERYONE_EXCEPT";

  const filteredMembers = useMemo(() => {
    const targetMode = currentReplyMode === "EVERYONE_EXCEPT" ? "EXCLUDE" : "INCLUDE";
    return policyMembers.filter((m) => m.policyMode === targetMode);
  }, [policyMembers, currentReplyMode]);

  if (error && !data) {
    return (
      <div style={{ backgroundColor: "#fef2f2", border: "1px solid #fecaca", borderRadius: "10px", padding: "24px", color: "#991b1b" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", fontWeight: "bold", fontSize: "1.05rem", marginBottom: "8px" }}>
          <AlertCircle size={20} /> Lỗi kết nối cấu hình
        </div>
        <p style={{ margin: "0 0 16px 0", fontSize: "0.9rem" }}>{error}</p>
        <button
          onClick={loadSettings}
          style={{ display: "inline-flex", alignItems: "center", gap: "6px", padding: "8px 16px", borderRadius: "6px", backgroundColor: "#dc2626", color: "#fff", border: "none", cursor: "pointer", fontWeight: "600" }}
        >
          <RefreshCw size={14} /> Thử lại
        </button>
      </div>
    );
  }

  const labelStyle: React.CSSProperties = {
    display: "block",
    fontSize: "0.85rem",
    fontWeight: "600",
    color: "#334155",
    marginBottom: "6px",
  };

  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "9px 12px",
    borderRadius: "6px",
    border: "1px solid #cbd5e1",
    fontSize: "0.9rem",
    boxSizing: "border-box",
  };

  const switchContainerStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    padding: "12px 14px",
    borderRadius: "8px",
    backgroundColor: "#f8fafc",
    border: "1px solid #e2e8f0",
    gap: "12px",
  };

  return (
    <div style={{ maxWidth: "880px", width: "100%", margin: "0 auto", paddingBottom: "40px" }}>
      {/* Page Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px", marginBottom: "20px" }}>
        <div>
          <h1 style={{ margin: "0 0 4px 0", fontSize: "1.5rem", fontWeight: "bold", color: "#0f172a" }}>Cài đặt hệ thống & Chính sách phản hồi</h1>
          <p style={{ margin: 0, fontSize: "0.85rem", color: "#64748b" }}>
            Quản lý AI, chính sách phản hồi Messenger, múi giờ và nhịp gõ chữ an toàn.
          </p>
        </div>
        <div style={{ fontSize: "0.85rem", color: "#475569", display: "flex", alignItems: "center", gap: "6px", backgroundColor: "#f1f5f9", padding: "6px 14px", borderRadius: "20px", fontWeight: "500" }}>
          <History size={15} /> Phiên bản cấu hình: v{data?.revision ?? 1}
          {loading && <Loader2 size={13} className="animate-spin" />}
        </div>
      </div>

      {saveSuccess && (
        <div style={{ display: "flex", alignItems: "center", gap: "10px", padding: "12px 16px", borderRadius: "8px", backgroundColor: "#f0fdf4", border: "1px solid #86efac", color: "#166534", marginBottom: "16px", fontSize: "0.9rem" }}>
          <CheckCircle2 size={18} />
          <span>{saveSuccess}</span>
        </div>
      )}

      {error && (
        <div style={{ display: "flex", alignItems: "center", gap: "10px", padding: "12px 16px", borderRadius: "8px", backgroundColor: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", marginBottom: "16px", fontSize: "0.9rem" }}>
          <AlertCircle size={18} />
          <span>{error}</span>
        </div>
      )}

      <form onSubmit={handleSubmit} style={{ backgroundColor: "#ffffff", padding: "24px", borderRadius: "10px", boxShadow: "0 1px 3px rgba(0,0,0,0.06)", display: "flex", flexDirection: "column", gap: "28px" }}>

        {/* ================================================================= */}
        {/* 1. CHÍNH SÁCH PHẢN HỒI MESSENGER (REPLY POLICY CONTROLS) */}
        {/* ================================================================= */}
        <div style={{ borderBottom: "1px solid #e2e8f0", paddingBottom: "24px" }}>
          <div style={{ marginBottom: "18px" }}>
            <h2 style={{ fontSize: "1.15rem", fontWeight: "700", margin: "0 0 4px 0", color: "#1e293b", display: "flex", alignItems: "center", gap: "8px" }}>
              <ShieldCheck size={20} color="#2563eb" /> Chính sách phản hồi Messenger (Reply Eligibility)
            </h2>
            <span style={{ fontSize: "0.82rem", color: "#64748b" }}>
              Áp dụng chính sách nghiêm ngặt (Fail-closed): Chỉ phản hồi người dùng đã xác minh; nhóm chat, trang Facebook và bot mặc định bị tắt.
            </span>
          </div>

          {/* Mode Selector: EVERYONE_EXCEPT vs ONLY_SELECTED */}
          <div style={{ marginBottom: "20px" }}>
            <label style={labelStyle}>Chế độ lọc đối tượng phản hồi</label>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "12px", marginTop: "8px" }}>
              <label
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: "10px",
                  padding: "14px",
                  borderRadius: "8px",
                  border: currentReplyMode === "EVERYONE_EXCEPT" ? "2px solid #2563eb" : "1px solid #cbd5e1",
                  backgroundColor: currentReplyMode === "EVERYONE_EXCEPT" ? "#eff6ff" : "#ffffff",
                  cursor: "pointer",
                  transition: "all 0.15s",
                }}
              >
                <input
                  type="radio"
                  name="replyMode"
                  value="EVERYONE_EXCEPT"
                  checked={currentReplyMode === "EVERYONE_EXCEPT"}
                  onChange={() => setFormData({ ...formData, replyMode: "EVERYONE_EXCEPT" })}
                  style={{ marginTop: "3px" }}
                />
                <div>
                  <div style={{ fontWeight: "700", fontSize: "0.92rem", color: "#1e293b" }}>
                    Trả lời tất cả, NGOẠI TRỪ danh sách đen
                  </div>
                  <div style={{ fontSize: "0.78rem", color: "#64748b", marginTop: "3px", lineHeight: 1.4 }}>
                    Mặc định phản hồi mọi khách hàng cá nhân đã xác thực, trừ những người có tên trong danh sách loại trừ bên dưới.
                  </div>
                </div>
              </label>

              <label
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: "10px",
                  padding: "14px",
                  borderRadius: "8px",
                  border: currentReplyMode === "ONLY_SELECTED" ? "2px solid #2563eb" : "1px solid #cbd5e1",
                  backgroundColor: currentReplyMode === "ONLY_SELECTED" ? "#eff6ff" : "#ffffff",
                  cursor: "pointer",
                  transition: "all 0.15s",
                }}
              >
                <input
                  type="radio"
                  name="replyMode"
                  value="ONLY_SELECTED"
                  checked={currentReplyMode === "ONLY_SELECTED"}
                  onChange={() => setFormData({ ...formData, replyMode: "ONLY_SELECTED" })}
                  style={{ marginTop: "3px" }}
                />
                <div>
                  <div style={{ fontWeight: "700", fontSize: "0.92rem", color: "#1e293b" }}>
                    CHỈ trả lời những người được chỉ định
                  </div>
                  <div style={{ fontSize: "0.78rem", color: "#64748b", marginTop: "3px", lineHeight: 1.4 }}>
                    Chế độ an toàn cao nhất: AI chỉ phản hồi tin nhắn từ những người có tên trong danh sách được chọn bên dưới.
                  </div>
                </div>
              </label>
            </div>
          </div>

          {/* Independent Source Switches */}
          <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginBottom: "20px" }}>
            <label style={labelStyle}>Công tắc nguồn tin nhắn độc lập (Source Controls)</label>

            {/* Direct Messages */}
            <div style={switchContainerStyle}>
              <div>
                <div style={{ fontWeight: "600", fontSize: "0.9rem", color: "#1e293b", display: "flex", alignItems: "center", gap: "6px" }}>
                  <MessageSquare size={16} color="#2563eb" /> Tin nhắn trực tiếp 1-1 (Direct Messages)
                </div>
                <div style={{ fontSize: "0.78rem", color: "#64748b", marginTop: "2px" }}>
                  Cho phép tự động trả lời khi khách hàng nhắn tin riêng tới tài khoản (Khuyên dùng: BẬT).
                </div>
              </div>
              <input
                type="checkbox"
                checked={formData.directRepliesEnabled ?? true}
                onChange={(e) => setFormData({ ...formData, directRepliesEnabled: e.target.checked })}
                style={{ width: "18px", height: "18px", cursor: "pointer" }}
              />
            </div>

            {/* Group Chats */}
            <div style={switchContainerStyle}>
              <div>
                <div style={{ fontWeight: "600", fontSize: "0.9rem", color: "#1e293b", display: "flex", alignItems: "center", gap: "6px" }}>
                  <Users size={16} color="#7c3aed" /> Nhóm chat Messenger (Group Chats)
                </div>
                <div style={{ fontSize: "0.78rem", color: "#64748b", marginTop: "2px" }}>
                  Cho phép AI phản hồi trong nhóm chat. Nhóm yêu cầu phải gắn thẻ bot để tránh làm phiền (Mặc định: TẮT).
                </div>
              </div>
              <input
                type="checkbox"
                checked={formData.groupRepliesEnabled ?? false}
                onChange={(e) => setFormData({ ...formData, groupRepliesEnabled: e.target.checked })}
                style={{ width: "18px", height: "18px", cursor: "pointer" }}
              />
            </div>

            {/* Require Group Mention Switch & Genuine Explanation */}
            {(formData.groupRepliesEnabled || formData.requireGroupMention) && (
              <div style={{ marginLeft: "18px", padding: "12px 14px", backgroundColor: "#f5f3ff", borderRadius: "8px", border: "1px solid #ddd6fe" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "8px" }}>
                  <label style={{ fontWeight: "600", fontSize: "0.85rem", color: "#4c1d95", display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={formData.requireGroupMention ?? true}
                      onChange={(e) => setFormData({ ...formData, requireGroupMention: e.target.checked })}
                      style={{ width: "16px", height: "16px" }}
                    />
                    Bắt buộc gắn thẻ (@tag) tên bot trong nhóm chat
                  </label>
                </div>
                <div style={{ fontSize: "0.78rem", color: "#5b21b6", lineHeight: 1.45, display: "flex", gap: "6px" }}>
                  <Info size={16} style={{ flexShrink: 0, marginTop: "2px" }} />
                  <span>
                    <strong>Giải thích kỹ thuật về nhóm Messenger:</strong> Do chính sách kiểm soát của Facebook và cơ chế DOM trên trình duyệt, tài khoản AI chỉ được kích hoạt phản hồi khi có thành viên gắn thẻ (@mention) chính danh tài khoản bot trong tin nhắn. Tin nhắn không có thẻ nhắc sẽ tự động bị bỏ qua để tránh gây nhiễu cuộc trò chuyện tập thể.
                  </span>
                </div>
              </div>
            )}

            {/* Facebook Page Senders */}
            <div style={switchContainerStyle}>
              <div>
                <div style={{ fontWeight: "600", fontSize: "0.9rem", color: "#1e293b", display: "flex", alignItems: "center", gap: "6px" }}>
                  <Globe size={16} color="#0891b2" /> Tin nhắn từ Trang Facebook (Page Senders)
                </div>
                <div style={{ fontSize: "0.78rem", color: "#64748b", marginTop: "2px" }}>
                  Cho phép trả lời tin nhắn gửi đến từ Trang Facebook khác (Phân biệt độc lập với tài khoản kênh của chính bot).
                </div>
              </div>
              <input
                type="checkbox"
                checked={formData.pageRepliesEnabled ?? false}
                onChange={(e) => setFormData({ ...formData, pageRepliesEnabled: e.target.checked })}
                style={{ width: "18px", height: "18px", cursor: "pointer" }}
              />
            </div>

            {/* Non-person Senders */}
            <div style={switchContainerStyle}>
              <div>
                <div style={{ fontWeight: "600", fontSize: "0.9rem", color: "#1e293b", display: "flex", alignItems: "center", gap: "6px" }}>
                  <Cpu size={16} color="#d97706" /> Tin nhắn từ tài khoản phi cá nhân / bot (Non-person)
                </div>
                <div style={{ fontSize: "0.78rem", color: "#64748b", marginTop: "2px" }}>
                  Cho phép phản hồi tin nhắn tự động từ các ứng dụng hoặc bot bên ngoài (Mặc định: TẮT).
                </div>
              </div>
              <input
                type="checkbox"
                checked={formData.nonPersonRepliesEnabled ?? false}
                onChange={(e) => setFormData({ ...formData, nonPersonRepliesEnabled: e.target.checked })}
                style={{ width: "18px", height: "18px", cursor: "pointer" }}
              />
            </div>

            {/* UNKNOWN Sender Policy Notice */}
            <div style={{ display: "flex", alignItems: "center", gap: "10px", padding: "10px 14px", backgroundColor: "#f8fafc", borderRadius: "8px", border: "1px dashed #cbd5e1", fontSize: "0.8rem", color: "#64748b" }}>
              <Lock size={16} color="#64748b" style={{ flexShrink: 0 }} />
              <span>
                <strong>Người gửi không xác định (UNKNOWN):</strong> Luôn luôn bị vô hiệu hóa hoàn toàn trong lõi hệ thống theo quy định an toàn (Fail-closed). Không có nút bật để đảm bảo tuyệt đối an toàn.
              </span>
            </div>
          </div>

          {/* Searchable People Include/Exclude Picker */}
          <div style={{ backgroundColor: "#f8fafc", padding: "16px", borderRadius: "8px", border: "1px solid #e2e8f0" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "8px", marginBottom: "12px" }}>
              <div style={{ fontWeight: "700", fontSize: "0.92rem", color: "#1e293b", display: "flex", alignItems: "center", gap: "6px" }}>
                {currentReplyMode === "EVERYONE_EXCEPT" ? (
                  <>
                    <UserX size={17} color="#dc2626" /> Danh sách người cần loại trừ (Exclude List)
                  </>
                ) : (
                  <>
                    <UserCheck size={17} color="#16a34a" /> Danh sách người được chỉ định (Allow List)
                  </>
                )}
                <span style={{ fontSize: "0.75rem", backgroundColor: "#e2e8f0", color: "#475569", padding: "2px 8px", borderRadius: "12px" }}>
                  {filteredMembers.length} người
                </span>
              </div>
            </div>

            {/* Search Input */}
            <div style={{ display: "flex", gap: "8px", marginBottom: "14px" }}>
              <div style={{ position: "relative", flex: 1 }}>
                <input
                  type="text"
                  placeholder="Tìm kiếm người dùng đã xác minh qua tên hoặc ngữ cảnh..."
                  value={personSearchQuery}
                  onChange={(e) => setPersonSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleSearchPeople();
                    }
                  }}
                  style={{ ...inputStyle, paddingLeft: "34px", backgroundColor: "#ffffff" }}
                />
                <Search size={16} color="#94a3b8" style={{ position: "absolute", left: "10px", top: "11px" }} />
              </div>
              <button
                type="button"
                onClick={() => handleSearchPeople()}
                disabled={isSearchingPeople || !personSearchQuery.trim()}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  padding: "8px 16px",
                  borderRadius: "6px",
                  backgroundColor: "#2563eb",
                  color: "#ffffff",
                  border: "none",
                  fontWeight: "600",
                  fontSize: "0.85rem",
                  cursor: isSearchingPeople || !personSearchQuery.trim() ? "not-allowed" : "pointer",
                }}
              >
                {isSearchingPeople ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
                Tìm
              </button>
            </div>

            {/* Search Results Dropdown / Panel */}
            {searchResults.length > 0 && (
              <div style={{ marginBottom: "16px", backgroundColor: "#ffffff", borderRadius: "8px", border: "1px solid #cbd5e1", overflow: "hidden", maxHeight: "280px", overflowY: "auto", boxShadow: "0 2px 4px rgba(0,0,0,0.05)" }}>
                <div style={{ padding: "8px 12px", backgroundColor: "#f1f5f9", fontSize: "0.78rem", fontWeight: "700", color: "#475569" }}>
                  Kết quả tìm kiếm ({searchResults.length})
                </div>
                {searchResults.map((person) => {
                  const targetMode = currentReplyMode === "EVERYONE_EXCEPT" ? "EXCLUDE" : "INCLUDE";
                  const isAlreadyAdded = policyMembers.some((m) => m.id === person.id || m.personId === person.id);
                  const isActionLoading = memberActionLoading === person.id;

                  return (
                    <div
                      key={person.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        padding: "10px 14px",
                        borderBottom: "1px solid #f1f5f9",
                        gap: "10px",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: "10px", minWidth: 0 }}>
                        <div style={{ width: "34px", height: "34px", borderRadius: "50%", backgroundColor: "#e2e8f0", overflow: "hidden", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
                          {person.avatarUrl ? (
                            <img src={person.avatarUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                          ) : (
                            <Users size={16} color="#64748b" />
                          )}
                        </div>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: "600", fontSize: "0.88rem", color: "#0f172a", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                            {person.name}
                          </div>
                          <div style={{ fontSize: "0.75rem", color: "#64748b" }}>
                            {person.conversationContext}
                          </div>
                        </div>
                      </div>

                      <button
                        type="button"
                        disabled={isAlreadyAdded || isActionLoading}
                        onClick={() => handleAddPolicyMember(person, targetMode)}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "5px",
                          padding: "6px 12px",
                          borderRadius: "6px",
                          backgroundColor: isAlreadyAdded ? "#e2e8f0" : targetMode === "EXCLUDE" ? "#fee2e2" : "#dcfce7",
                          color: isAlreadyAdded ? "#94a3b8" : targetMode === "EXCLUDE" ? "#991b1b" : "#166534",
                          border: "none",
                          fontSize: "0.78rem",
                          fontWeight: "700",
                          cursor: isAlreadyAdded || isActionLoading ? "not-allowed" : "pointer",
                          flexShrink: 0,
                        }}
                      >
                        {isActionLoading ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : isAlreadyAdded ? (
                          "Đã có trong danh sách"
                        ) : targetMode === "EXCLUDE" ? (
                          <>
                            <UserX size={13} /> Loại trừ
                          </>
                        ) : (
                          <>
                            <UserCheck size={13} /> Chỉ định
                          </>
                        )}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Members List */}
            {filteredMembers.length === 0 ? (
              <div style={{ padding: "24px", textAlign: "center", color: "#94a3b8", fontSize: "0.85rem", backgroundColor: "#ffffff", borderRadius: "6px", border: "1px dashed #cbd5e1" }}>
                {currentReplyMode === "EVERYONE_EXCEPT"
                  ? "Danh sách loại trừ đang trống. AI sẽ phản hồi tất cả người dùng hợp lệ."
                  : "Chưa có người nào được chỉ định. Vui lòng tìm kiếm phía trên để thêm người nhận phản hồi."}
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "6px", backgroundColor: "#ffffff", borderRadius: "6px", border: "1px solid #e2e8f0", overflow: "hidden" }}>
                {filteredMembers.map((member) => {
                  const isActionLoading = memberActionLoading === member.id || memberActionLoading === member.personId;
                  const personSafeId = member.id || member.personId || "";

                  return (
                    <div
                      key={personSafeId}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        padding: "10px 14px",
                        borderBottom: "1px solid #f1f5f9",
                        gap: "10px",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: "10px", minWidth: 0 }}>
                        <div style={{ width: "32px", height: "32px", borderRadius: "50%", backgroundColor: "#e2e8f0", overflow: "hidden", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
                          {member.avatarUrl ? (
                            <img src={member.avatarUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                          ) : (
                            <Users size={16} color="#64748b" />
                          )}
                        </div>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: "600", fontSize: "0.88rem", color: "#0f172a" }}>
                            {member.displayName || "Người dùng"}
                          </div>
                          {member.conversationContext && (
                            <div style={{ fontSize: "0.75rem", color: "#64748b" }}>
                              {member.conversationContext}
                            </div>
                          )}
                        </div>
                      </div>

                      <div style={{ display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 }}>
                        <span
                          style={{
                            fontSize: "0.72rem",
                            fontWeight: "700",
                            padding: "3px 8px",
                            borderRadius: "4px",
                            backgroundColor: member.policyMode === "EXCLUDE" ? "#fee2e2" : "#dcfce7",
                            color: member.policyMode === "EXCLUDE" ? "#991b1b" : "#166534",
                          }}
                        >
                          {member.policyMode === "EXCLUDE" ? "LOẠI TRỪ" : "CHỈ ĐỊNH"}
                        </span>
                        <button
                          type="button"
                          disabled={isActionLoading}
                          onClick={() => handleRemovePolicyMember(personSafeId, member.displayName || "Người dùng")}
                          title="Xóa khỏi danh sách"
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            width: "30px",
                            height: "30px",
                            borderRadius: "6px",
                            backgroundColor: "#fef2f2",
                            color: "#dc2626",
                            border: "1px solid #fecaca",
                            cursor: isActionLoading ? "not-allowed" : "pointer",
                          }}
                        >
                          {isActionLoading ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={14} />}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* ================================================================= */}
        {/* 2. DỊCH VỤ AI & KIỂM TRA KẾT NỐI (AI PROVIDER) */}
        {/* ================================================================= */}
        <div style={{ borderBottom: "1px solid #e2e8f0", paddingBottom: "24px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "10px", marginBottom: "14px" }}>
            <div>
              <h2 style={{ fontSize: "1.1rem", fontWeight: "700", margin: "0 0 2px 0", color: "#1e293b", display: "flex", alignItems: "center", gap: "6px" }}>
                <Cpu size={18} color="#2563eb" /> Dịch vụ AI & Kiểm tra kết nối
              </h2>
              <span style={{ fontSize: "0.8rem", color: "#64748b" }}>
                Cấu hình API được bảo mật máy chủ, hỗ trợ giao thức tương thích OpenAI / Anthropic.
              </span>
            </div>
            <button
              type="button"
              onClick={handleTestAi}
              disabled={testingAi || !aiProvider.model}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                padding: "7px 14px",
                borderRadius: "6px",
                backgroundColor: "#f1f5f9",
                border: "1px solid #cbd5e1",
                fontSize: "0.85rem",
                fontWeight: "600",
                color: "#334155",
                cursor: testingAi || !aiProvider.model ? "not-allowed" : "pointer",
              }}
            >
              {testingAi ? <Loader2 size={14} className="animate-spin" /> : <Activity size={14} />}
              {testingAi ? "Đang kiểm tra..." : "Kiểm tra kết nối AI"}
            </button>
          </div>

          {aiTestResult && (
            <div
              style={{
                padding: "12px 16px",
                borderRadius: "8px",
                backgroundColor: aiTestResult.healthy ? "#f0fdf4" : "#fef2f2",
                border: `1px solid ${aiTestResult.healthy ? "#86efac" : "#fca5a5"}`,
                color: aiTestResult.healthy ? "#166534" : "#991b1b",
                fontSize: "0.85rem",
                marginBottom: "16px",
              }}
            >
              <div style={{ fontWeight: "bold", marginBottom: "4px" }}>
                {aiTestResult.healthy ? "✓ Trạng thái: Sẵn sàng (Healthy)" : "✕ Kiểm tra kết nối thất bại"}
              </div>
              {aiTestResult.model && <div>Mô hình: {aiTestResult.model} • Độ trễ: {aiTestResult.latencyMs}ms</div>}
              {aiTestResult.error && <div style={{ marginTop: "4px" }}>Chi tiết lỗi: {aiTestResult.error}</div>}
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "14px" }}>
            <div>
              <label style={labelStyle}>Loại dịch vụ AI</label>
              <select
                value={aiProvider.apiFormat}
                onChange={(e) => setAiProvider({ ...aiProvider, apiFormat: e.target.value as "OPENAI_COMPATIBLE" | "ANTHROPIC_COMPATIBLE" })}
                style={inputStyle}
              >
                <option value="OPENAI_COMPATIBLE">Dịch vụ theo chuẩn OpenAI</option>
                <option value="ANTHROPIC_COMPATIBLE">Dịch vụ theo chuẩn Claude (Anthropic)</option>
              </select>
            </div>

            <div>
              <label style={labelStyle}>Địa chỉ dịch vụ</label>
              <input
                type="url"
                value={aiProvider.baseUrl}
                onChange={(e) => setAiProvider({ ...aiProvider, baseUrl: e.target.value })}
                placeholder="https://gateway.example.com/v1"
                style={inputStyle}
              />
            </div>

            <div>
              <label style={labelStyle}>Tên mô hình</label>
              <input
                type="text"
                value={aiProvider.model}
                onChange={(e) => setAiProvider({ ...aiProvider, model: e.target.value })}
                placeholder="auto/best-chat hoặc claude-sonnet-4-6"
                style={inputStyle}
              />
            </div>

            <div>
              <label style={labelStyle}>
                Mật khẩu kết nối
                {aiProvider.apiKeyConfigured && (
                  <span style={{ marginLeft: "6px", color: "#16a34a", fontWeight: "normal" }}>✓ Đã được lưu trên server</span>
                )}
              </label>
              <input
                type="password"
                value={aiApiKey}
                onChange={(e) => setAiApiKey(e.target.value)}
                placeholder={aiProvider.apiKeyConfigured ? "•••••••••••••••• (Để trống nếu không đổi)" : "Nhập mật khẩu kết nối"}
                style={inputStyle}
              />
            </div>
          </div>
        </div>

        {/* ================================================================= */}
        {/* 3. MÚI GIỜ DOANH NGHIỆP & NHỊP ĐỘ GÕ CHỮ (PACING & TIMEZONE) */}
        {/* ================================================================= */}
        <div style={{ borderBottom: "1px solid #e2e8f0", paddingBottom: "24px" }}>
          <h2 style={{ fontSize: "1.1rem", fontWeight: "700", margin: "0 0 14px 0", color: "#1e293b", display: "flex", alignItems: "center", gap: "6px" }}>
            <Clock size={18} color="#2563eb" /> Múi giờ & Điều phối nhịp độ hội thoại
          </h2>

          {/* Timezone Selector & Live Indicator */}
          <div style={{ marginBottom: "18px", padding: "14px", backgroundColor: "#f8fafc", borderRadius: "8px", border: "1px solid #e2e8f0" }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "12px", alignItems: "center" }}>
              <div>
                <label style={labelStyle}>
                  <Globe size={15} style={{ display: "inline", verticalAlign: "middle", marginRight: "4px" }} /> Múi giờ hoạt động doanh nghiệp (IANA)
                </label>
                <select
                  value={POPULAR_TIMEZONES.some((tz) => tz.value === formData.businessTimeZone) ? formData.businessTimeZone : "custom"}
                  onChange={(e) => {
                    if (e.target.value !== "custom") {
                      setFormData({ ...formData, businessTimeZone: e.target.value });
                    }
                  }}
                  style={inputStyle}
                >
                  {POPULAR_TIMEZONES.map((tz) => (
                    <option key={tz.value} value={tz.value}>
                      {tz.label}
                    </option>
                  ))}
                  <option value="custom">Múi giờ tùy chỉnh khác...</option>
                </select>
                {(!POPULAR_TIMEZONES.some((tz) => tz.value === formData.businessTimeZone) || formData.businessTimeZone === "") && (
                  <input
                    type="text"
                    value={formData.businessTimeZone || ""}
                    onChange={(e) => setFormData({ ...formData, businessTimeZone: e.target.value })}
                    placeholder="Nhập mã IANA (ví dụ: Asia/Ho_Chi_Minh)"
                    style={{ ...inputStyle, marginTop: "8px" }}
                  />
                )}
              </div>

              {/* Live Time Indicator */}
              <div style={{ padding: "12px 16px", backgroundColor: "#ffffff", borderRadius: "6px", border: "1px solid #cbd5e1" }}>
                <div style={{ fontSize: "0.78rem", color: "#64748b", marginBottom: "4px", display: "flex", alignItems: "center", gap: "4px" }}>
                  <Clock size={14} color="#2563eb" /> Giờ hiện tại theo múi giờ đã chọn:
                </div>
                <div style={{ fontSize: "1.05rem", fontWeight: "700", color: "#1e293b", fontFamily: "monospace" }}>
                  {currentTimeStr || "Đang tính toán..."}
                </div>
                <div style={{ fontSize: "0.72rem", color: "#94a3b8", marginTop: "2px" }}>
                  Múi giờ: {activeTimeZone}
                </div>
              </div>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "14px", marginBottom: "16px" }}>
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
              <label style={labelStyle}>Tốc độ gõ giả lập tối thiểu (từ/phút)</label>
              <input
                type="number"
                value={formData.typingTargetWpmMin || 55}
                onChange={(e) => setFormData({ ...formData, typingTargetWpmMin: parseInt(e.target.value, 10) })}
                style={inputStyle}
                min={20}
                max={300}
              />
            </div>

            <div>
              <label style={labelStyle}>Tốc độ gõ giả lập tối đa (từ/phút)</label>
              <input
                type="number"
                value={formData.typingTargetWpmMax || 65}
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

        {/* ================================================================= */}
        {/* 4. TÍNH CÁCH TRỢ LÝ & THÔNG TIN CỬA HÀNG */}
        {/* ================================================================= */}
        <div style={{ borderBottom: "1px solid #e2e8f0", paddingBottom: "24px" }}>
          <h2 style={{ fontSize: "1.1rem", fontWeight: "700", margin: "0 0 14px 0", color: "#1e293b" }}>
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
                placeholder="Nhân viên chăm sóc khách hàng lịch sự, ngắn gọn và trung thực..."
              />
            </div>

            <div>
              <label style={labelStyle}>Hồ sơ và thông tin hoạt động kinh doanh</label>
              <textarea
                value={formData.businessProfile || ""}
                onChange={(e) => setFormData({ ...formData, businessProfile: e.target.value })}
                rows={4}
                style={{ ...inputStyle, resize: "vertical" }}
                placeholder="Thông tin về sản phẩm, dịch vụ, giờ làm việc và quy định đổi trả..."
              />
            </div>
          </div>
        </div>

        {/* ================================================================= */}
        {/* 5. LÝ DO CẬP NHẬT & NÚT LƯU THAY ĐỔI */}
        {/* ================================================================= */}
        <div>
          <div style={{ marginBottom: "16px" }}>
            <label style={labelStyle}>Lý do cập nhật cấu hình (được ghi nhật ký kiểm toán)</label>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Ví dụ: Cập nhật chính sách phản hồi Messenger hoặc đổi mô hình AI"
              style={inputStyle}
            />
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px" }}>
            <button
              type="submit"
              disabled={saving}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "8px",
                padding: "10px 24px",
                borderRadius: "8px",
                backgroundColor: "#2563eb",
                color: "#ffffff",
                border: "none",
                fontWeight: "600",
                fontSize: "0.95rem",
                cursor: saving ? "not-allowed" : "pointer",
                boxShadow: "0 1px 2px rgba(0,0,0,0.1)",
              }}
            >
              {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
              {saving ? "Đang lưu cấu hình..." : "Lưu cấu hình"}
            </button>
          </div>
        </div>

      </form>
    </div>
  );
};
