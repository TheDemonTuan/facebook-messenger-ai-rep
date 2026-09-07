import dns from "node:dns/promises";
import { isIP } from "node:net";

export interface UrlValidationResult {
  valid: boolean;
  reason?: string;
  parsedUrl?: URL;
  isBlob?: boolean;
}

export interface DnsResolver {
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
}

export interface DnsValidationResult {
  valid: boolean;
  resolvedIps: string[];
  reason?: string;
}

/**
 * Checks if an IPv4 or IPv6 address is private, loopback, link-local,
 * cloud metadata, or reserved for non-public routing.
 */
export function isPrivateOrBlockedIp(ip: string): boolean {
  const cleanIp = ip.trim().toLowerCase();

  // IPv4 mapped to IPv6 (e.g. ::ffff:127.0.0.1 or ::ffff:7f00:1)
  if (cleanIp.startsWith("::ffff:")) {
    const rest = cleanIp.slice(7);
    if (isIP(rest) === 4) {
      return isPrivateOrBlockedIp(rest);
    }
  }

  // IPv4 checks
  if (isIP(cleanIp) === 4) {
    const parts = cleanIp.split(".").map((p) => parseInt(p, 10));
    if (parts.length !== 4 || parts.some(isNaN)) return true;
    const [b0, b1] = parts;

    // 0.0.0.0/8 (Current network)
    if (b0 === 0) return true;
    // 10.0.0.0/8 (Private)
    if (b0 === 10) return true;
    // 127.0.0.0/8 (Loopback)
    if (b0 === 127) return true;
    // 169.254.0.0/16 (Link-local & AWS/GCP/Azure metadata 169.254.169.254)
    if (b0 === 169 && b1 === 254) return true;
    // Alibaba Cloud metadata (100.100.100.200)
    if (cleanIp === "100.100.100.200") return true;
    // 172.16.0.0/12 (Private: 172.16.0.0 - 172.31.255.255)
    if (b0 === 172 && b1 !== undefined && b1 >= 16 && b1 <= 31) return true;
    // 192.168.0.0/16 (Private)
    if (b0 === 192 && b1 === 168) return true;
    // 100.64.0.0/10 (Carrier-grade NAT)
    if (b0 === 100 && b1 !== undefined && b1 >= 64 && b1 <= 127) return true;
    // 192.0.0.0/24 & 192.0.2.0/24 (TEST-NET-1 / IETF)
    if (b0 === 192 && b1 === 0) return true;
    // 198.51.100.0/24 (TEST-NET-2)
    if (b0 === 198 && b1 === 51) return true;
    // 203.0.113.0/24 (TEST-NET-3)
    if (b0 === 203 && b1 === 0) return true;
    // 224.0.0.0/4 (Multicast)
    if (b0 !== undefined && b0 >= 224 && b0 <= 239) return true;
    // 240.0.0.0/4 (Reserved)
    if (b0 !== undefined && b0 >= 240) return true;
    // 255.255.255.255 (Broadcast)
    if (cleanIp === "255.255.255.255") return true;

    return false;
  }

  // IPv6 checks
  if (isIP(cleanIp) === 6) {
    // ::1 (Loopback)
    if (cleanIp === "::1") return true;
    // :: (Unspecified)
    if (cleanIp === "::" || cleanIp === "0:0:0:0:0:0:0:0") return true;
    // fc00::/7 (Unique Local Address) & AWS IPv6 metadata (fd00:ec2::254)
    if (cleanIp.startsWith("fc") || cleanIp.startsWith("fd")) return true;
    // fe80::/10 (Link-Local)
    if (
      cleanIp.startsWith("fe8") ||
      cleanIp.startsWith("fe9") ||
      cleanIp.startsWith("fea") ||
      cleanIp.startsWith("feb")
    ) {
      return true;
    }

    return false;
  }

  return false;
}

/**
 * Resolves DNS A (IPv4) and AAAA (IPv6) records for a hostname,
 * and validates that NO resolved IP falls within private, loopback,
 * link-local, cloud metadata, or reserved ranges.
 *
 * Mitigates DNS rebinding by performing verified lookups before every request and redirect.
 */
export async function resolveAndValidateDns(
  hostname: string,
  resolver?: DnsResolver
): Promise<DnsValidationResult> {
  const cleanHost = hostname.trim().toLowerCase();

  // If already an IP literal
  const ipVer = isIP(cleanHost);
  if (ipVer > 0) {
    if (isPrivateOrBlockedIp(cleanHost)) {
      return {
        valid: false,
        resolvedIps: [cleanHost],
        reason: `RESOLVED_BLOCKED_IP: Host ${cleanHost} is in blocked/private IP range`,
      };
    }
    return { valid: true, resolvedIps: [cleanHost] };
  }

  const dnsResolver: DnsResolver = resolver ?? dns;
  let ipv4List: string[] = [];
  let ipv6List: string[] = [];
  let aError: Error | null = null;
  let aaaaError: Error | null = null;

  try {
    ipv4List = await dnsResolver.resolve4(cleanHost);
  } catch (err) {
    aError = err as Error;
  }

  try {
    ipv6List = await dnsResolver.resolve6(cleanHost);
  } catch (err) {
    aaaaError = err as Error;
  }

  const allIps = [...ipv4List, ...ipv6List];

  if (allIps.length === 0) {
    return {
      valid: false,
      resolvedIps: [],
      reason: `DNS_RESOLUTION_FAILED: Could not resolve A or AAAA records for ${cleanHost} (${aError?.message || "no A"} / ${aaaaError?.message || "no AAAA"})`,
    };
  }

  // Reject immediately if ANY resolved IP address is private or blocked
  for (const ip of allIps) {
    if (isPrivateOrBlockedIp(ip)) {
      return {
        valid: false,
        resolvedIps: allIps,
        reason: `RESOLVED_BLOCKED_IP: Host ${cleanHost} resolved to blocked IP ${ip}`,
      };
    }
  }

  return { valid: true, resolvedIps: allIps };
}

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "instance-data",
  "169.254.169.254",
  "metadata",
  "router",
]);

/**
 * Validates a candidate media URL for SSRF risks, allowed schemes, and host safety.
 */
export function validateMediaUrl(
  rawUrl: string,
  options: { allowBlob?: boolean } = {}
): UrlValidationResult {
  if (!rawUrl || typeof rawUrl !== "string") {
    return { valid: false, reason: "EMPTY_OR_NON_STRING_URL" };
  }

  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return { valid: false, reason: "EMPTY_URL" };
  }

  if (trimmed.startsWith("blob:")) {
    if (options.allowBlob) {
      return { valid: true, isBlob: true };
    }
    return { valid: false, reason: "BLOB_URL_NOT_ALLOWED_IN_CONTEXT", isBlob: true };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, reason: "INVALID_URL_FORMAT" };
  }

  // Protocol whitelist: only http: and https:
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { valid: false, reason: `DISALLOWED_PROTOCOL_${parsed.protocol.toUpperCase()}` };
  }

  // Disallow user credentials embedded in URL
  if (parsed.username || parsed.password) {
    return { valid: false, reason: "URL_CONTAINS_USER_CREDENTIALS" };
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!hostname) {
    return { valid: false, reason: "MISSING_HOSTNAME" };
  }

  // Check blocked hostnames
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return { valid: false, reason: "BLOCKED_HOSTNAME" };
  }

  // Reject local domain suffixes
  if (
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".lan") ||
    hostname.endsWith(".home")
  ) {
    return { valid: false, reason: "LOCAL_OR_INTERNAL_DOMAIN" };
  }

  // Check IP addresses directly
  const ipVersion = isIP(hostname);
  if (ipVersion > 0) {
    if (isPrivateOrBlockedIp(hostname)) {
      return { valid: false, reason: "PRIVATE_OR_RESERVED_IP_ADDRESS" };
    }
  }

  // Disallow non-standard ports commonly used for internal services
  if (parsed.port) {
    const port = parseInt(parsed.port, 10);
    // Allow standard HTTP/HTTPS and typical CDN ports
    const allowedPorts = new Set([80, 443, 8080, 8443]);
    if (!allowedPorts.has(port)) {
      return { valid: false, reason: `DISALLOWED_PORT_${port}` };
    }
  }

  return { valid: true, parsedUrl: parsed, isBlob: false };
}
