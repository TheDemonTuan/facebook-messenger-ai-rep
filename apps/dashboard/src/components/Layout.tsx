import React, { useEffect, useState, useCallback } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  LayoutDashboard,
  Inbox,
  ListOrdered,
  AlertTriangle,
  Settings,
  FileText,
  Monitor,
  LogOut,
  Pause,
  Play,
  Radio,
  Menu,
  X,
  User,
  Shield,
  Loader2,
} from "lucide-react";
import { apiFetch } from "../api";
import type { ChannelOverview } from "../types";
import { useAuth } from "../context/AuthContext";
import { useSse, useSseWakeup } from "../context/SseContext";
import { shouldRefetchOverview } from "../helpers/sse-helpers";

export const Layout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const { connected: sseConnected } = useSse();

  const [overview, setOverview] = useState<ChannelOverview | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [pausing, setPausing] = useState(false);

  const fetchOverview = useCallback(async () => {
    try {
      const data = await apiFetch<ChannelOverview>("/api/overview");
      setOverview(data);
    } catch {
      // Handled silently
    }
  }, []);

  useEffect(() => {
    fetchOverview();
  }, [fetchOverview]);

  // SSE wakeup: refetches overview only when events arrive (no tight polling duplication)
  useSseWakeup(shouldRefetchOverview, fetchOverview);

  // Close mobile drawer on route change
  useEffect(() => {
    setMobileMenuOpen(false);
  }, [location.pathname]);

  const handlePauseToggle = async () => {
    if (!overview || pausing) return;
    setPausing(true);
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
    } finally {
      setPausing(false);
    }
  };

  const handleLogout = async () => {
    try {
      await logout();
    } finally {
      navigate("/login");
    }
  };

  const navItems = [
    { label: "Tổng quan", path: "/overview", icon: LayoutDashboard },
    { label: "Hộp thư", path: "/inbox", icon: Inbox },
    { label: "Hàng đợi", path: "/queue", icon: ListOrdered, badge: overview?.queueLength },
    { label: "Sự cố", path: "/incidents", icon: AlertTriangle, badge: overview?.openIncidentsCount, badgeColor: "#ef4444" },
    { label: "AI Logs", path: "/ai-logs", icon: FileText },
    { label: "Cài đặt", path: "/settings", icon: Settings },
    { label: "Audit Trail", path: "/audit", icon: Shield },
    { label: "Session noVNC", path: "/session", icon: Monitor },
  ];

  const getStatusColor = (status?: string) => {
    switch (status) {
      case "RUNNING":
        return "#10b981";
      case "PAUSED":
        return "#f59e0b";
      case "SUSPENDED":
      case "DEGRADED":
      case "ERROR":
        return "#ef4444";
      default:
        return "#64748b";
    }
  };

  return (
    <div style={{ display: "flex", minHeight: "100vh", backgroundColor: "#f8fafc", fontFamily: "system-ui, -apple-system, sans-serif" }}>
      {/* Mobile Drawer Backdrop */}
      {mobileMenuOpen && (
        <div
          onClick={() => setMobileMenuOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            backgroundColor: "rgba(0,0,0,0.5)",
            zIndex: 40,
          }}
        />
      )}

      {/* Sidebar Navigation */}
      <aside
        style={{
          width: "250px",
          backgroundColor: "#0f172a",
          color: "#f8fafc",
          display: "flex",
          flexDirection: "column",
          flexShrink: 0,
          transition: "transform 0.2s ease-in-out",
          zIndex: 50,
        }}
        className={`sidebar-nav ${mobileMenuOpen ? "mobile-open" : ""}`}
      >
        {/* Brand Header */}
        <div style={{ padding: "20px", borderBottom: "1px solid #1e293b", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontWeight: "bold", fontSize: "1.05rem", color: "#ffffff", display: "flex", alignItems: "center", gap: "8px" }}>
              <span>Facebook AI Rep</span>
            </div>
            <div style={{ fontSize: "0.75rem", color: "#94a3b8", marginTop: "2px" }}>
              PostgreSQL State Machine
            </div>
          </div>
          <button
            onClick={() => setMobileMenuOpen(false)}
            className="mobile-close-btn"
            style={{
              background: "none",
              border: "none",
              color: "#94a3b8",
              cursor: "pointer",
              display: "none",
            }}
          >
            <X size={20} />
          </button>
        </div>

        {/* Links */}
        <nav style={{ flex: 1, padding: "12px 10px", display: "flex", flexDirection: "column", gap: "4px", overflowY: "auto" }}>
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = location.pathname === item.path || (item.path !== "/overview" && location.pathname.startsWith(item.path));
            return (
              <Link
                key={item.path}
                to={item.path}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "10px 12px",
                  borderRadius: "8px",
                  color: active ? "#ffffff" : "#94a3b8",
                  backgroundColor: active ? "#1e293b" : "transparent",
                  textDecoration: "none",
                  fontSize: "0.9rem",
                  fontWeight: active ? "600" : "400",
                  transition: "background 0.15s, color 0.15s",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                  <Icon size={18} color={active ? "#3b82f6" : "#64748b"} />
                  <span>{item.label}</span>
                </div>
                {item.badge !== undefined && item.badge > 0 && (
                  <span
                    style={{
                      backgroundColor: item.badgeColor || "#3b82f6",
                      color: "#ffffff",
                      borderRadius: "10px",
                      padding: "2px 7px",
                      fontSize: "0.72rem",
                      fontWeight: "700",
                    }}
                  >
                    {item.badge}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>

        {/* User Identity & Logout Footer */}
        <div style={{ padding: "14px 16px", borderTop: "1px solid #1e293b", backgroundColor: "#090d16" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: "0.8rem", fontWeight: "600", color: "#f1f5f9", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {user?.email || "Cloudflare Operator"}
              </div>
              <div style={{ fontSize: "0.7rem", color: "#38bdf8", marginTop: "2px", fontWeight: "600" }}>
                {user?.role || "OPERATOR"}
              </div>
            </div>
            <button
              onClick={handleLogout}
              title="Đăng xuất"
              style={{
                background: "none",
                border: "none",
                color: "#94a3b8",
                cursor: "pointer",
                padding: "6px",
                borderRadius: "4px",
                display: "flex",
                alignItems: "center",
              }}
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>

      {/* Main Container */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        {/* Header Bar */}
        <header
          style={{
            height: "56px",
            backgroundColor: "#ffffff",
            borderBottom: "1px solid #e2e8f0",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0 16px",
            position: "sticky",
            top: 0,
            zIndex: 30,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <button
              onClick={() => setMobileMenuOpen(true)}
              className="hamburger-btn"
              style={{
                background: "none",
                border: "none",
                color: "#334155",
                cursor: "pointer",
                display: "none",
                padding: "6px",
              }}
            >
              <Menu size={22} />
            </button>

            {/* SSE Live Indicator */}
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "5px",
                padding: "3px 8px",
                borderRadius: "12px",
                backgroundColor: sseConnected ? "#f0fdf4" : "#fffbeb",
                border: `1px solid ${sseConnected ? "#86efac" : "#fde68a"}`,
                fontSize: "0.75rem",
                color: sseConnected ? "#166534" : "#92400e",
                fontWeight: "600",
              }}
            >
              <Radio size={12} color={sseConnected ? "#16a34a" : "#d97706"} />
              <span>{sseConnected ? "SSE Trực tiếp" : "Đang kết nối lại..."}</span>
            </div>
          </div>

          {/* Right Header Controls: Channel Status & Pause */}
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            {overview && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                  fontSize: "0.8rem",
                  fontWeight: "600",
                  color: "#334155",
                }}
              >
                <span
                  style={{
                    width: "8px",
                    height: "8px",
                    borderRadius: "50%",
                    backgroundColor: getStatusColor(overview.channelStatus),
                  }}
                />
                <span>Kênh: {overview.channelStatus}</span>
              </div>
            )}

            {overview && (
              <button
                onClick={handlePauseToggle}
                disabled={pausing}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "4px",
                  padding: "5px 10px",
                  borderRadius: "6px",
                  border: "1px solid #cbd5e1",
                  backgroundColor: overview.channelIsPaused ? "#10b981" : "#ffffff",
                  color: overview.channelIsPaused ? "#ffffff" : "#334155",
                  fontSize: "0.8rem",
                  fontWeight: "600",
                  cursor: pausing ? "not-allowed" : "pointer",
                }}
              >
                {pausing ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : overview.channelIsPaused ? (
                  <Play size={13} />
                ) : (
                  <Pause size={13} />
                )}
                <span>{overview.channelIsPaused ? "Tiếp tục" : "Tạm dừng"}</span>
              </button>
            )}
          </div>
        </header>

        {/* Content Body */}
        <main style={{ flex: 1, padding: "20px", overflowY: "auto" }}>
          {children}
        </main>
      </div>

      {/* Embedded Responsive CSS */}
      <style>{`
        @media (max-width: 768px) {
          .hamburger-btn {
            display: block !important;
          }
          .mobile-close-btn {
            display: block !important;
          }
          .sidebar-nav {
            position: fixed !important;
            top: 0;
            bottom: 0;
            left: 0;
            transform: translateX(-100%);
          }
          .sidebar-nav.mobile-open {
            transform: translateX(0) !important;
          }
        }
      `}</style>
    </div>
  );
};
