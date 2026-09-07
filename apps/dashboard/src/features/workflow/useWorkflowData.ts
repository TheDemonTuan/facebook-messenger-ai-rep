import { useState, useEffect, useCallback, useRef } from "react";
import { apiFetch } from "../../api";
import type {
  ConversationItem,
  ConversationDetailData,
  PaginatedInboxResponse,
} from "../../types";
import {
  buildWorkflowView,
  type WorkflowStageId,
  type WorkflowViewData,
} from "./model";
import { useSseWakeup } from "../../context/SseContext";
import {
  shouldRefetchInbox,
  shouldRefetchConversationDetail,
} from "../../helpers/sse-helpers";

export interface UseWorkflowDataResult {
  conversations: ConversationItem[];
  selectedConversationId: string | null;
  setSelectedConversationId: (id: string) => void;
  selectedStageId: WorkflowStageId;
  setSelectedStageId: (id: WorkflowStageId) => void;
  selectedVersion: number | null;
  setSelectedVersion: (v: number | null) => void;
  viewData: WorkflowViewData | null;
  rawDetail: ConversationDetailData | null;
  listLoading: boolean;
  detailLoading: boolean;
  error: string | null;
  query: string;
  setQuery: (q: string) => void;
  filter: "all" | "active" | "attention";
  setFilter: (f: "all" | "active" | "attention") => void;
  tab: "messages" | "events";
  setTab: (t: "messages" | "events") => void;
  isPaused: boolean;
  togglePause: () => void;
  refresh: () => Promise<void>;
  notice: string | null;
  setNotice: (n: string | null) => void;
}

const LIST_INTERVAL_MS = 20000;
const DETAIL_INTERVAL_MS = 10000;
const REQUEST_TIMEOUT_MS = 12000;

export function useWorkflowData(): UseWorkflowDataResult {
  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  const [selectedConversationId, setSelectedConversationIdState] = useState<string | null>(null);
  const [selectedStageId, setSelectedStageId] = useState<WorkflowStageId>("ai");
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [rawDetail, setRawDetail] = useState<ConversationDetailData | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "active" | "attention">("all");
  const [tab, setTab] = useState<"messages" | "events">("messages");
  const [isPaused, setIsPaused] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const detailAbortRef = useRef<AbortController | null>(null);
  const listAbortRef = useRef<AbortController | null>(null);
  const selectedConvIdRef = useRef<string | null>(null);
  selectedConvIdRef.current = selectedConversationId;

  const isPausedRef = useRef(isPaused);
  isPausedRef.current = isPaused;

  const setSelectedConversationId = useCallback((id: string) => {
    setSelectedConversationIdState(id);
    setSelectedVersion(null); // Reset version to latest when changing conversation
  }, []);

  const togglePause = useCallback(() => {
    setIsPaused((prev) => !prev);
  }, []);

  // Fetch list of conversations
  const fetchList = useCallback(async () => {
    if (document.hidden || isPausedRef.current) return;

    if (listAbortRef.current) {
      listAbortRef.current.abort();
    }
    const controller = new AbortController();
    listAbortRef.current = controller;
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await apiFetch<PaginatedInboxResponse>("/api/inbox?limit=50", {
        signal: controller.signal,
      });
      setConversations(res.conversations || []);
      setError(null);

      // Auto-select first conversation if none is selected
      if (!selectedConvIdRef.current && res.conversations?.length > 0) {
        setSelectedConversationIdState(res.conversations[0].conversation.id);
      }
    } catch (err: unknown) {
      if ((err as Error).name !== "AbortError") {
        console.warn("[Workflow] Error loading inbox list:", err);
      }
    } finally {
      clearTimeout(timeoutId);
      setListLoading(false);
    }
  }, []);

  // Fetch conversation detail
  const fetchDetail = useCallback(async (convId: string) => {
    if (!convId) {
      setRawDetail(null);
      return;
    }

    if (detailAbortRef.current) {
      detailAbortRef.current.abort();
    }
    const controller = new AbortController();
    detailAbortRef.current = controller;
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    setDetailLoading(true);
    try {
      const detail = await apiFetch<ConversationDetailData>(
        `/api/inbox/${encodeURIComponent(convId)}?messageLimit=50`,
        { signal: controller.signal }
      );
      setRawDetail(detail);
      setError(null);
    } catch (err: unknown) {
      if ((err as Error).name !== "AbortError") {
        console.warn("[Workflow] Error loading detail for conversation", convId, err);
        setError("Không thể tải chi tiết hội thoại");
      }
    } finally {
      clearTimeout(timeoutId);
      setDetailLoading(false);
    }
  }, []);

  // Initial load
  useEffect(() => {
    fetchList();
  }, [fetchList]);

  // When selected conversation changes, fetch its detail
  useEffect(() => {
    if (selectedConversationId) {
      fetchDetail(selectedConversationId);
    } else {
      setRawDetail(null);
    }
  }, [selectedConversationId, fetchDetail]);

  // Periodic polling for conversation list (20s)
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden && !isPausedRef.current) {
        fetchList();
      }
    }, LIST_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [fetchList]);

  // Periodic polling for selected conversation detail (10s)
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden && !isPausedRef.current && selectedConvIdRef.current) {
        fetchDetail(selectedConvIdRef.current);
      }
    }, DETAIL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [fetchDetail]);

  // Visibility change handling
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (!document.hidden && !isPausedRef.current) {
        fetchList();
        if (selectedConvIdRef.current) {
          fetchDetail(selectedConvIdRef.current);
        }
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [fetchList, fetchDetail]);

  // SSE wakeup for inbox list
  useSseWakeup(
    shouldRefetchInbox,
    useCallback(() => {
      if (!document.hidden && !isPausedRef.current) {
        fetchList();
      }
    }, [fetchList]),
    350
  );

  // SSE wakeup for conversation detail
  const shouldRefetchCurrentDetail = useCallback(
    (eventType: string, payload?: unknown) => {
      const convId = selectedConvIdRef.current;
      if (!convId || isPausedRef.current || document.hidden) return false;
      return shouldRefetchConversationDetail(
        eventType,
        convId,
        payload as { conversationId?: string; id?: string } | undefined
      );
    },
    []
  );

  useSseWakeup(
    shouldRefetchCurrentDetail,
    useCallback(() => {
      const convId = selectedConvIdRef.current;
      if (convId && !document.hidden && !isPausedRef.current) {
        fetchDetail(convId);
      }
    }, [fetchDetail]),
    350
  );

  const refresh = useCallback(async () => {
    setListLoading(true);
    await fetchList();
    if (selectedConvIdRef.current) {
      await fetchDetail(selectedConvIdRef.current);
    }
  }, [fetchList, fetchDetail]);

  // Build projected workflow view from rawDetail
  const viewData: WorkflowViewData | null = rawDetail
    ? buildWorkflowView(rawDetail, selectedVersion ?? undefined)
    : null;

  return {
    conversations,
    selectedConversationId,
    setSelectedConversationId,
    selectedStageId,
    setSelectedStageId,
    selectedVersion,
    setSelectedVersion,
    viewData,
    rawDetail,
    listLoading,
    detailLoading,
    error,
    query,
    setQuery,
    filter,
    setFilter,
    tab,
    setTab,
    isPaused,
    togglePause,
    refresh,
    notice,
    setNotice,
  };
}
