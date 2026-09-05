export const DEFAULT_BUSINESS_TIMEZONE = "Asia/Ho_Chi_Minh";

export interface ZonedDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export interface BusinessDayRange {
  startOfDay: Date;
  endOfDay: Date;
}

/**
 * Validates whether a value is a valid IANA time zone identifier recognized by Intl.
 */
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

/**
 * Normalizes an IANA timezone identifier, defaulting to Asia/Ho_Chi_Minh.
 */
export function resolveBusinessTimeZone(timeZone?: string | null): string {
  if (timeZone && isValidTimeZone(timeZone)) {
    return timeZone.trim();
  }
  return DEFAULT_BUSINESS_TIMEZONE;
}

/**
 * Computes offset in milliseconds between target timezone and UTC for a given instant.
 * Uses pure Date.UTC and Intl.DateTimeFormat - zero process-local Date constructors.
 */
export function getTimezoneOffsetMs(
  date: Date,
  timeZone: string = DEFAULT_BUSINESS_TIMEZONE
): number {
  const tz = resolveBusinessTimeZone(timeZone);
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hourCycle: "h23",
  });
  const formatted = dtf.formatToParts(date);
  const zYear = parseInt(formatted.find((p) => p.type === "year")!.value, 10);
  const zMonth = parseInt(formatted.find((p) => p.type === "month")!.value, 10);
  const zDay = parseInt(formatted.find((p) => p.type === "day")!.value, 10);
  const zHour = parseInt(formatted.find((p) => p.type === "hour")!.value, 10);
  const zMin = parseInt(formatted.find((p) => p.type === "minute")!.value, 10);
  const zSec = parseInt(formatted.find((p) => p.type === "second")!.value, 10);

  const candidateZonedNominalUtc = Date.UTC(zYear, zMonth - 1, zDay, zHour, zMin, zSec);
  return candidateZonedNominalUtc - date.getTime();
}

/**
 * Extracts year/month/day/hour/minute/second of a Date in the given IANA timezone.
 */
export function getZonedDateParts(
  date: Date,
  timeZone: string = DEFAULT_BUSINESS_TIMEZONE
): ZonedDateParts {
  const tz = resolveBusinessTimeZone(timeZone);
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hourCycle: "h23",
  });
  const formatted = dtf.formatToParts(date);
  return {
    year: parseInt(formatted.find((p) => p.type === "year")!.value, 10),
    month: parseInt(formatted.find((p) => p.type === "month")!.value, 10),
    day: parseInt(formatted.find((p) => p.type === "day")!.value, 10),
    hour: parseInt(formatted.find((p) => p.type === "hour")!.value, 10),
    minute: parseInt(formatted.find((p) => p.type === "minute")!.value, 10),
    second: parseInt(formatted.find((p) => p.type === "second")!.value, 10),
  };
}

/**
 * Two-pass conversion from zoned nominal date/time parts to exact UTC Date.
 * Pass 1 estimates the offset at the nominal UTC timestamp;
 * Pass 2 recalculates the offset at the candidate date to resolve DST boundary shifts correctly.
 */
export function getUtcDateFromZonedParts(
  parts: { year: number; month: number; day: number; hour: number; minute: number; second?: number },
  timeZone: string = DEFAULT_BUSINESS_TIMEZONE
): Date {
  const tz = resolveBusinessTimeZone(timeZone);
  const nominalTargetUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second ?? 0
  );

  // Pass 1: Estimate offset using nominal target UTC
  const offset1 = getTimezoneOffsetMs(new Date(nominalTargetUtc), tz);
  const candidate = new Date(nominalTargetUtc - offset1);

  // Pass 2: Refine offset using candidate date (handles DST transition boundary shifts)
  const offset2 = getTimezoneOffsetMs(candidate, tz);
  return new Date(nominalTargetUtc - offset2);
}

/**
 * Computes business-day start and end (exclusive upper bound) for an instant in the business timezone.
 * Handles DST overlap (25-hour days) and DST gaps (23-hour days) without process-local Date constructors.
 */
export function getBusinessDayRange(
  referenceDate: Date = new Date(),
  timeZone: string = DEFAULT_BUSINESS_TIMEZONE
): BusinessDayRange {
  const tz = resolveBusinessTimeZone(timeZone);
  const parts = getZonedDateParts(referenceDate, tz);

  const startOfDay = getUtcDateFromZonedParts(
    { year: parts.year, month: parts.month, day: parts.day, hour: 0, minute: 0, second: 0 },
    tz
  );

  // Compute start of next calendar day via pure UTC calendar arithmetic
  const nextNominal = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
  const nextParts = {
    year: nextNominal.getUTCFullYear(),
    month: nextNominal.getUTCMonth() + 1,
    day: nextNominal.getUTCDate(),
    hour: 0,
    minute: 0,
    second: 0,
  };
  const endOfDay = getUtcDateFromZonedParts(nextParts, tz);

  return { startOfDay, endOfDay };
}

/**
 * Formats a customer-friendly timezone badge without exposing raw internals (e.g. "Ho Chi Minh (GMT+7)", "New York (GMT-4)").
 */
export function formatCustomerFriendlyTimeZone(
  timeZone: string = DEFAULT_BUSINESS_TIMEZONE,
  referenceDate: Date = new Date()
): string {
  const tz = resolveBusinessTimeZone(timeZone);
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

/**
 * Formats a timestamp into localized Vietnamese string explicitly within the given business timezone.
 */
export function formatInBusinessTimeZone(
  date: Date | string | number,
  timeZone: string = DEFAULT_BUSINESS_TIMEZONE,
  options?: Intl.DateTimeFormatOptions
): string {
  const tz = resolveBusinessTimeZone(timeZone);
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) {
    return "—";
  }
  return d.toLocaleString("vi-VN", { timeZone: tz, ...options });
}
