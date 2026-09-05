import type { SessionUser } from "./types";

const DEV_EMAIL_STORAGE_KEY = "fbbot_dev_email";

export function getStoredDevEmail(): string {
  try {
    return localStorage.getItem(DEV_EMAIL_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

export function setStoredDevEmail(email: string): void {
  try {
    if (email) {
      localStorage.setItem(DEV_EMAIL_STORAGE_KEY, email);
    } else {
      localStorage.removeItem(DEV_EMAIL_STORAGE_KEY);
    }
  } catch {
    /* ignore localStorage error */
  }
}

export async function apiFetch<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((options.headers as Record<string, string>) || {}),
  };

  const devEmail = getStoredDevEmail();
  if (devEmail) {
    headers["x-dev-user-email"] = devEmail;
  }

  const res = await fetch(endpoint, {
    ...options,
    headers,
    credentials: "include",
  });

  if (res.status === 401 && !endpoint.includes("/api/auth/login") && !endpoint.includes("/api/auth/me")) {
    if (window.location.pathname !== "/login") {
      window.location.href = "/login";
    }
    throw new Error("Authentication required via Cloudflare Access");
  }

  if (!res.ok) {
    const errorData = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(errorData.error || `Request failed with status ${res.status}`);
  }

  return await res.json();
}

/**
 * Fetch current authenticated user via Cloudflare identity endpoint.
 */
export async function fetchCurrentUser(): Promise<SessionUser | null> {
  try {
    const res = await apiFetch<{ user: SessionUser }>("/api/auth/me");
    return res.user;
  } catch {
    return null;
  }
}

/**
 * Confirm identity via Cloudflare access endpoint (no password/totp).
 */
export async function loginWithCloudflare(devEmail?: string): Promise<SessionUser> {
  if (devEmail) {
    setStoredDevEmail(devEmail);
  }
  const res = await apiFetch<{ success: boolean; user: SessionUser }>("/api/auth/login", {
    method: "POST",
  });
  return res.user;
}

/**
 * Logout operator session.
 */
export async function logoutUser(): Promise<void> {
  try {
    await apiFetch("/api/auth/logout", { method: "POST" });
  } finally {
    setStoredDevEmail("");
  }
}
