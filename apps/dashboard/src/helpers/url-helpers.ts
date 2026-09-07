/**
 * Safe href sanitizer for dashboard UI links and media elements.
 *
 * Rules:
 * 1. Allow only http: and https: protocols for general navigation.
 * 2. Allow internal '/api/...' paths.
 * 3. Disallow blob: URLs for external links (<a target="_blank">).
 *    Allow blob: URLs only when rendering media locally on the same origin.
 * 4. Strictly block javascript:, data:, file:, vbscript:, protocol-relative //, etc.
 */

export function getSafeHref(
  rawUrl: string | null | undefined,
  options?: { allowBlob?: boolean; allowInternalApi?: boolean }
): string | null {
  if (!rawUrl || typeof rawUrl !== "string") return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  // Block dangerous schemes immediately (case-insensitive)
  if (/^(?:javascript|data|file|vbscript):/i.test(trimmed)) {
    return null;
  }

  // Reject protocol-relative URLs (e.g. //evil.com)
  if (trimmed.startsWith("//")) {
    return null;
  }

  // Handle internal API paths
  if (trimmed.startsWith("/api/") || trimmed === "/api") {
    if (options?.allowInternalApi === false) {
      return null;
    }
    return trimmed;
  }

  // Reject any other relative paths
  if (trimmed.startsWith("/") || trimmed.startsWith(".")) {
    return null;
  }

  // Handle blob: URLs
  if (trimmed.startsWith("blob:")) {
    if (options?.allowBlob) {
      if (typeof window !== "undefined" && window.location?.origin) {
        if (
          trimmed.startsWith(`blob:${window.location.origin}/`) ||
          trimmed === `blob:${window.location.origin}`
        ) {
          return trimmed;
        }
        return null;
      }
      return trimmed;
    }
    return null;
  }

  // Validate absolute http: and https: URLs
  try {
    const parsed = new URL(trimmed);
    const protocol = parsed.protocol.toLowerCase();
    if (protocol === "http:" || protocol === "https:") {
      return parsed.toString();
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Validates URLs for external navigation (e.g. <a target="_blank">).
 * Strictly forbids blob:, javascript:, data:, file:, etc.
 * Only allows http: and https:.
 */
export function getSafeExternalHref(rawUrl: string | null | undefined): string | null {
  return getSafeHref(rawUrl, { allowBlob: false, allowInternalApi: false });
}

/**
 * Validates URLs for local media rendering (e.g. <img src>, <audio src>, <video src>).
 * Allows same-origin blob: for local playback, http:, https:, and internal /api/...
 * Strictly rejects javascript:, data:, file:.
 */
export function getSafeMediaSrc(rawUrl: string | null | undefined): string | null {
  return getSafeHref(rawUrl, { allowBlob: true, allowInternalApi: true });
}
