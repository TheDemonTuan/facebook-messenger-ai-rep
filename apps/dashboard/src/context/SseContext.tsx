import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from "react";

type SseListener = (eventType: string, payload: any) => void;

interface SseContextType {
  connected: boolean;
  subscribe: (listener: SseListener) => () => void;
}

const SseContext = createContext<SseContextType | undefined>(undefined);

export const SseProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [connected, setConnected] = useState<boolean>(false);
  const listenersRef = useRef<Set<SseListener>>(new Set());
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    let es: EventSource | null = null;
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    let isDisposed = false;

    const connect = () => {
      if (isDisposed) return;

      try {
        es = new EventSource("/events", { withCredentials: true });
        eventSourceRef.current = es;

        es.onopen = () => {
          setConnected(true);
        };

        es.onerror = () => {
          setConnected(false);
          es?.close();
          eventSourceRef.current = null;
          if (!isDisposed) {
            reconnectTimeout = setTimeout(connect, 4000);
          }
        };

        // Listen for all broadcast event types
        const registeredTypes = [
          "channel:status",
          "queue:updated",
          "conversation:takeover",
          "conversation:block",
          "conversation:manual-send",
          "conversation:status",
          "inbound:received",
          "outbound:transition",
          "outbound:confirmed",
          "outbound:uncertain",
          "outbound:aborted",
          "action:reconciled",
          "incident:created",
          "incident:resolved",
          "settings:updated",
          "outbox:inbound_received",
          "outbox:manual_send",
          "outbox:ai_generated",
          "outbox:browser_confirmed",
          "outbox:debounce",
          "outbox:reconcile",
        ];

        for (const type of registeredTypes) {
          es.addEventListener(type, (event: MessageEvent) => {
            let parsedData: any = {};
            try {
              parsedData = event.data ? JSON.parse(event.data) : {};
            } catch {
              parsedData = event.data;
            }
            listenersRef.current.forEach((fn) => {
              try {
                fn(type, parsedData);
              } catch (err) {
                console.error(`[SSE] Listener error on event ${type}:`, err);
              }
            });
          });
        }
      } catch (err) {
        console.warn("[SSE] Error connecting:", err);
        if (!isDisposed) {
          reconnectTimeout = setTimeout(connect, 5000);
        }
      }
    };

    connect();

    return () => {
      isDisposed = true;
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (es) {
        es.close();
      }
      eventSourceRef.current = null;
    };
  }, []);

  const subscribe = useCallback((listener: SseListener) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  return (
    <SseContext.Provider value={{ connected, subscribe }}>
      {children}
    </SseContext.Provider>
  );
};

export function useSse(): SseContextType {
  const context = useContext(SseContext);
  if (!context) {
    throw new Error("useSse must be used within an SseProvider");
  }
  return context;
}

/**
 * Custom hook that triggers a debounced refetch when matching SSE events arrive.
 * When SSE is connected, interval polling is suppressed.
 * When SSE is disconnected, falls back to a low-frequency quiet poll (30s).
 */
export function useSseWakeup(
  shouldRefetch: (eventType: string, payload?: any) => boolean,
  refetchCallback: () => void | Promise<void>,
  debounceMs = 250
): void {
  const { connected, subscribe } = useSse();
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callbackRef = useRef(refetchCallback);
  callbackRef.current = refetchCallback;

  useEffect(() => {
    const unsubscribe = subscribe((eventType, payload) => {
      if (shouldRefetch(eventType, payload)) {
        if (debounceTimerRef.current) {
          clearTimeout(debounceTimerRef.current);
        }
        debounceTimerRef.current = setTimeout(() => {
          callbackRef.current();
        }, debounceMs);
      }
    });

    return () => {
      unsubscribe();
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [subscribe, shouldRefetch, debounceMs]);

  // Fallback timer ONLY when SSE is not connected (avoids duplicate polling)
  useEffect(() => {
    if (connected) {
      return; // SSE is live, no polling needed!
    }
    const fallbackTimer = setInterval(() => {
      callbackRef.current();
    }, 30000);

    return () => clearInterval(fallbackTimer);
  }, [connected]);
}
