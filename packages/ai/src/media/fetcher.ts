import { validateMediaUrl, resolveAndValidateDns, type DnsResolver } from "./security.js";
import { sniffMimeType, isAllowedPartMimeType } from "./sniffer.js";
import { generateInternalMediaRef, globalMediaCache } from "./cache.js";

export interface FetchMediaOptions {
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  expectedCategory?: "IMAGE" | "VOICE" | "AUDIO" | "VIDEO";
  browserContextBridge?: (blobUrl: string) => Promise<Buffer | Uint8Array | null>;
  dnsResolver?: DnsResolver;
  fetchFn?: typeof fetch;
}

export interface FetchMediaResult {
  success: boolean;
  mediaRefId?: string;
  mimeType?: string;
  byteSize?: number;
  buffer?: Buffer;
  base64?: string;
  error?: string;
  status: "READY" | "UNAVAILABLE" | "ERROR";
}

/**
 * Securely fetches a media resource with strict SSRF protection, redirect verification,
 * byte caps, timeout limits, and MIME sniffing.
 */
export async function fetchMediaSecurely(
  rawUrl: string,
  options: FetchMediaOptions = {}
): Promise<FetchMediaResult> {
  const maxBytes = options.maxBytes ?? (options.expectedCategory === "IMAGE" ? 10 * 1024 * 1024 : 15 * 1024 * 1024);
  const timeoutMs = options.timeoutMs ?? 10000;
  const maxRedirects = options.maxRedirects ?? 3;
  const expectedCategory = options.expectedCategory ?? "IMAGE";

  if (!rawUrl || typeof rawUrl !== "string") {
    return { success: false, status: "ERROR", error: "INVALID_URL" };
  }

  const trimmedUrl = rawUrl.trim();

  // 1. Handle blob: URLs via browser context bridge if available
  if (trimmedUrl.startsWith("blob:")) {
    if (options.browserContextBridge) {
      try {
        const bridgeBuffer = await options.browserContextBridge(trimmedUrl);
        if (bridgeBuffer && bridgeBuffer.length > 0) {
          const buf = Buffer.isBuffer(bridgeBuffer) ? bridgeBuffer : Buffer.from(bridgeBuffer);
          if (buf.length > maxBytes) {
            return { success: false, status: "ERROR", error: "MAX_SIZE_EXCEEDED" };
          }
          const sniff = sniffMimeType(buf);
          if (!sniff.isSafe || !sniff.mimeType) {
            return { success: false, status: "ERROR", error: sniff.rejectionReason || "UNRECOGNIZED_MEDIA_TYPE" };
          }
          if (!isAllowedPartMimeType(sniff.mimeType, expectedCategory)) {
            return { success: false, status: "ERROR", error: `DISALLOWED_MIME_FOR_CATEGORY_${sniff.mimeType}` };
          }
          const mediaRefId = generateInternalMediaRef(buf, sniff.mimeType);
          const base64 = buf.toString("base64");
          globalMediaCache.set({
            mediaRefId,
            mimeType: sniff.mimeType,
            byteSize: buf.length,
            buffer: buf,
            base64,
            sourceUrl: trimmedUrl,
          });
          return {
            success: true,
            status: "READY",
            mediaRefId,
            mimeType: sniff.mimeType,
            byteSize: buf.length,
            buffer: buf,
            base64,
          };
        }
      } catch (err) {
        return {
          success: false,
          status: "UNAVAILABLE",
          error: `BLOB_BRIDGE_FAILED: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
    return {
      success: false,
      status: "UNAVAILABLE",
      error: "BLOB_URL_REQUIRES_BROWSER_CONTEXT",
    };
  }

  // 2. Validate initial URL against SSRF
  const initialCheck = validateMediaUrl(trimmedUrl);
  if (!initialCheck.valid) {
    return { success: false, status: "ERROR", error: initialCheck.reason || "UNSAFE_URL" };
  }

  // SSRF DNS resolution of A and AAAA records prior to request
  const initialDns = await resolveAndValidateDns(initialCheck.parsedUrl!.hostname, options.dnsResolver);
  if (!initialDns.valid) {
    return { success: false, status: "ERROR", error: initialDns.reason || "UNSAFE_DNS_RESOLUTION" };
  }

  const fetchImpl = options.fetchFn ?? fetch;

  // 3. Fetch with manual redirect validation
  let currentUrl = trimmedUrl;
  let redirectsCount = 0;

  while (redirectsCount <= maxRedirects) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      const response = await fetchImpl(currentUrl, {
        method: "GET",
        headers: {
          Accept: expectedCategory === "IMAGE" ? "image/*" : "audio/*,video/*",
          "User-Agent": "MessengerMediaFetcher/1.0",
        },
        redirect: "manual",
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // Handle 3xx Redirects
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        redirectsCount++;
        if (redirectsCount > maxRedirects) {
          return { success: false, status: "ERROR", error: "TOO_MANY_REDIRECTS" };
        }

        const locationHeader = response.headers.get("location");
        if (!locationHeader) {
          return { success: false, status: "ERROR", error: "REDIRECT_WITHOUT_LOCATION" };
        }

        const resolvedRedirect = new URL(locationHeader, currentUrl).toString();
        const redirectCheck = validateMediaUrl(resolvedRedirect);
        if (!redirectCheck.valid) {
          return {
            success: false,
            status: "ERROR",
            error: `REDIRECT_TO_UNSAFE_HOST: ${redirectCheck.reason}`,
          };
        }

        // Revalidate DNS A/AAAA resolution for redirect target!
        const redirectDns = await resolveAndValidateDns(redirectCheck.parsedUrl!.hostname, options.dnsResolver);
        if (!redirectDns.valid) {
          return {
            success: false,
            status: "ERROR",
            error: `REDIRECT_TO_UNSAFE_HOST: ${redirectDns.reason}`,
          };
        }

        currentUrl = resolvedRedirect;
        continue;
      }

      if (!response.ok) {
        return { success: false, status: "ERROR", error: `HTTP_${response.status}` };
      }

      // Check Content-Length header cap
      const contentLengthHeader = response.headers.get("content-length");
      if (contentLengthHeader) {
        const contentLength = parseInt(contentLengthHeader, 10);
        if (!isNaN(contentLength) && contentLength > maxBytes) {
          return { success: false, status: "ERROR", error: "MAX_SIZE_EXCEEDED" };
        }
      }

      // Read response body with streaming byte counter
      if (!response.body) {
        return { success: false, status: "ERROR", error: "EMPTY_RESPONSE_BODY" };
      }

      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let totalReceived = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          totalReceived += value.length;
          if (totalReceived > maxBytes) {
            await reader.cancel();
            return { success: false, status: "ERROR", error: "MAX_SIZE_EXCEEDED" };
          }
          chunks.push(value);
        }
      }

      const buffer = Buffer.concat(chunks);

      // 4. Sniff MIME type
      const sniff = sniffMimeType(buffer);
      if (!sniff.isSafe || !sniff.mimeType) {
        return {
          success: false,
          status: "ERROR",
          error: sniff.rejectionReason || "UNRECOGNIZED_MEDIA_TYPE",
        };
      }

      if (!isAllowedPartMimeType(sniff.mimeType, expectedCategory)) {
        return {
          success: false,
          status: "ERROR",
          error: `DISALLOWED_MIME_FOR_CATEGORY_${sniff.mimeType}`,
        };
      }

      // 5. Cache and return internal mediaRef
      const mediaRefId = generateInternalMediaRef(buffer, sniff.mimeType);
      const base64 = buffer.toString("base64");

      globalMediaCache.set({
        mediaRefId,
        mimeType: sniff.mimeType,
        byteSize: buffer.length,
        buffer,
        base64,
        sourceUrl: trimmedUrl,
      });

      return {
        success: true,
        status: "READY",
        mediaRefId,
        mimeType: sniff.mimeType,
        byteSize: buffer.length,
        buffer,
        base64,
      };
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        return { success: false, status: "ERROR", error: "NETWORK_TIMEOUT" };
      }
      return {
        success: false,
        status: "ERROR",
        error: `FETCH_FAILED: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  return { success: false, status: "ERROR", error: "TOO_MANY_REDIRECTS" };
}
