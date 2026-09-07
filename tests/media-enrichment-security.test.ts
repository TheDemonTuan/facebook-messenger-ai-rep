import { describe, it, expect } from "vitest";
import {
  isPrivateOrBlockedIp,
  validateMediaUrl,
  sniffMimeType,
  isAllowedPartMimeType,
  MediaCache,
} from "../packages/ai/src/index.js";

describe("PR-06 Media Security & Fetcher", () => {
  describe("1. SSRF & IP Validation", () => {
    it("identifies IPv4 loopback and private ranges as blocked", () => {
      // Loopback
      expect(isPrivateOrBlockedIp("127.0.0.1")).toBe(true);
      expect(isPrivateOrBlockedIp("127.255.255.254")).toBe(true);
      // RFC1918 Private
      expect(isPrivateOrBlockedIp("10.0.0.1")).toBe(true);
      expect(isPrivateOrBlockedIp("10.254.1.1")).toBe(true);
      expect(isPrivateOrBlockedIp("172.16.0.1")).toBe(true);
      expect(isPrivateOrBlockedIp("172.31.255.255")).toBe(true);
      expect(isPrivateOrBlockedIp("192.168.0.1")).toBe(true);
      expect(isPrivateOrBlockedIp("192.168.100.50")).toBe(true);
      // Link-local & Cloud Metadata
      expect(isPrivateOrBlockedIp("169.254.169.254")).toBe(true);
      expect(isPrivateOrBlockedIp("169.254.1.1")).toBe(true);
      // Broadcast & Current
      expect(isPrivateOrBlockedIp("0.0.0.0")).toBe(true);
      expect(isPrivateOrBlockedIp("255.255.255.255")).toBe(true);
      // Carrier-grade NAT
      expect(isPrivateOrBlockedIp("100.64.0.1")).toBe(true);
    });

    it("identifies IPv6 loopback and private ranges as blocked", () => {
      expect(isPrivateOrBlockedIp("::1")).toBe(true);
      expect(isPrivateOrBlockedIp("::")).toBe(true);
      expect(isPrivateOrBlockedIp("fc00::1")).toBe(true);
      expect(isPrivateOrBlockedIp("fd12:3456:789a::1")).toBe(true);
      expect(isPrivateOrBlockedIp("fe80::1")).toBe(true);
      expect(isPrivateOrBlockedIp("::ffff:127.0.0.1")).toBe(true);
      expect(isPrivateOrBlockedIp("::ffff:10.0.0.1")).toBe(true);
    });

    it("allows valid public IP addresses", () => {
      expect(isPrivateOrBlockedIp("8.8.8.8")).toBe(false);
      expect(isPrivateOrBlockedIp("1.1.1.1")).toBe(false);
      expect(isPrivateOrBlockedIp("157.240.241.35")).toBe(false); // Facebook CDN IP
      expect(isPrivateOrBlockedIp("2606:4700:4700::1111")).toBe(false); // Cloudflare IPv6
    });

    it("validates media URLs and rejects unsafe protocols, hosts, and credentials", () => {
      // Unsafe protocols
      expect(validateMediaUrl("file:///etc/passwd").valid).toBe(false);
      expect(validateMediaUrl("ftp://evil.com/pic.png").valid).toBe(false);
      expect(validateMediaUrl("gopher://evil.com/pic.png").valid).toBe(false);
      expect(validateMediaUrl("javascript:alert(1)").valid).toBe(false);

      // Embedded credentials
      expect(validateMediaUrl("https://user:pass@example.com/pic.jpg").valid).toBe(false);
      expect(validateMediaUrl("https://user:pass@example.com/pic.jpg").reason).toBe("URL_CONTAINS_USER_CREDENTIALS");

      // Blocked hostnames & cloud metadata
      expect(validateMediaUrl("http://localhost/pic.jpg").valid).toBe(false);
      expect(validateMediaUrl("http://localhost.localdomain/pic.jpg").valid).toBe(false);
      expect(validateMediaUrl("http://metadata.google.internal/computeMetadata").valid).toBe(false);
      expect(validateMediaUrl("http://169.254.169.254/latest/meta-data").valid).toBe(false);
      expect(validateMediaUrl("http://internal.service.lan/pic.jpg").valid).toBe(false);

      // Private IPs directly in URL
      expect(validateMediaUrl("https://127.0.0.1/pic.jpg").valid).toBe(false);
      expect(validateMediaUrl("https://192.168.1.10/voice.mp3").valid).toBe(false);
      expect(validateMediaUrl("https://10.0.0.5:8080/image.png").valid).toBe(false);

      // Disallowed ports
      expect(validateMediaUrl("https://cdn.facebook.com:22/pic.jpg").valid).toBe(false);
      expect(validateMediaUrl("https://cdn.facebook.com:3306/pic.jpg").valid).toBe(false);

      // Valid HTTPS URLs
      expect(validateMediaUrl("https://scontent.xx.fbcdn.net/v/t39.1997-6/sample.jpg").valid).toBe(true);
      expect(validateMediaUrl("https://example.com/media/audio.mp3").valid).toBe(true);
    });

    it("handles blob: URLs conditionally based on allowBlob option", () => {
      const blobUrl = "blob:https://facebook.com/12345-6789";
      expect(validateMediaUrl(blobUrl).valid).toBe(false);
      expect(validateMediaUrl(blobUrl, { allowBlob: true }).valid).toBe(true);
    });
  });

  describe("2. MIME Sniffing & Type Verification", () => {
    it("correctly identifies JPEG magic bytes", () => {
      const jpegBuf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
      const result = sniffMimeType(jpegBuf);
      expect(result.isSafe).toBe(true);
      expect(result.mimeType).toBe("image/jpeg");
      expect(result.category).toBe("image");
      expect(isAllowedPartMimeType(result.mimeType!, "IMAGE")).toBe(true);
    });

    it("correctly identifies PNG magic bytes", () => {
      const pngBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
      const result = sniffMimeType(pngBuf);
      expect(result.isSafe).toBe(true);
      expect(result.mimeType).toBe("image/png");
      expect(result.category).toBe("image");
      expect(isAllowedPartMimeType(result.mimeType!, "IMAGE")).toBe(true);
    });

    it("correctly identifies GIF magic bytes", () => {
      const gifBuf = Buffer.from("GIF89a\x01\x00\x01\x00\x80\x00\x00", "latin1");
      const result = sniffMimeType(gifBuf);
      expect(result.isSafe).toBe(true);
      expect(result.mimeType).toBe("image/gif");
      expect(result.category).toBe("image");
    });

    it("correctly identifies WebP magic bytes", () => {
      const webpBuf = Buffer.from("RIFF\x20\x00\x00\x00WEBPVP8 ", "latin1");
      const result = sniffMimeType(webpBuf);
      expect(result.isSafe).toBe(true);
      expect(result.mimeType).toBe("image/webp");
      expect(result.category).toBe("image");
    });

    it("correctly identifies MP3 audio magic bytes", () => {
      const mp3Id3 = Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
      const result = sniffMimeType(mp3Id3);
      expect(result.isSafe).toBe(true);
      expect(result.mimeType).toBe("audio/mpeg");
      expect(result.category).toBe("audio");
      expect(isAllowedPartMimeType(result.mimeType!, "VOICE")).toBe(true);
    });

    it("correctly identifies OGG audio magic bytes", () => {
      const oggBuf = Buffer.from("OggS\x00\x02\x00\x00\x00\x00\x00\x00", "latin1");
      const result = sniffMimeType(oggBuf);
      expect(result.isSafe).toBe(true);
      expect(result.mimeType).toBe("audio/ogg");
      expect(result.category).toBe("audio");
    });

    it("rejects malicious HTML, SVG, and executables pretending to be media", () => {
      const htmlBuf = Buffer.from("<!DOCTYPE html><html><script>alert(1)</script></html>");
      expect(sniffMimeType(htmlBuf).isSafe).toBe(false);
      expect(sniffMimeType(htmlBuf).rejectionReason).toBe("HTML_OR_XML_SCRIPT_REJECTED");

      const svgBuf = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");
      expect(sniffMimeType(svgBuf).isSafe).toBe(false);

      const exeBuf = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]); // MZ header
      expect(sniffMimeType(exeBuf).isSafe).toBe(false);
      expect(sniffMimeType(exeBuf).rejectionReason).toBe("EXECUTABLE_CONTENT_REJECTED");
    });
  });

  describe("3. Media Cache with TTL and Quota Eviction", () => {
    it("stores media items and retrieves them before TTL expiration", () => {
      const cache = new MediaCache({ ttlMs: 1000 });
      const sampleBuf = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

      cache.set({
        mediaRefId: "mref_test_01",
        mimeType: "image/jpeg",
        byteSize: sampleBuf.length,
        buffer: sampleBuf,
        base64: sampleBuf.toString("base64"),
      });

      expect(cache.has("mref_test_01")).toBe(true);
      const retrieved = cache.get("mref_test_01");
      expect(retrieved).toBeDefined();
      expect(retrieved?.mimeType).toBe("image/jpeg");
    });

    it("evicts items when maximum quota is exceeded", () => {
      const cache = new MediaCache({ maxBytesTotal: 100 }); // Small 100-byte quota
      const chunk50 = Buffer.alloc(50, 0xaa);

      cache.set({
        mediaRefId: "item_1",
        mimeType: "image/jpeg",
        byteSize: 50,
        buffer: chunk50,
        base64: chunk50.toString("base64"),
      });

      cache.set({
        mediaRefId: "item_2",
        mimeType: "image/jpeg",
        byteSize: 50,
        buffer: chunk50,
        base64: chunk50.toString("base64"),
      });

      expect(cache.getItemCount()).toBe(2);

      // Adding a 3rd item exceeding 100 bytes total forces eviction of oldest
      cache.set({
        mediaRefId: "item_3",
        mimeType: "image/jpeg",
        byteSize: 50,
        buffer: chunk50,
        base64: chunk50.toString("base64"),
      });

      expect(cache.has("item_1")).toBe(false); // Oldest evicted
      expect(cache.has("item_2")).toBe(true);
      expect(cache.has("item_3")).toBe(true);
    });
  });
});
