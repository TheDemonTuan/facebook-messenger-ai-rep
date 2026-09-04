export interface ChannelOverview {
  channelStatus: "RUNNING" | "PAUSED" | "SUSPENDED" | "ERROR";
  channelIsSuspended: boolean;
  channelIsPaused: boolean;
  activeConversation: {
    id: string;
    status: string;
    externalThreadId: string;
    claimedAt: string | null;
  } | null;
  queueLength: number;
  oldestWaitSeconds: number;
  estimatedWaitSeconds: number;
  todayConversationsCount: number;
  todayMessagesCount: number;
  openIncidentsCount: number;
}

export interface ConversationItem {
  conversation: {
    id: string;
    status: string;
    inboundVersion: number;
    lastInboundAt: string | null;
    lastOutboundAt: string | null;
    unreadCount: number;
    isBlocked: boolean;
    manualMode: boolean;
  };
  customer: {
    id: string;
    name: string | null;
    avatarUrl: string | null;
  };
}

export interface MessageItem {
  id: string;
  direction: "INBOUND" | "OUTBOUND";
  actor: "AI" | "MANUAL_OWNER" | "SYSTEM";
  text: string;
  inboundVersion: number;
  responseIndex: number;
  timestamp: string;
}

export interface OutboundActionItem {
  id: string;
  actionId: string;
  inboundVersion: number;
  responseIndex: number;
  text: string;
  actor: string;
  status: "PENDING" | "TYPING" | "SENDING" | "SENT" | "ABORTED" | "UNCONFIRMED" | "FAILED";
  unconfirmedReason: string | null;
  errorMessage: string | null;
  createdAt: string;
}

export interface QueueItem {
  queueId: string;
  conversationId: string;
  customerName: string | null;
  queuedAt: string;
  readyAt: string;
  inboundVersion: number;
  attempt: number;
  isSticky: boolean;
  stickyTurns: number;
  yieldRequired: boolean;
  position: number;
  estimatedWaitSeconds: number;
}

export interface IncidentItem {
  id: string;
  type: string;
  status: "OPEN" | "ACKNOWLEDGED" | "RESOLVED";
  title: string;
  description: string;
  metadata?: {
    rawResponse?: string | null;
    inboundVersion?: number;
    requestMessages?: Array<{ role: string; content: string }>;
    model?: string;
    baseUrl?: string;
    [key: string]: unknown;
  } | null;
  conversationId?: string | null;
  createdAt: string;
}

export interface AiRunItem {
  id: string;
  channelAccountId: string;
  conversationId: string;
  inboundVersion: number;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
  status: "SUCCESS" | "GUARD_REJECTED" | "ERROR" | "STALE_ABORTED";
  rawResponse: string | null;
  parsedOutput: {
    messages?: string[];
    needsClarification?: boolean;
    _request?: {
      model?: string;
      baseUrl?: string;
      messages?: Array<{ role: string; content: string }>;
    };
    [key: string]: unknown;
  } | null;
  promptMessages?: Array<{ role: string; content: string }> | null;
  errorMessage: string | null;
  createdAt: string;
}

export interface SettingItem {
  settings: {
    debounceMs: number;
    stickyWindowMs: number;
    stickyMaxTurns: number;
    stickyMaxDurationMs: number;
    aiModel: string;
    aiBaseUrl: string;
    aiApiKey: string;
    aiTimeoutMs: number;
    aiMaxResponseCount: number;
    aiTotalMaxChars: number;
    aiSystemPersona: string;
    businessProfile: string;
    typingTargetWpmMin: number;
    typingTargetWpmMax: number;
    busyMode: boolean;
    autoReplyEnabled: boolean;
    pauseIntakeProcessing: boolean;
  };
  revision: number;
}
