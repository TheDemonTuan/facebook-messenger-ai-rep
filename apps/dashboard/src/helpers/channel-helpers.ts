import type { ChannelOverview } from "../types";

export interface DerivedChannelDisplay {
  /** The effective display status */
  status: "RUNNING" | "PAUSED" | "SUSPENDED" | "DEGRADED" | "ERROR";
  /** Human-friendly label in Vietnamese */
  label: string;
  /** Status indicator color (green, amber, red, or slate) */
  color: string;
  /** Operational health description */
  healthNote?: string;
  /** Whether the channel intake is actively paused */
  isPaused: boolean;
  /** Whether operational health is healthy */
  isOperationalHealthy: boolean;
}

/**
 * Derives display channel status by cleanly separating operational health
 * (RUNNING, DEGRADED, SUSPENDED, ERROR) from administrative intake pause (isPaused).
 *
 * Prevents UI contradictions where a healthy-but-paused channel displays "RUNNING" / "Đang hoạt động"
 * alongside a "Tiếp tục" (Resume) button after container restarts or page reloads.
 */
export function getDerivedChannelStatus(
  overview?: Pick<ChannelOverview, "channelStatus" | "channelIsPaused" | "channelIsSuspended" | "channelStatusReason"> | null
): DerivedChannelDisplay {
  if (!overview) {
    return {
      status: "RUNNING",
      label: "Chưa xác định",
      color: "#64748b",
      isPaused: false,
      isOperationalHealthy: false,
    };
  }

  const isPaused = Boolean(overview.channelIsPaused || overview.channelStatus === "PAUSED");
  const isSuspended = Boolean(overview.channelIsSuspended || overview.channelStatus === "SUSPENDED");
  const isDegraded = overview.channelStatus === "DEGRADED";
  const isError = overview.channelStatus === "ERROR";

  if (isSuspended) {
    return {
      status: "SUSPENDED",
      label: "Tạm khóa",
      color: "#ef4444",
      healthNote: overview.channelStatusReason || "Kênh đang tạm khóa do sự cố",
      isPaused,
      isOperationalHealthy: false,
    };
  }

  if (isDegraded) {
    return {
      status: "DEGRADED",
      label: "Chập chờn",
      color: "#ef4444",
      healthNote: overview.channelStatusReason || "Kết nối Messenger chập chờn",
      isPaused,
      isOperationalHealthy: false,
    };
  }

  if (isError) {
    return {
      status: "ERROR",
      label: "Gặp sự cố",
      color: "#ef4444",
      healthNote: overview.channelStatusReason || "Gặp sự cố kết nối",
      isPaused,
      isOperationalHealthy: false,
    };
  }

  if (isPaused) {
    return {
      status: "PAUSED",
      label: "Tạm dừng",
      color: "#f59e0b",
      healthNote: "Kết nối Messenger ổn định",
      isPaused: true,
      isOperationalHealthy: true,
    };
  }

  return {
    status: "RUNNING",
    label: "Đang hoạt động",
    color: "#10b981",
    healthNote: "Kết nối Messenger ổn định",
    isPaused: false,
    isOperationalHealthy: true,
  };
}
