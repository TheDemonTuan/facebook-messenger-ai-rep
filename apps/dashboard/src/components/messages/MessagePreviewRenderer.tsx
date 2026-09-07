import React from "react";
import type { MessagePart, ContentStatus } from "../../types";
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
  Loader2,
  AlertTriangle,
} from "lucide-react";

export interface MessagePreviewRendererProps {
  message?: {
    text?: string | null;
    parts?: MessagePart[] | null;
    contentStatus?: ContentStatus | string;
    actor?: string;
    eventKind?: string;
  } | null;
  maxLength?: number;
}

export function getMessagePreviewSummary(message?: {
  text?: string | null;
  parts?: MessagePart[] | null;
  contentStatus?: ContentStatus | string;
  eventKind?: string;
} | null): { icon: React.ReactNode; text: string } {
  if (!message) {
    return { icon: null, text: "Chưa có tin nhắn" };
  }

  const { parts, text, contentStatus, eventKind } = message;

  if (eventKind === "MESSAGE_UNSENT") {
    return {
      icon: <AlertTriangle size={13} color="#94a3b8" />,
      text: "[Tin nhắn đã bị thu hồi]",
    };
  }

  if (contentStatus === "PENDING") {
    return {
      icon: <Loader2 size={13} className="animate-spin" />,
      text: "[Đang tải nội dung...]",
    };
  }

  if (contentStatus === "UNAVAILABLE") {
    return {
      icon: <AlertTriangle size={13} color="#dc2626" />,
      text: "[Nội dung không khả dụng]",
    };
  }

  if (contentStatus === "UNSUPPORTED") {
    return {
      icon: <HelpCircle size={13} color="#d97706" />,
      text: "[Nội dung chưa hỗ trợ]",
    };
  }

  if (Array.isArray(parts) && parts.length > 0) {
    const nonTextPart = parts.find((p) => p.type !== "TEXT");
    const textPart = parts.find((p) => p.type === "TEXT") as { text: string } | undefined;
    const resolvedText = text?.trim() || textPart?.text.trim() || "";

    if (nonTextPart) {
      switch (nonTextPart.type) {
        case "IMAGE":
          return {
            icon: <ImageIcon size={13} color="#2563eb" />,
            text: resolvedText ? `[Hình ảnh] ${resolvedText}` : "[Hình ảnh]",
          };
        case "VOICE":
        case "AUDIO":
          return {
            icon: <Mic size={13} color="#2563eb" />,
            text: resolvedText ? `[Tin nhắn thoại] ${resolvedText}` : "[Tin nhắn thoại]",
          };
        case "VIDEO":
          return {
            icon: <VideoIcon size={13} color="#2563eb" />,
            text: resolvedText ? `[Video] ${resolvedText}` : "[Video]",
          };
        case "SHARE":
          return {
            icon: <Share2 size={13} color="#2563eb" />,
            text: nonTextPart.title ? `[Chia sẻ: ${nonTextPart.title}]` : "[Nội dung chia sẻ]",
          };
        case "FILE":
          return {
            icon: <FileText size={13} color="#2563eb" />,
            text: nonTextPart.fileName ? `[Tập tin: ${nonTextPart.fileName}]` : "[Tập tin đính kèm]",
          };
        case "STICKER":
          return {
            icon: <Smile size={13} color="#d97706" />,
            text: nonTextPart.label ? `[Nhãn dán: ${nonTextPart.label}]` : "[Nhãn dán]",
          };
        case "GIF":
          return {
            icon: <ImageIcon size={13} color="#7c3aed" />,
            text: "[Ảnh động GIF]",
          };
        case "LOCATION":
          return {
            icon: <MapPin size={13} color="#16a34a" />,
            text: nonTextPart.label ? `[Vị trí: ${nonTextPart.label}]` : "[Vị trí chia sẻ]",
          };
        case "CONTACT":
          return {
            icon: <UserIcon size={13} color="#2563eb" />,
            text: nonTextPart.displayName ? `[Danh thiếp: ${nonTextPart.displayName}]` : "[Danh thiếp]",
          };
        case "UNKNOWN":
          return {
            icon: <HelpCircle size={13} color="#64748b" />,
            text: nonTextPart.observedLabel ? `[${nonTextPart.observedLabel}]` : "[Nội dung khác]",
          };
      }
    }

    if (resolvedText) {
      return { icon: null, text: resolvedText };
    }
  }

  const rawText = text?.trim() || "";
  if (rawText) {
    return { icon: null, text: rawText };
  }

  return { icon: null, text: "Chưa có tin nhắn" };
}

export const MessagePreviewRenderer: React.FC<MessagePreviewRendererProps> = ({
  message,
  maxLength = 120,
}) => {
  const { icon, text } = getMessagePreviewSummary(message);
  const truncated = text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;

  return (
    <span
      title={text}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "5px",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        maxWidth: "100%",
      }}
    >
      {icon && <span style={{ display: "inline-flex", flexShrink: 0 }}>{icon}</span>}
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {truncated}
      </span>
    </span>
  );
};
