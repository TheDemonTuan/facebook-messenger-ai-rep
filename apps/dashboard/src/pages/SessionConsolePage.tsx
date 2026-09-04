import React from "react";
import { Monitor, ExternalLink, ShieldAlert } from "lucide-react";

export const SessionConsolePage: React.FC = () => {
  // noVNC url typically served on session subdomain via Cloudflare Tunnel or local port 6080
  const sessionHost = window.location.hostname;
  const noVncUrl = `http://${sessionHost}:6080/vnc.html?autoconnect=true`;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", gap: "16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h1 style={{ margin: 0, fontSize: "1.5rem", fontWeight: "bold" }}>Phiên trình duyệt (noVNC Console)</h1>
          <div style={{ fontSize: "0.85rem", color: "#64748b", marginTop: "4px" }}>
            Truy cập trực tiếp màn hình trình duyệt Chromium để đăng nhập Facebook, vượt checkpoint hoặc kiểm tra giao diện.
          </div>
        </div>
        <a
          href={noVncUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "6px",
            backgroundColor: "#2563eb",
            color: "#ffffff",
            padding: "8px 14px",
            borderRadius: "6px",
            textDecoration: "none",
            fontWeight: "600",
            fontSize: "0.85rem",
          }}
        >
          <ExternalLink size={16} /> Mở tab mới
        </a>
      </div>

      <div
        style={{
          backgroundColor: "#fef3c7",
          border: "1px solid #fcd34d",
          borderRadius: "8px",
          padding: "12px 16px",
          color: "#92400e",
          display: "flex",
          alignItems: "center",
          gap: "10px",
          fontSize: "0.85rem",
        }}
      >
        <ShieldAlert size={20} />
        <span>
          LƯU Ý BẢO MẬT: noVNC chỉ dùng để thiết lập đăng nhập ban đầu hoặc xử lý checkpoint. Các tác vụ nhắn tin thường ngày vui lòng thao tác qua Hộp thư để hệ thống duy trì khóa Single-Sender và ghi nhật ký đầy đủ.
        </span>
      </div>

      <div
        style={{
          flex: 1,
          backgroundColor: "#0f172a",
          borderRadius: "8px",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          minHeight: "550px",
          boxShadow: "0 2px 4px rgba(0,0,0,0.1)",
        }}
      >
        <iframe
          src={noVncUrl}
          title="noVNC Browser Session"
          style={{
            width: "100%",
            height: "100%",
            border: "none",
            flex: 1,
          }}
        />
      </div>
    </div>
  );
};
