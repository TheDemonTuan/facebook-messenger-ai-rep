import type { IncidentItem } from "../types";

export type IncidentCategory = "SEND_UNCERTAIN" | "CHECKPOINT" | "DOM_DEGRADED" | "GENERIC";

export interface IncidentResolutionActions {
  category: IncidentCategory;
  canBlindRetry: false; // Safety invariant: blind retry is NEVER permitted
  allowedActions: Array<"MARK_SENT" | "CONFIRM_RETRY" | "OPEN_CONSOLE" | "RESUME_CHANNEL" | "RESOLVE">;
  warningMessage: string;
}

export function isSendUncertain(incident: IncidentItem): boolean {
  return (
    incident.type === "SEND_UNCERTAIN" ||
    incident.title?.includes("SEND_UNCERTAIN") ||
    incident.metadata?.error === "Verification timed out post-Enter"
  );
}

export function isCheckpoint(incident: IncidentItem): boolean {
  return incident.type === "CHECKPOINT" || incident.title?.toLowerCase().includes("checkpoint");
}

export function isDomDegraded(incident: IncidentItem): boolean {
  return (
    incident.type === "DOM_CHANGED" ||
    incident.type === "DOM_DEGRADED" ||
    incident.title?.toLowerCase().includes("dom degraded") ||
    incident.title?.toLowerCase().includes("dom changed")
  );
}

/**
 * Evaluates incident safety constraints.
 * Core invariant: blind retry is strictly prohibited for SEND_UNCERTAIN, CHECKPOINT, and DOM_DEGRADED.
 */
export function getIncidentSafetyPolicy(incident: IncidentItem): IncidentResolutionActions {
  if (isSendUncertain(incident)) {
    return {
      category: "SEND_UNCERTAIN",
      canBlindRetry: false,
      allowedActions: ["MARK_SENT", "CONFIRM_RETRY", "RESOLVE"],
      warningMessage:
        "CẢNH BÁO: Tin nhắn chưa được xác nhận sau khi bấm phím Enter. Không tự động thử lại (No blind retry) để tránh khách hàng nhận 2 tin nhắn trùng lặp. Vui lòng đối soát hội thoại trước khi quyết định.",
    };
  }

  if (isCheckpoint(incident)) {
    return {
      category: "CHECKPOINT",
      canBlindRetry: false,
      allowedActions: ["OPEN_CONSOLE", "RESUME_CHANNEL", "RESOLVE"],
      warningMessage:
        "CẢNH BÁO BẢO MẬT: Facebook yêu cầu xác thực bảo mật (Checkpoint/CAPTCHA). Tuyệt đối không retry tự động. Cần mở noVNC Console để đăng nhập/xác minh trước khi khôi phục kênh.",
    };
  }

  if (isDomDegraded(incident)) {
    return {
      category: "DOM_DEGRADED",
      canBlindRetry: false,
      allowedActions: ["OPEN_CONSOLE", "RESUME_CHANNEL", "RESOLVE"],
      warningMessage:
        "CẢNH BÁO HỆ THỐNG: Cấu trúc giao diện Facebook Messenger thay đổi hoặc không tìm thấy bộ chọn tin nhắn ổn định. Không thử lại vô điều kiện; kiểm tra phiên trình duyệt hoặc cập nhật selector.",
    };
  }

  return {
    category: "GENERIC",
    canBlindRetry: false,
    allowedActions: ["RESOLVE"],
    warningMessage: "Sự cố hệ thống yêu cầu nhân viên vận hành xác nhận và xử lý.",
  };
}
