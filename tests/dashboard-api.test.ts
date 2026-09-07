import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { apiFetch, getStoredDevEmail, setStoredDevEmail } from "../apps/dashboard/src/api";

describe("Dashboard apiFetch client wrapper", () => {
  const originalFetch = globalThis.fetch;
  const originalLocalStorage = Reflect.get(globalThis, "localStorage") as Storage | undefined;

  beforeEach(() => {
    const store = new Map<string, string>();
    const mockStorage: Partial<Storage> = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, val: string) => store.set(key, String(val)),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
    };
    Reflect.set(globalThis, "localStorage", mockStorage);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Reflect.set(globalThis, "localStorage", originalLocalStorage);
    vi.restoreAllMocks();
  });
  it("omits Content-Type header on bodyless POST requests", async () => {
    let capturedHeaders: Headers | undefined;

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ success: true, status: "PAUSED" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const result = await apiFetch<{ success: boolean; status: string }>("/api/channel/pause", {
      method: "POST",
    });

    expect(result).toEqual({ success: true, status: "PAUSED" });
    expect(capturedHeaders).toBeDefined();
    expect(capturedHeaders!.has("content-type")).toBe(false);
  });

  it("sets Content-Type: application/json when a body is provided without explicit content-type", async () => {
    let capturedHeaders: Headers | undefined;
    let capturedBody: BodyInit | null | undefined;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers);
      capturedBody = init?.body;
      return new Response(JSON.stringify({ settings: { brandName: "Test" }, revision: 2 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const bodyStr = JSON.stringify({ brandName: "Test" });
    const result = await apiFetch<{ settings: { brandName: string }; revision: number }>("/api/settings", {
      method: "POST",
      body: bodyStr,
    });

    expect(result.revision).toBe(2);
    expect(capturedHeaders).toBeDefined();
    expect(capturedHeaders!.get("content-type")).toBe("application/json");
    expect(capturedBody).toBe(bodyStr);
  });

  it("preserves explicit caller content-type when provided", async () => {
    let capturedHeaders: Headers | undefined;

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await apiFetch("/api/custom", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "plain-text-payload",
    });

    expect(capturedHeaders).toBeDefined();
    expect(capturedHeaders!.get("content-type")).toBe("text/plain");
  });

  it("attaches x-dev-user-email when stored in localStorage", async () => {
    setStoredDevEmail("operator@example.com");
    expect(getStoredDevEmail()).toBe("operator@example.com");
    let capturedHeaders: Headers | undefined;

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ user: { id: "u1", email: "operator@example.com" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await apiFetch("/api/auth/me");

    expect(capturedHeaders).toBeDefined();
    expect(capturedHeaders!.get("x-dev-user-email")).toBe("operator@example.com");
  });

  it("throws error with server error message on non-ok status", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ error: "FST_ERR_CTP_EMPTY_JSON_BODY" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await expect(apiFetch("/api/test")).rejects.toThrow("FST_ERR_CTP_EMPTY_JSON_BODY");
  });
});
