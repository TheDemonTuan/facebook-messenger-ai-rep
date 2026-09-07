import type {
  ConversationDetailData,
  ConversationItem,
  MessageItem,
  AiRunItem,
  OutboundActionItem,
  SkipReasonInfo,
} from "../../types";

export type WorkflowStageId =
  | "inbound"
  | "policy"
  | "debounce"
  | "ai"
  | "typing"
  | "delivery";

export type StageState =
  | "done"
  | "active"
  | "waiting"
  | "warning"
  | "error"
  | "unknown"
  | "cancelled";

export interface WorkflowStage {
  id: WorkflowStageId;
  label: string;
  state: StageState;
  description: string;
  evidence: string;
}

export interface WorkflowViewData {
  conversationId: string;
  channelAccountId: string;
  version: number;
  current: boolean;
  versions: number[];
  stages: WorkflowStage[];
  title: string;
  tone: StageState;
  correlationKey: string;
  name: string;
  messages: MessageItem[];
  inbound: MessageItem[];
  manualOutbound: MessageItem[];
  runs: AiRunItem[];
  run: AiRunItem | null;
  actions: OutboundActionItem[];
  events: Array<{
    id: string;
    type: string;
    inboundVersion: number | null;
    actor: string;
    payload: Record<string, unknown>;
    createdAt: string;
  }>;
  policy: SkipReasonInfo | null;
  manifest: Record<string, unknown> | null;
  selectedCount: number | null;
  estimatedTokens: number | null;
  confirmedCount: number;
  expectedCount: number | null;
  hasUncertain: boolean;
  allExpectedConfirmed: boolean;
  limited: boolean;
}

export const stateLabels: Record<StageState, string> = {
  done: "Đã ghi nhận",
  active: "Đang xử lý",
  waiting: "Đang chờ",
  warning: "Cần kiểm tra",
  error: "Có lỗi",
  unknown: "Chưa có dữ liệu",
  cancelled: "Đã dừng",
};

import { eventLabels, eventLabel } from "../../helpers/event-helpers";
export { eventLabels, eventLabel };

export function timestamp(value: unknown): number | null {
  if (typeof value !== "string" && !(value instanceof Date)) return null;
  const n = new Date(value).getTime();
  return Number.isFinite(n) ? n : null;
}

export function formatTime(value: unknown, timeZone = "Asia/Ho_Chi_Minh"): string {
  const n = timestamp(value);
  if (n === null) return "Chưa có thời gian";
  try {
    return new Intl.DateTimeFormat("vi-VN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZone,
    }).format(n);
  } catch {
    return new Intl.DateTimeFormat("vi-VN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(n);
  }
}

export function shortStatus(status: string, manual = false): string {
  if (manual) return "Nhân viên hỗ trợ";
  const labels: Record<string, string> = {
    QUEUED: "Chờ đến lượt",
    CLAIMED: "Đang xử lý",
    DEBOUNCING: "Đang gom tin",
    READING: "Đang đọc tin",
    THINKING: "AI đang trả lời",
    DRAFT_READY: "Chờ soạn tin",
    TYPING: "Đang soạn tin",
    SENDING: "Đang xác nhận gửi",
    WAITING_CUSTOMER: "Chờ khách phản hồi",
    MANUAL: "Nhân viên hỗ trợ",
    BLOCKED: "Không tự động trả lời",
    ERROR: "Cần kiểm tra",
  };
  return labels[status] || "Chưa rõ trạng thái";
}

export function itemNeedsAttention(item: ConversationItem): boolean {
  return item.conversation.status === "ERROR" || item.conversation.isBlocked;
}

export function itemIsActive(item: ConversationItem): boolean {
  return (
    !item.conversation.manualMode &&
    [
      "QUEUED",
      "CLAIMED",
      "DEBOUNCING",
      "READING",
      "THINKING",
      "DRAFT_READY",
      "TYPING",
      "SENDING",
    ].includes(item.conversation.status)
  );
}

export function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

export function safeObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const confirmedStatuses = new Set(["CONFIRMED", "SENT"]);
const uncertainStatuses = new Set(["SEND_UNCERTAIN", "UNCONFIRMED"]);
const stoppedStatuses = new Set(["CANCELLED", "ABORTED"]);

/**
 * Compatibility projection over existing, bounded conversation-detail API.
 * NEVER combine channel-wide "latest" records; NEVER infer that AI success means delivery.
 * This is not a complete distributed trace. Missing evidence stays visibly unknown.
 */
export function buildWorkflowView(
  data: ConversationDetailData,
  requestedVersion?: number
): WorkflowViewData {
  const conv = data.conversation;
  const version = requestedVersion ?? conv.inboundVersion;
  const current = version === conv.inboundVersion;

  const events = (data.events || [])
    .filter((e) => e.inboundVersion === version)
    .sort((a, b) => (timestamp(a.createdAt) ?? 0) - (timestamp(b.createdAt) ?? 0));

  const messages = (data.messages || [])
    .filter((m) => m.inboundVersion === version)
    .sort((a, b) => (timestamp(a.timestamp) ?? 0) - (timestamp(b.timestamp) ?? 0));

  const runs = (data.aiRuns || [])
    .filter(
      (r) =>
        r.conversationId === conv.id &&
        (!r.channelAccountId || r.channelAccountId === conv.channelAccountId) &&
        r.inboundVersion === version
    )
    .sort((a, b) => (timestamp(b.createdAt) ?? 0) - (timestamp(a.createdAt) ?? 0));

  const actions = (data.outboundActions || [])
    .filter((a) => a.inboundVersion === version)
    .sort((a, b) => a.responseIndex - b.responseIndex);

  const run = runs[0] || null;
  const inbound = messages.filter((m) => m.direction === "INBOUND");
  const manualOutbound = messages.filter(
    (m) => m.direction === "OUTBOUND" && m.actor === "MANUAL_OWNER"
  );
  const has = (type: string) => events.some((e) => e.type === type);
  const workerStarted = events.some(
    (e) => e.type === "AI_STARTED" && e.actor === "AI_WORKER"
  );
  const policy = inbound.find((m) => m.skipReason)?.skipReason ?? null;

  const requestSnap = safeObject(run?.requestSnapshot);
  const manifest = safeObject(requestSnap?.contextManifest);

  const expectedCount =
    run?.usedResult?.messages?.length ??
    numberField(run?.parsedOutput?.messageCount) ??
    null;

  const confirmedCount = actions.filter((a) =>
    confirmedStatuses.has(String(a.status))
  ).length;

  const hasUncertain = actions.some((a) =>
    uncertainStatuses.has(String(a.status))
  );
  const hasFailed = actions.some((a) => String(a.status) === "FAILED");
  const sending = actions.some((a) =>
    ["SEND_INTENT", "SENDING"].includes(String(a.status))
  );
  const typing = actions.some((a) => String(a.status) === "TYPING");
  const allCancelled =
    actions.length > 0 &&
    actions.every((a) => stoppedStatuses.has(String(a.status)));

  const allExpectedConfirmed =
    expectedCount !== null &&
    expectedCount > 0 &&
    actions.length === expectedCount &&
    confirmedCount === expectedCount;

  const cancelled =
    has("AI_CANCELLED_STALE") ||
    allCancelled ||
    run?.status === "STALE_ABORTED";

  const eligibleToRun =
    current && !conv.manualMode && !conv.isBlocked && !cancelled;

  const stages: WorkflowStage[] = [
    {
      id: "inbound",
      label: "Nhận tin",
      state:
        inbound.length || has("INBOUND_RECEIVED") ? "done" : "unknown",
      description: "Nội dung khách gửi trong đúng lượt đang xem.",
      evidence: inbound.length
        ? `Đã tải ${inbound.length} tin của lượt này.`
        : "Chưa tải được nội dung của lượt này.",
    },
    {
      id: "policy",
      label: "Kiểm tra",
      state: policy ? (policy.eligible ? "done" : "warning") : "unknown",
      description: "Kiểm tra lượt này có được phép trả lời tự động hay không.",
      evidence:
        policy?.humanReadableReason ||
        "API hiện tại chưa cung cấp kết quả kiểm tra cho lượt này.",
    },
    {
      id: "debounce",
      label: "Gom tin",
      state:
        has("DEBOUNCE_STARTED") || has("DEBOUNCE_RESET")
          ? eligibleToRun && conv.status === "DEBOUNCING"
            ? "waiting"
            : workerStarted || run
            ? "done"
            : cancelled
            ? "cancelled"
            : "unknown"
          : "unknown",
      description: "Chờ ngắn để gom các tin khách gửi liên tiếp.",
      evidence:
        eligibleToRun && conv.status === "DEBOUNCING"
          ? "Hội thoại đang chờ khách nhắn thêm; chưa có hạn chờ chính xác từ API."
          : has("DEBOUNCE_STARTED")
          ? "Có sự kiện gom tin trong lượt này."
          : "Chưa có sự kiện gom tin trong dữ liệu đã tải.",
    },
    {
      id: "ai",
      label: "AI trả lời",
      state: cancelled
        ? "cancelled"
        : run
        ? run.status === "SUCCESS"
          ? "done"
          : "error"
        : eligibleToRun && conv.status === "THINKING"
        ? "active"
        : "unknown",
      description:
        "Chuẩn bị ngữ cảnh, gọi dịch vụ AI và kiểm tra câu trả lời.",
      evidence: run
        ? `Kết quả của lần gọi ${run.id.slice(0, 8)}: ${
            run.status === "SUCCESS" ? "đã tạo câu trả lời" : "cần kiểm tra"
          }.`
        : workerStarted
        ? "Đã có sự kiện bắt đầu; chưa nhận được kết quả AI."
        : "Chưa có kết quả AI cho lượt này.",
    },
    {
      id: "typing",
      label: "Soạn tin",
      state: cancelled
        ? "cancelled"
        : typing && eligibleToRun
        ? "active"
        : allExpectedConfirmed || hasUncertain || sending
        ? "done"
        : confirmedCount > 0 &&
          actions.some((a) => String(a.status) === "PENDING")
        ? "waiting"
        : has("TYPING_ABORTED")
        ? "cancelled"
        : "unknown",
      description: "Đưa câu trả lời đã duyệt vào ô soạn tin Messenger.",
      evidence:
        typing && eligibleToRun
          ? "Có thao tác soạn tin đang hoạt động."
          : actions.length
          ? `Có ${actions.length} thao tác gửi trong dữ liệu đã tải.`
          : "Chưa có thao tác soạn tin.",
    },
    {
      id: "delivery",
      label: "Xác nhận gửi",
      state: hasUncertain
        ? "warning"
        : hasFailed
        ? "error"
        : allExpectedConfirmed
        ? "done"
        : sending
        ? "active"
        : allCancelled
        ? "cancelled"
        : "unknown",
      description:
        "Chỉ xác nhận khi có bằng chứng gửi. Không đồng nghĩa khách đã đọc.",
      evidence: hasUncertain
        ? "Chưa chắc tin đã gửi. Không tự động gửi lại."
        : allExpectedConfirmed
        ? `Đã xác nhận ${confirmedCount}/${expectedCount} tin dự kiến.`
        : confirmedCount > 0
        ? `Đã xác nhận ${confirmedCount} tin; chưa đủ bằng chứng hoàn tất cả lượt.`
        : sending
        ? "Đã bắt đầu thao tác gửi; đang chờ xác nhận."
        : "Chưa có bằng chứng gửi thành công.",
    },
  ];

  let title = shortStatus(conv.status, conv.manualMode);
  let tone: StageState = "unknown";

  if (!current) {
    title = `Lượt trước #${version}`;
  }

  if (hasUncertain) {
    title = "Cần xác nhận kết quả gửi";
    tone = "warning";
  } else if (cancelled) {
    title = "Lượt này đã dừng";
    tone = "cancelled";
  } else if (
    hasFailed ||
    run?.status === "ERROR" ||
    run?.status === "GUARD_REJECTED"
  ) {
    title = "Có lỗi cần kiểm tra";
    tone = "error";
  } else if (allExpectedConfirmed) {
    title = "Đã xác nhận các tin của lượt này";
    tone = "done";
  } else if (
    confirmedCount > 0 &&
    expectedCount !== null &&
    confirmedCount < expectedCount
  ) {
    title = "Còn tin chưa xác nhận gửi";
    tone = "waiting";
  } else if (
    eligibleToRun &&
    ["THINKING", "TYPING", "SENDING", "DRAFT_READY", "READING"].includes(
      conv.status
    )
  ) {
    tone = "active";
  } else if (eligibleToRun && ["DEBOUNCING", "QUEUED"].includes(conv.status)) {
    tone = "waiting";
  }

  const rawVersions = [
    conv.inboundVersion,
    ...(data.messages || []).map((m) => m.inboundVersion),
    ...(data.aiRuns || []).map((r) => r.inboundVersion),
    ...(data.events || []).map((e) => e.inboundVersion),
    ...(data.outboundActions || []).map((a) => a.inboundVersion),
  ];

  const versions = Array.from(
    new Set(
      rawVersions.filter(
        (v): v is number =>
          typeof v === "number" && Number.isInteger(v) && v > 0
      )
    )
  ).sort((a, b) => b - a);

  return {
    conversationId: conv.id,
    channelAccountId: conv.channelAccountId,
    version,
    current,
    versions,
    stages,
    title,
    tone,
    correlationKey: `${conv.channelAccountId}:${conv.id}:${version}`,
    name: data.customer?.name || conv.title || "Khách hàng Messenger",
    messages,
    inbound,
    manualOutbound,
    runs,
    run,
    actions,
    events,
    policy,
    manifest,
    selectedCount: numberField(manifest?.selectedCount),
    estimatedTokens: numberField(manifest?.estimatedTokens),
    confirmedCount,
    expectedCount,
    hasUncertain,
    allExpectedConfirmed,
    limited: true, // Existing API caps AI runs/actions/events; never claim a full trace.
  };
}
