import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiFetch } from "../api";
import { Lock, Mail, KeyRound } from "lucide-react";

export const LoginPage: React.FC = () => {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [requiresTotp, setRequiresTotp] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const res = await apiFetch<{ success?: boolean; requiresTotp?: boolean }>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({
          email,
          password,
          totpCode: requiresTotp ? totpCode : undefined,
        }),
      });

      if (res.requiresTotp) {
        setRequiresTotp(true);
      } else if (res.success) {
        navigate("/overview");
      }
    } catch (err: unknown) {
      setError((err as Error).message);
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
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: "400px",
          backgroundColor: "#ffffff",
          borderRadius: "12px",
          padding: "32px",
          boxShadow: "0 10px 25px -5px rgba(0, 0, 0, 0.3)",
        }}
      >
        <div style={{ textAlign: "center", marginBottom: "24px" }}>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: "48px",
              height: "48px",
              borderRadius: "50%",
              backgroundColor: "#eff6ff",
              color: "#2563eb",
              marginBottom: "12px",
            }}
          >
            <Lock size={24} />
          </div>
          <h1 style={{ margin: 0, fontSize: "1.4rem", fontWeight: "bold", color: "#1e293b" }}>
            Đăng nhập hệ thống
          </h1>
          <p style={{ margin: "6px 0 0 0", fontSize: "0.85rem", color: "#64748b" }}>
            AI Messenger Customer Support Control Plane
          </p>
        </div>

        {error && (
          <div
            style={{
              backgroundColor: "#fee2e2",
              border: "1px solid #f87171",
              color: "#991b1b",
              borderRadius: "6px",
              padding: "10px",
              fontSize: "0.85rem",
              marginBottom: "16px",
            }}
          >
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          {!requiresTotp ? (
            <>
              <div>
                <label style={{ display: "block", fontSize: "0.85rem", fontWeight: "600", color: "#334155", marginBottom: "4px" }}>
                  Email chủ hệ thống
                </label>
                <div style={{ position: "relative" }}>
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="owner@example.com"
                    style={{
                      width: "100%",
                      padding: "10px 12px",
                      borderRadius: "6px",
                      border: "1px solid #cbd5e1",
                      fontSize: "0.95rem",
                      boxSizing: "border-box",
                    }}
                  />
                </div>
              </div>

              <div>
                <label style={{ display: "block", fontSize: "0.85rem", fontWeight: "600", color: "#334155", marginBottom: "4px" }}>
                  Mật khẩu
                </label>
                <input
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  style={{
                    width: "100%",
                    padding: "10px 12px",
                    borderRadius: "6px",
                    border: "1px solid #cbd5e1",
                    fontSize: "0.95rem",
                    boxSizing: "border-box",
                  }}
                />
              </div>
            </>
          ) : (
            <div>
              <label style={{ display: "block", fontSize: "0.85rem", fontWeight: "600", color: "#334155", marginBottom: "4px" }}>
                Mã xác thực 2 lớp (TOTP 6 số)
              </label>
              <input
                type="text"
                required
                maxLength={6}
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ""))}
                placeholder="123456"
                autoFocus
                style={{
                  width: "100%",
                  padding: "10px 12px",
                  borderRadius: "6px",
                  border: "1px solid #cbd5e1",
                  fontSize: "1.2rem",
                  letterSpacing: "4px",
                  textAlign: "center",
                  boxSizing: "border-box",
                }}
              />
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            style={{
              backgroundColor: "#2563eb",
              color: "#ffffff",
              border: "none",
              borderRadius: "6px",
              padding: "12px",
              fontSize: "0.95rem",
              fontWeight: "bold",
              cursor: loading ? "not-allowed" : "pointer",
              marginTop: "8px",
            }}
          >
            {loading ? "Đang xử lý..." : requiresTotp ? "Xác nhận mã TOTP" : "Đăng nhập"}
          </button>
        </form>
      </div>
    </div>
  );
};
