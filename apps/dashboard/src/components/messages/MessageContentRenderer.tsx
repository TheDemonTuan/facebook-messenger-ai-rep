import React, { useEffect, useState } from "react";
import type { MessagePart, ContentStatus, MediaRef } from "../../types";
import {
  getSafeHref,
  getSafeExternalHref,
  getSafeMediaSrc,
} from "../../helpers/url-helpers";
import {
  Image as ImageIcon,
  Mic,
  Video as VideoIcon,
  FileText,
  Share2,
  Smile,
  MapPin,
  User as UserIcon,
  HelpCircle,
  AlertTriangle,
  AlertCircle,
  Loader2,
  ExternalLink,
  Download,
} from "lucide-react";

export interface MessageContentRendererProps {
  parts?: MessagePart[] | null;
  text?: string | null;
  contentStatus?: ContentStatus | string;
  isOutbound?: boolean;
  compact?: boolean;
}

function formatByteSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(durationMs?: number): string {
  if (!durationMs || durationMs <= 0) return "";
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

const ImageCard: React.FC<{
  media: MediaRef;
  altText?: string;
  compact?: boolean;
}> = ({ media, altText, compact }) => {
  const [loadFailed, setLoadFailed] = useState(false);
  const rawImageUrl = media.sourceUrl || media.thumbnailRef;
  const imageUrl = getSafeMediaSrc(rawImageUrl);
  const status = media.status || "READY";

  useEffect(() => {
    setLoadFailed(false);
  }, [imageUrl]);

  if (status === "PENDING") {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          padding: "10px 14px",
          backgroundColor: "#f8fafc",
          border: "1px dashed #cbd5e1",
          borderRadius: "8px",
          color: "#64748b",
          fontSize: "0.8rem",
        }}
      >
        <Loader2 size={16} className="animate-spin" />
        <span>Đang tải hình ảnh (PENDING)...</span>
      </div>
    );
  }

  if (status === "UNAVAILABLE") {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          padding: "8px 12px",
          backgroundColor: "#fef2f2",
          border: "1px solid #fecaca",
          borderRadius: "8px",
          color: "#991b1b",
          fontSize: "0.8rem",
        }}
      >
        <AlertTriangle size={15} color="#dc2626" />
        <span>Hình ảnh không khả dụng (UNAVAILABLE)</span>
      </div>
    );
  }

  if (status === "UNSUPPORTED") {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          padding: "8px 12px",
          backgroundColor: "#fffbeb",
          border: "1px solid #fde68a",
          borderRadius: "8px",
          color: "#92400e",
          fontSize: "0.8rem",
        }}
      >
        <AlertCircle size={15} color="#d97706" />
        <span>Định dạng hình ảnh chưa hỗ trợ (UNSUPPORTED)</span>
      </div>
    );
  }

  const safeSourceUrl = getSafeExternalHref(media.sourceUrl);

  if (loadFailed || !imageUrl) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          padding: "8px 12px",
          backgroundColor: "#f1f5f9",
          border: "1px solid #e2e8f0",
          borderRadius: "8px",
          color: "#64748b",
          fontSize: "0.8rem",
        }}
      >
        <ImageIcon size={16} />
        <span>Không thể tải hình ảnh{media.fileName ? `: ${media.fileName}` : ""}</span>
      </div>
    );
  }

  return (
    <div style={{ position: "relative", display: "inline-block", maxWidth: "100%" }}>
      <img
        src={imageUrl}
        alt={altText || media.fileName || "Hình ảnh đính kèm"}
        loading="lazy"
        onError={() => setLoadFailed(true)}
        style={{
          maxWidth: compact ? "160px" : "280px",
          maxHeight: compact ? "160px" : "280px",
          width: "auto",
          height: "auto",
          borderRadius: "8px",
          objectFit: "cover",
          display: "block",
          border: "1px solid rgba(0,0,0,0.1)",
        }}
      />
      {safeSourceUrl && (
        <a
          href={safeSourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          title="Xem ảnh gốc"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "4px",
            marginTop: "4px",
            fontSize: "0.72rem",
            color: "#2563eb",
            textDecoration: "none",
          }}
        >
          <ExternalLink size={12} /> Xem ảnh gốc
        </a>
      )}
    </div>
  );
};

const VoiceAudioCard: React.FC<{
  type: "VOICE" | "AUDIO";
  media: MediaRef;
  transcriptRef?: string;
  durationMs?: number;
}> = ({ type, media, transcriptRef, durationMs }) => {
  const [loadFailed, setLoadFailed] = useState(false);
  const status = media.status || "READY";
  const durationText = formatDuration(durationMs || media.durationMs);

  if (status === "PENDING") {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          padding: "10px 14px",
          backgroundColor: "#f8fafc",
          border: "1px dashed #cbd5e1",
          borderRadius: "8px",
          color: "#64748b",
          fontSize: "0.8rem",
        }}
      >
        <Loader2 size={16} className="animate-spin" />
        <span>Đang xử lý âm thanh (PENDING)...</span>
      </div>
    );
  }

  if (status === "UNAVAILABLE") {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          padding: "8px 12px",
          backgroundColor: "#fef2f2",
          border: "1px solid #fecaca",
          borderRadius: "8px",
          color: "#991b1b",
          fontSize: "0.8rem",
        }}
      >
        <AlertTriangle size={15} color="#dc2626" />
        <span>Tin nhắn âm thanh không khả dụng (UNAVAILABLE)</span>
      </div>
    );
  }

  if (status === "UNSUPPORTED") {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          padding: "8px 12px",
          backgroundColor: "#fffbeb",
          border: "1px solid #fde68a",
          borderRadius: "8px",
          color: "#92400e",
          fontSize: "0.8rem",
        }}
      >
        <AlertCircle size={15} color="#d97706" />
        <span>Định dạng âm thanh chưa hỗ trợ (UNSUPPORTED)</span>
      </div>
    );
  }

  const safeAudioSrc = getSafeMediaSrc(media.sourceUrl);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "6px",
        padding: "10px 12px",
        backgroundColor: "#f8fafc",
        border: "1px solid #e2e8f0",
        borderRadius: "8px",
        minWidth: "240px",
        maxWidth: "320px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: "0.75rem", color: "#475569" }}>
        <span style={{ display: "flex", alignItems: "center", gap: "5px", fontWeight: "600" }}>
          <Mic size={14} color="#2563eb" />
          {type === "VOICE" ? "Tin nhắn thoại" : "Tệp âm thanh"}
        </span>
        {durationText && <span>{durationText}</span>}
      </div>

      {safeAudioSrc && !loadFailed ? (
        <audio
          controls
          preload="none"
          autoPlay={false}
          src={safeAudioSrc}
          onError={() => setLoadFailed(true)}
          style={{ width: "100%", height: "36px" }}
        />
      ) : (
        <div style={{ fontSize: "0.75rem", color: "#94a3b8", fontStyle: "italic" }}>
          {loadFailed ? "Không thể tải luồng phát âm thanh" : "Chưa có liên kết phát trực tiếp"}
        </div>
      )}

      {/* Transcript state */}
      <div style={{ fontSize: "0.72rem", color: "#64748b", marginTop: "2px", borderTop: "1px solid #e2e8f0", paddingTop: "4px" }}>
        {transcriptRef ? (
          <span style={{ color: "#166534" }}>
            ✓ Bản ghi âm: <span style={{ fontFamily: "monospace" }}>{transcriptRef}</span>
          </span>
        ) : (
          <span style={{ color: "#94a3b8" }}>Chưa có bản ghi âm văn bản (transcript)</span>
        )}
      </div>
    </div>
  );
};

const VideoCard: React.FC<{
  media: MediaRef;
  posterRef?: string;
  durationMs?: number;
}> = ({ media, posterRef, durationMs }) => {
  const [loadFailed, setLoadFailed] = useState(false);
  const status = media.status || "READY";
  const durationText = formatDuration(durationMs || media.durationMs);

  if (status === "PENDING") {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          padding: "10px 14px",
          backgroundColor: "#f8fafc",
          border: "1px dashed #cbd5e1",
          borderRadius: "8px",
          color: "#64748b",
          fontSize: "0.8rem",
        }}
      >
        <Loader2 size={16} className="animate-spin" />
        <span>Đang xử lý video (PENDING)...</span>
      </div>
    );
  }

  if (status === "UNAVAILABLE") {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          padding: "8px 12px",
          backgroundColor: "#fef2f2",
          border: "1px solid #fecaca",
          borderRadius: "8px",
          color: "#991b1b",
          fontSize: "0.8rem",
        }}
      >
        <AlertTriangle size={15} color="#dc2626" />
        <span>Video không khả dụng (UNAVAILABLE)</span>
      </div>
    );
  }

  if (status === "UNSUPPORTED") {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          padding: "8px 12px",
          backgroundColor: "#fffbeb",
          border: "1px solid #fde68a",
          borderRadius: "8px",
          color: "#92400e",
          fontSize: "0.8rem",
        }}
      >
        <AlertCircle size={15} color="#d97706" />
        <span>Định dạng video chưa hỗ trợ (UNSUPPORTED)</span>
      </div>
    );
  }

  const safeVideoSrc = getSafeMediaSrc(media.sourceUrl);
  const safePosterSrc = getSafeMediaSrc(posterRef);

  if (loadFailed || !safeVideoSrc) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          padding: "10px 12px",
          backgroundColor: "#f1f5f9",
          border: "1px solid #e2e8f0",
          borderRadius: "8px",
          color: "#64748b",
          fontSize: "0.8rem",
        }}
      >
        <VideoIcon size={16} />
        <span>Video ({durationText || "đính kèm"}) - URL hết hạn hoặc không khả dụng</span>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: "320px" }}>
      <video
        controls
        preload="metadata"
        autoPlay={false}
        poster={safePosterSrc || undefined}
        src={safeVideoSrc}
        onError={() => setLoadFailed(true)}
        style={{
          width: "100%",
          maxHeight: "240px",
          borderRadius: "8px",
          backgroundColor: "#000000",
          display: "block",
        }}
      />
      {durationText && (
        <div style={{ fontSize: "0.72rem", color: "#64748b", marginTop: "2px" }}>
          Thời lượng: {durationText}
        </div>
      )}
    </div>
  );
};

const ShareCard: React.FC<{
  origin?: string;
  url?: string;
  title?: string;
  previewText?: string;
  previewMedia?: MediaRef;
  access?: string;
}> = ({ origin, url, title, previewText, previewMedia, access }) => {
  const originLabels: Record<string, string> = {
    FACEBOOK_GROUP: "Nhóm Facebook",
    FACEBOOK_POST: "Bài viết Facebook",
    REEL: "Facebook Reel",
    EXTERNAL: "Liên kết ngoài",
    UNKNOWN: "Nội dung chia sẻ",
  };

  const originText = originLabels[origin || "UNKNOWN"] || origin || "Chia sẻ";
  const safePreviewImg = getSafeMediaSrc(previewMedia?.sourceUrl);
  const safeShareUrl = getSafeExternalHref(url);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "6px",
        padding: "10px 12px",
        backgroundColor: "#ffffff",
        border: "1px solid #cbd5e1",
        borderRadius: "8px",
        maxWidth: "320px",
        boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "6px" }}>
        <span style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "0.72rem", fontWeight: "700", color: "#2563eb" }}>
          <Share2 size={13} /> {originText}
        </span>
        {access && access !== "UNKNOWN" && (
          <span
            style={{
              fontSize: "0.68rem",
              padding: "1px 5px",
              borderRadius: "4px",
              backgroundColor: access === "UNAVAILABLE" ? "#fef2f2" : "#f1f5f9",
              color: access === "UNAVAILABLE" ? "#dc2626" : "#475569",
              fontWeight: "600",
            }}
          >
            {access === "PREVIEW_ONLY" ? "Chỉ xem trước" : access === "READABLE" ? "Công khai" : "Không khả dụng"}
          </span>
        )}
      </div>

      {safePreviewImg && (
        <img
          src={safePreviewImg}
          alt=""
          loading="lazy"
          style={{ width: "100%", maxHeight: "140px", objectFit: "cover", borderRadius: "4px" }}
        />
      )}

      {title && (
        <div style={{ fontWeight: "600", fontSize: "0.85rem", color: "#0f172a", lineHeight: "1.3" }}>
          {title}
        </div>
      )}

      {previewText && (
        <div style={{ fontSize: "0.78rem", color: "#475569", lineHeight: "1.35", maxHeight: "60px", overflow: "hidden" }}>
          {previewText}
        </div>
      )}

      {safeShareUrl && (
        <a
          href={safeShareUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "4px",
            fontSize: "0.74rem",
            color: "#2563eb",
            textDecoration: "none",
            marginTop: "2px",
          }}
        >
          <ExternalLink size={12} /> Mở liên kết
        </a>
      )}
    </div>
  );
};

const FileCard: React.FC<{
  media: MediaRef;
  fileName?: string;
  byteSize?: number;
}> = ({ media, fileName, byteSize }) => {
  const name = fileName || media.fileName || "Tập tin đính kèm";
  const sizeText = formatByteSize(byteSize || media.byteSize);
  const safeDownloadUrl = getSafeHref(media.sourceUrl, { allowBlob: false, allowInternalApi: true });

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "10px",
        padding: "8px 12px",
        backgroundColor: "#f8fafc",
        border: "1px solid #e2e8f0",
        borderRadius: "8px",
        minWidth: "220px",
        maxWidth: "320px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "8px", overflow: "hidden" }}>
        <FileText size={20} color="#2563eb" style={{ flexShrink: 0 }} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: "0.8rem", fontWeight: "600", color: "#1e293b", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {name}
          </div>
          {sizeText && <div style={{ fontSize: "0.72rem", color: "#64748b" }}>{sizeText}</div>}
        </div>
      </div>

      {safeDownloadUrl && (
        <a
          href={safeDownloadUrl}
          target="_blank"
          rel="noopener noreferrer"
          download={name}
          title="Tải tập tin"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: "28px",
            height: "28px",
            borderRadius: "4px",
            backgroundColor: "#ffffff",
            border: "1px solid #cbd5e1",
            color: "#475569",
            textDecoration: "none",
            flexShrink: 0,
          }}
        >
          <Download size={14} />
        </a>
      )}
    </div>
  );
};

const StickerCard: React.FC<{
  label?: string;
  media?: MediaRef;
}> = ({ label, media }) => {
  const safeStickerSrc = getSafeMediaSrc(media?.sourceUrl);
  if (safeStickerSrc) {
    return (
      <img
        src={safeStickerSrc}
        alt={label || "Nhãn dán"}
        loading="lazy"
        style={{ width: "96px", height: "96px", objectFit: "contain" }}
      />
    );
  }
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        padding: "6px 12px",
        backgroundColor: "#fef3c7",
        border: "1px solid #fde68a",
        borderRadius: "14px",
        color: "#92400e",
        fontSize: "0.8rem",
        fontWeight: "500",
      }}
    >
      <Smile size={16} />
      <span>Nhãn dán: {label || "Sticker"}</span>
    </div>
  );
};

const GifCard: React.FC<{
  media: MediaRef;
}> = ({ media }) => {
  const safeGifSrc = getSafeMediaSrc(media?.sourceUrl);
  if (safeGifSrc) {
    return (
      <div style={{ position: "relative", display: "inline-block" }}>
        <img
          src={safeGifSrc}
          alt="GIF"
          loading="lazy"
          style={{ maxWidth: "240px", maxHeight: "200px", borderRadius: "8px", display: "block" }}
        />
        <span
          style={{
            position: "absolute",
            bottom: "6px",
            right: "6px",
            backgroundColor: "rgba(0,0,0,0.65)",
            color: "#ffffff",
            fontSize: "0.65rem",
            fontWeight: "700",
            padding: "1px 4px",
            borderRadius: "3px",
          }}
        >
          GIF
        </span>
      </div>
    );
  }
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        padding: "6px 10px",
        backgroundColor: "#f1f5f9",
        border: "1px solid #cbd5e1",
        borderRadius: "6px",
        fontSize: "0.8rem",
        color: "#475569",
      }}
    >
      <span>[GIF Animation]</span>
    </div>
  );
};

const LocationCard: React.FC<{
  label?: string;
  latitude?: number;
  longitude?: number;
}> = ({ label, latitude, longitude }) => {
  const hasCoords = typeof latitude === "number" && typeof longitude === "number";
  const rawMapsUrl = hasCoords ? `https://www.google.com/maps?q=${latitude},${longitude}` : undefined;
  const safeMapsUrl = getSafeExternalHref(rawMapsUrl);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "4px",
        padding: "8px 12px",
        backgroundColor: "#f0fdf4",
        border: "1px solid #bbf7d0",
        borderRadius: "8px",
        maxWidth: "280px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "6px", color: "#166534", fontWeight: "600", fontSize: "0.82rem" }}>
        <MapPin size={15} />
        <span>{label || "Vị trí chia sẻ"}</span>
      </div>
      {hasCoords && (
        <div style={{ fontSize: "0.72rem", color: "#15803d" }}>
          Tọa độ: {latitude?.toFixed(4)}, {longitude?.toFixed(4)}
        </div>
      )}
      {safeMapsUrl && (
        <a
          href={safeMapsUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "4px",
            fontSize: "0.72rem",
            color: "#166534",
            textDecoration: "underline",
            marginTop: "2px",
          }}
        >
          <ExternalLink size={11} /> Mở bản đồ Google Maps
        </a>
      )}
    </div>
  );
};

const ContactCard: React.FC<{
  displayName?: string;
  normalizedFields?: Record<string, string>;
}> = ({ displayName, normalizedFields }) => {
  const entries = normalizedFields ? Object.entries(normalizedFields) : [];

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "4px",
        padding: "8px 12px",
        backgroundColor: "#eff6ff",
        border: "1px solid #bfdbfe",
        borderRadius: "8px",
        maxWidth: "280px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "6px", color: "#1e40af", fontWeight: "600", fontSize: "0.82rem" }}>
        <UserIcon size={15} />
        <span>Danh thiếp: {displayName || "Liên hệ"}</span>
      </div>
      {entries.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "2px", fontSize: "0.72rem", color: "#1d4ed8" }}>
          {entries.map(([key, value]) => (
            <div key={key}>
              <strong>{key}:</strong> {value}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

const UnknownCard: React.FC<{
  observedLabel?: string;
}> = ({ observedLabel }) => (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      gap: "6px",
      padding: "6px 10px",
      backgroundColor: "#fffbeb",
      border: "1px solid #fde68a",
      borderRadius: "6px",
      color: "#92400e",
      fontSize: "0.78rem",
    }}
  >
    <HelpCircle size={14} />
    <span>Nội dung chưa hỗ trợ: {observedLabel || "Khối tin nhắn đặc biệt"}</span>
  </div>
);

export const MessageContentRenderer: React.FC<MessageContentRendererProps> = ({
  parts,
  text,
  contentStatus,
  isOutbound,
  compact,
}) => {
  const status = contentStatus || "READY";

  const hasParts = Array.isArray(parts) && parts.length > 0;
  const rawText = text?.trim() || "";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px", maxWidth: "100%" }}>
      {/* Message-level status banner if not READY */}
      {status === "PENDING" && (
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            padding: "4px 8px",
            borderRadius: "4px",
            backgroundColor: isOutbound ? "rgba(255,255,255,0.2)" : "#fffbeb",
            color: isOutbound ? "#ffffff" : "#b45309",
            fontSize: "0.72rem",
            fontWeight: "600",
          }}
        >
          <Loader2 size={12} className="animate-spin" />
          <span>Đang xử lý nội dung (PENDING)</span>
        </div>
      )}

      {status === "UNAVAILABLE" && (
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            padding: "4px 8px",
            borderRadius: "4px",
            backgroundColor: isOutbound ? "rgba(255,255,255,0.2)" : "#fef2f2",
            color: isOutbound ? "#ffffff" : "#b91c1c",
            fontSize: "0.72rem",
            fontWeight: "600",
          }}
        >
          <AlertTriangle size={12} />
          <span>Nội dung không khả dụng (UNAVAILABLE)</span>
        </div>
      )}

      {status === "UNSUPPORTED" && (
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            padding: "4px 8px",
            borderRadius: "4px",
            backgroundColor: isOutbound ? "rgba(255,255,255,0.2)" : "#fffbeb",
            color: isOutbound ? "#ffffff" : "#b45309",
            fontSize: "0.72rem",
            fontWeight: "600",
          }}
        >
          <AlertCircle size={12} />
          <span>Nội dung chưa hỗ trợ (UNSUPPORTED)</span>
        </div>
      )}

      {status === "QUARANTINED" && (
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            padding: "4px 8px",
            borderRadius: "4px",
            backgroundColor: "#fef2f2",
            color: "#991b1b",
            fontSize: "0.72rem",
            fontWeight: "600",
          }}
        >
          <AlertTriangle size={12} />
          <span>Nội dung bị cách ly (QUARANTINED)</span>
        </div>
      )}

      {/* Render Parts */}
      {hasParts ? (
        parts.map((part, index) => {
          switch (part.type) {
            case "TEXT":
              return (
                <div
                  key={index}
                  style={{
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    lineHeight: 1.45,
                  }}
                >
                  {part.text}
                </div>
              );
            case "IMAGE":
              return <ImageCard key={index} media={part.media} altText={part.altText} compact={compact} />;
            case "VOICE":
              return (
                <VoiceAudioCard
                  key={index}
                  type="VOICE"
                  media={part.media}
                  transcriptRef={part.transcriptRef}
                  durationMs={part.durationMs}
                />
              );
            case "AUDIO":
              return (
                <VoiceAudioCard
                  key={index}
                  type="AUDIO"
                  media={part.media}
                  transcriptRef={part.transcriptRef}
                  durationMs={part.durationMs}
                />
              );
            case "VIDEO":
              return (
                <VideoCard
                  key={index}
                  media={part.media}
                  posterRef={part.posterRef}
                  durationMs={part.durationMs}
                />
              );
            case "SHARE":
              return (
                <ShareCard
                  key={index}
                  origin={part.origin}
                  url={part.url}
                  title={part.title}
                  previewText={part.previewText}
                  previewMedia={part.previewMedia}
                  access={part.access}
                />
              );
            case "FILE":
              return (
                <FileCard
                  key={index}
                  media={part.media}
                  fileName={part.fileName}
                  byteSize={part.byteSize}
                />
              );
            case "STICKER":
              return <StickerCard key={index} label={part.label} media={part.media} />;
            case "GIF":
              return <GifCard key={index} media={part.media} />;
            case "LOCATION":
              return (
                <LocationCard
                  key={index}
                  label={part.label}
                  latitude={part.latitude}
                  longitude={part.longitude}
                />
              );
            case "CONTACT":
              return (
                <ContactCard
                  key={index}
                  displayName={part.displayName}
                  normalizedFields={part.normalizedFields}
                />
              );
            case "UNKNOWN":
              return <UnknownCard key={index} observedLabel={part.observedLabel} />;
            default:
              return null;
          }
        })
      ) : rawText ? (
        <div
          style={{
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            lineHeight: 1.45,
          }}
        >
          {rawText}
        </div>
      ) : (
        <div style={{ fontStyle: "italic", opacity: 0.7, fontSize: "0.82rem" }}>
          [Tin nhắn không có nội dung văn bản]
        </div>
      )}
    </div>
  );
};
