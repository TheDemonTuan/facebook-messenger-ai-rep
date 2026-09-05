export const DEFAULT_BUSINESS_TIMEZONE = "Asia/Ho_Chi_Minh";

export function isValidTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== "string" || timeZone.trim().length === 0) {
    return false;
  }
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timeZone.trim() });
    return true;
  } catch {
    return false;
  }
}

export function resolveBusinessTimeZone(timeZone?: string | null): string {
  if (timeZone && isValidTimeZone(timeZone)) {
    return timeZone.trim();
  }
  return DEFAULT_BUSINESS_TIMEZONE;
}

const STORAGE_KEY = "fbbot_business_timezone";

function getInitialTimeZone(): string {
  try {
    const saved = typeof window !== "undefined" ? window.localStorage?.getItem(STORAGE_KEY) : null;
    if (saved && isValidTimeZone(saved)) {
      return saved.trim();
    }
  } catch {
    // Ignore storage access issues
  }
  return DEFAULT_BUSINESS_TIMEZONE;
}

let activeBusinessTimeZone: string = getInitialTimeZone();
const listeners = new Set<(tz: string) => void>();

export function getGlobalBusinessTimeZone(): string {
  return activeBusinessTimeZone;
}

export function setGlobalBusinessTimeZone(tz?: string | null): string {
  if (tz && isValidTimeZone(tz)) {
    const normalized = tz.trim();
    if (activeBusinessTimeZone !== normalized) {
      activeBusinessTimeZone = normalized;
      try {
        if (typeof window !== "undefined") {
          window.localStorage?.setItem(STORAGE_KEY, normalized);
        }
      } catch {
        // Ignore storage access issues
      }
      listeners.forEach((fn) => fn(normalized));
    }
  }
  return activeBusinessTimeZone;
}

export function subscribeToTimeZoneChange(callback: (tz: string) => void): () => void {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

/**
 * Customer-friendly active timezone indicator without raw internals or dumps.
 * Example: "Ho Chi Minh (GMT+7)", "New York (GMT-4)".
 */
export function formatFriendlyTimeZone(
  timeZone?: string | null,
  referenceDate: Date = new Date()
): string {
  const tz = resolveBusinessTimeZone(timeZone || activeBusinessTimeZone);
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "shortOffset",
    }).formatToParts(referenceDate);
    const offset = parts.find((p) => p.type === "timeZoneName")?.value || "";
    const city = tz.split("/").pop()?.replace(/_/g, " ") || tz;
    return offset ? `${city} (${offset})` : city;
  } catch {
    return tz;
  }
}

function toSafeDate(input: Date | string | number | null | undefined): Date | null {
  if (input === null || input === undefined || input === "") return null;
  const d = input instanceof Date ? input : new Date(input);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Formats a date and time using explicit business timezone in localized Vietnamese.
 */
export function formatDateTime(
  date: Date | string | number | null | undefined,
  timeZone?: string | null,
  options?: Intl.DateTimeFormatOptions
): string {
  const d = toSafeDate(date);
  if (!d) return "—";
  const tz = resolveBusinessTimeZone(timeZone || activeBusinessTimeZone);
  return d.toLocaleString("vi-VN", { timeZone: tz, ...options });
}

/**
 * Formats a time string using explicit business timezone in localized Vietnamese.
 */
export function formatTime(
  date: Date | string | number | null | undefined,
  timeZone?: string | null,
  options?: Intl.DateTimeFormatOptions
): string {
  const d = toSafeDate(date);
  if (!d) return "—";
  const tz = resolveBusinessTimeZone(timeZone || activeBusinessTimeZone);
  return d.toLocaleTimeString("vi-VN", { timeZone: tz, ...options });
}

/**
 * Formats a date string using explicit business timezone in localized Vietnamese.
 */
export function formatDate(
  date: Date | string | number | null | undefined,
  timeZone?: string | null,
  options?: Intl.DateTimeFormatOptions
): string {
  const d = toSafeDate(date);
  if (!d) return "—";
  const tz = resolveBusinessTimeZone(timeZone || activeBusinessTimeZone);
  return d.toLocaleDateString("vi-VN", { timeZone: tz, ...options });
}
