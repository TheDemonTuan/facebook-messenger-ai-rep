import React, { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  LayoutDashboard,
  Inbox,
  ListOrdered,
  AlertTriangle,
  Settings,
  FileText,
  Monitor,
  Cpu,
  LogOut,
  Pause,
  Play,
  AlertOctagon,
  Radio,
} from "lucide-react";
import { apiFetch } from "../api";
import type { ChannelOverview } from "../types";

export const Layout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const [overview, setOverview] = useState<ChannelOverview | null>(null);
  const [sseConnected, setSseConnected] = useState<boolean>(false);

  const fetchOverview = async () => {
    try {
      const data = await apiFetch<ChannelOverview>("/api/overview");
      setOverview(data);
    } catch {
      // Handled
    }
  };

  useEffect(() => {
    fetchOverview();
    const interval = setInterval(fetchOverview, 5000);

    // Setup SSE connection
    const eventSource = new EventSource("/events", { withCredentials: true });
    eventSource.onopen = () => setSseConnected(true);
    eventSource.onerror = () => setSseConnected(false);

    eventSource.addEventListener("channel:status", () => fetchOverview());
    eventSource.addEventListener("conversation:manual-send", () => fetchOverview());
    eventSource.addEventListener("incident:resolved", () => fetchOverview());

    return () => {
      clearInterval(interval);
      eventSource.close();
    };
  }, []);

  const handlePauseToggle = async () => {
    if (!overview) return;
    try {
      if (overview.channelIsPaused) {
        await apiFetch("/api/channel/resume", { method: "POST" });
      } else {
        if (confirm("Tạm dừng xử lý tin nhắn? (Tin nhắn mới vẫn được lưu vào DB nhưng AI không tự động xử lý)")) {
          await apiFetch("/api/channel/pause", { method: "POST" });
        }
      }
      await fetchOverview();
    } catch (err: unknown) {
      alert((err as Error).message);
    }
  };

  const handleSuspendToggle = async () => {
    if (!overview) return;
    try {
      if (overview.channelIsSuspended) {
        if (confirm("Khôi phục hoạt động cho Sender? Hãy chắc chắn bạn đã kiểm tra phiên Messenger.")) {
          await apiFetch("/api/channel/resume", { method: "POST" });
        }
      } else {
        if (confirm("TẠM KHÓA SENDER: Toàn bộ quá trình gõ và gửi tin nhắn sẽ bị đình chỉ ngay lập tức. Tiếp tục?")) {
          await apiFetch("/api/channel/suspend", { method: "POST" });
        }
      }
      await fetchOverview();
    } catch (err: unknown) {
      alert((err as Error).message);
    }
  };

  const handleLogout = async () => {
    try {
      await apiFetch("/api/auth/logout", { method: "POST" });
      navigate("/login");
    } catch {
      navigate("/login");
    }
  };

  const navItems = [
    { label: "Tổng quan", path: "/overview", icon: LayoutDashboard },
    { label: "Hộp thư", path: "/inbox", icon: Inbox },
    { label: "Hàng đợi", path: "/queue", icon: ListOrdered, badge: overview?.queueLength },
    { label: "Sự cố", path: "/incidents", icon: AlertTriangle, badge: overview?.openIncidentsCount },
    { label: "AI Logs / Proxy", path: "/ai-logs", icon: Cpu },
    { label: "Cài đặt", path: "/settings", icon: Settings },
    { label: "Audit log", path: "/audit", icon: FileText },
    { label: "Phiên Browser", path: "/session", icon: Monitor },
  ];

  return (
    <div style={{ display: "flex", minHeight: "100vh", fontFamily: "system-ui, sans-serif" }}>
      {/* Desktop Sidebar */}
      <aside
        style={{
          width: "260px",
          backgroundColor: "#1e293b",
          color: "#f8fafc",
          display: "flex",
          flexDirection: "column",
          padding: "16px",
          boxSizing: "border-box",
        }}
      >
        <div style={{ paddingBottom: "16px", borderBottom: "1px solid #334155" }}>
          <h2 style={{ margin: "0 0 4px 0", fontSize: "1.1rem", fontWeight: "bold" }}>AI Messenger CSKH</h2>
          <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "0.8rem", color: "#94a3b8" }}>
            <Radio size={14} color={sseConnected ? "#10b981" : "#ef4444"} />
            <span>{sseConnected ? "Live Realtime SSE" : "Đang kết nối..."}</span>
          </div>
        </div>

        {/* Global Controls */}
        <div style={{ margin: "16px 0", display: "flex", flexDirection: "column", gap: "8px" }}>
          <button
            onClick={handlePauseToggle}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              padding: "8px 12px",
              borderRadius: "6px",
              border: "none",
              cursor: "pointer",
              fontWeight: "600",
              fontSize: "0.85rem",
              backgroundColor: overview?.channelIsPaused ? "#10b981" : "#f59e0b",
              color: "#ffffff",
            }}
          >
            {overview?.channelIsPaused ? <Play size={16} /> : <Pause size={16} />}
            {overview?.channelIsPaused ? "Tiếp tục xử lý" : "Tạm dừng xử lý"}
          </button>

          <button
            onClick={handleSuspendToggle}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              padding: "8px 12px",
              borderRadius: "6px",
              border: "none",
              cursor: "pointer",
              fontWeight: "600",
              fontSize: "0.85rem",
              backgroundColor: overview?.channelIsSuspended ? "#10b981" : "#ef4444",
              color: "#ffffff",
            }}
          >
            <AlertOctagon size={16} />
            {overview?.channelIsSuspended ? "Gỡ khóa Sender" : "Khóa khẩn cấp Sender"}
          </button>
        </div>

        {/* Navigation Links */}
        <nav style={{ flex: 1, display: "flex", flexDirection: "column", gap: "4px" }}>
          {navItems.map((item) => {
            const active = location.pathname.startsWith(item.path);
            const Icon = item.icon;
            return (
              <Link
                key={item.path}
                to={item.path}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "10px 12px",
                  borderRadius: "6px",
                  color: active ? "#ffffff" : "#cbd5e1",
                  backgroundColor: active ? "#334155" : "transparent",
                  textDecoration: "none",
                  fontWeight: active ? "600" : "normal",
                  fontSize: "0.9rem",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                  <Icon size={18} />
                  <span>{item.label}</span>
                </div>
                {item.badge !== undefined && item.badge > 0 && (
                  <span
                    style={{
                      backgroundColor: "#ef4444",
                      color: "#ffffff",
                      fontSize: "0.75rem",
                      padding: "2px 6px",
                      borderRadius: "10px",
                      fontWeight: "bold",
                    }}
                  >
                    {item.badge}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>

        {/* Logout */}
        <button
          onClick={handleLogout}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            padding: "10px 12px",
            borderRadius: "6px",
            border: "none",
            backgroundColor: "transparent",
            color: "#94a3b8",
            cursor: "pointer",
            fontSize: "0.85rem",
            marginTop: "auto",
          }}
        >
          <LogOut size={16} />
          <span>Đăng xuất</span>
        </button>
      </aside>

      {/* Main Content Area */}
      <main style={{ flex: 1, display: "flex", flexDirection: "column", backgroundColor: "#f8fafc" }}>
        {/* Status Alert Banner */}
        {overview?.channelIsSuspended && (
          <div
            style={{
              backgroundColor: "#fee2e2",
              borderBottom: "1px solid #f87171",
              color: "#991b1b",
              padding: "10px 20px",
              fontWeight: "bold",
              fontSize: "0.9rem",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <span>⚠️ SENDER ĐANG BỊ KHÓA (SUSPENDED): Hệ thống tự động dừng gửi tin nhắn để chống lỗi lặp hoặc checkpoint.</span>
            <button
              onClick={handleSuspendToggle}
              style={{
                backgroundColor: "#991b1b",
                color: "#ffffff",
                border: "none",
                padding: "4px 10px",
                borderRadius: "4px",
                cursor: "pointer",
              }}
            >
              Mở lại
            </button>
          </div>
        )}

        {overview?.channelIsPaused && !overview?.channelIsSuspended && (
          <div
            style={{
              backgroundColor: "#fef3c7",
              borderBottom: "1px solid #fcd34d",
              color: "#92400e",
              padding: "10px 20px",
              fontWeight: "bold",
              fontSize: "0.9rem",
            }}
          >
            ⏸️ TIẾP NHẬN TẠM DỪNG: Tin nhắn mới được lưu vào DB nhưng AI chưa tự động phản hồi.
          </div>
        )}

        <div style={{ flex: 1, padding: "24px", boxSizing: "border-box", overflowY: "auto" }}>
          {children}
        </div>
      </main>
    </div>
  );
};
