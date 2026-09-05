import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { ShieldCheck, ArrowRight, Loader2, AlertCircle, Sparkles } from "lucide-react";
import { getStoredDevEmail } from "../api";

export const LoginPage: React.FC = () => {
  const navigate = useNavigate();
  const { user, login } = useAuth();
  const [devEmail, setDevEmail] = useState(getStoredDevEmail() || "admin@example.com");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // If already authenticated via Cloudflare identity header, navigate to overview
  useEffect(() => {
    if (user) {
      navigate("/overview", { replace: true });
    }
  }, [user, navigate]);

  const handleCloudflareLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      await login(devEmail.trim() || undefined);
      navigate("/overview", { replace: true });
    } catch (err: unknown) {
      setError((err as Error).message || "Không thể xác thực danh tính qua Cloudflare Access");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "#0f172a",
        padding: "20px",
        boxSizing: "border-box",
        fontFamily: "system-ui, -apple-system, sans-serif",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: "420px",
          backgroundColor: "#ffffff",
          borderRadius: "14px",
          padding: "36px",
          boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.4), 0 8px 10px -6px rgba(0, 0, 0, 0.3)",
        }}
      >
        <div style={{ textAlign: "center", marginBottom: "28px" }}>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: "56px",
              height: "56px",
              borderRadius: "14px",
              backgroundColor: "#f97316",
              color: "#ffffff",
              marginBottom: "16px",
              boxShadow: "0 4px 12px rgba(249, 115, 22, 0.35)",
            }}
          >
            <ShieldCheck size={32} />
          </div>
          <h1 style={{ margin: "0 0 6px 0", fontSize: "1.45rem", fontWeight: "700", color: "#0f172a" }}>
            Đăng nhập hệ thống
          </h1>
          <p style={{ margin: 0, fontSize: "0.85rem", color: "#64748b" }}>
            Trợ lý Facebook Messenger • Xác thực tài khoản an toàn
          </p>
        </div>

        {error && (
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: "10px",
              padding: "12px",
              borderRadius: "8px",
              backgroundColor: "#fef2f2",
              border: "1px solid #fecaca",
              color: "#991b1b",
              fontSize: "0.85rem",
              marginBottom: "20px",
            }}
          >
            <AlertCircle size={18} style={{ flexShrink: 0, marginTop: "2px" }} />
            <div>{error}</div>
          </div>
        )}

        <form onSubmit={handleCloudflareLogin} style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
          <div
            style={{
              padding: "12px 14px",
              backgroundColor: "#f8fafc",
              border: "1px solid #e2e8f0",
              borderRadius: "8px",
              fontSize: "0.8rem",
              color: "#475569",
              lineHeight: 1.5,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "6px", fontWeight: "600", color: "#1e293b", marginBottom: "4px" }}>
              <Sparkles size={14} color="#f97316" /> Xác thực nhanh chóng
            </div>
            Quyền truy cập được xác minh trực tiếp và bảo mật an toàn cho tài khoản của bạn.
          </div>

          <div>
            <label
              style={{
                display: "block",
                fontSize: "0.8rem",
                fontWeight: "600",
                color: "#475569",
                marginBottom: "6px",
              }}
            >
              Email tài khoản
            </label>
            <input
              type="email"
              value={devEmail}
              onChange={(e) => setDevEmail(e.target.value)}
              placeholder="admin@example.com"
              required
              style={{
                width: "100%",
                padding: "10px 12px",
                borderRadius: "8px",
                border: "1px solid #cbd5e1",
                fontSize: "0.9rem",
                boxSizing: "border-box",
                outline: "none",
              }}
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "8px",
              width: "100%",
              padding: "12px 16px",
              borderRadius: "8px",
              border: "none",
              backgroundColor: "#f97316",
              color: "#ffffff",
              fontSize: "0.95rem",
              fontWeight: "600",
              cursor: loading ? "not-allowed" : "pointer",
              transition: "background-color 0.2s",
              boxShadow: "0 2px 4px rgba(249, 115, 22, 0.2)",
            }}
          >
            {loading ? (
              <>
                <Loader2 size={18} className="animate-spin" />
                <span>Đang xác thực...</span>
              </>
            ) : (
              <>
                <span>Đăng nhập hệ thống</span>
                <ArrowRight size={18} />
              </>
            )}
          </button>
        </form>

        <div style={{ marginTop: "24px", textAlign: "center", fontSize: "0.75rem", color: "#94a3b8" }}>
          Hệ thống trợ lý tự động Facebook Messenger
        </div>
      </div>
    </div>
  );
};
