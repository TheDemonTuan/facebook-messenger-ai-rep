import { describe, it, expect } from "vitest";
import {
  extractVideoMetadataAndFrames,
  buildChatMessages,
  globalMediaCache,
} from "../packages/ai/src/index.js";
import { SystemSettingsDefaults, type MessagePart } from "../packages/contracts/src/index.js";

describe("PR-07 Media Enrichment: Video Frames, Codecs, and Coverage", () => {
  it("rejects truncated 64-bit MP4 boxes without throwing", async () => {
    const truncated = Buffer.alloc(12);
    truncated.writeUInt32BE(1, 0);
    truncated.write("moov", 4, "latin1");

    await expect(
      extractVideoMetadataAndFrames(truncated, "video/mp4")
    ).resolves.toMatchObject({ success: false, status: "UNSUPPORTED" });
  });

  // Helper to create a minimal MP4 buffer with ftyp and moov boxes
  function createMockMp4Buffer(options: {
    durationMs?: number;
    videoCodec?: string;
    audioCodec?: string;
    size?: number;
  }): Buffer {
    const totalSize = options.size || 512;
    const buf = Buffer.alloc(totalSize);

    // Box 1: ftyp
    buf.writeUInt32BE(20, 0);
    buf.write("ftyp", 4, "latin1");
    buf.write("isom", 8, "latin1");
    buf.writeUInt32BE(512, 12);
    buf.write("mp41", 16, "latin1");

    // Box 2: moov
    const moovOffset = 20;
    const moovSize = totalSize - moovOffset;
    buf.writeUInt32BE(moovSize, moovOffset);
    buf.write("moov", moovOffset + 4, "latin1");

    // Inside moov: mvhd box (timescale=1000, duration)
    const mvhdOffset = moovOffset + 8;
    buf.writeUInt32BE(32, mvhdOffset);
    buf.write("mvhd", mvhdOffset + 4, "latin1");
    buf.writeUInt8(0, mvhdOffset + 8); // version 0
    buf.writeUInt32BE(1000, mvhdOffset + 20); // timescale = 1000
    buf.writeUInt32BE(options.durationMs || 5000, mvhdOffset + 24); // duration in units

    // Inside moov: trak box (vide)
    const trakOffset = mvhdOffset + 32;
    const trakSize = 64;
    buf.writeUInt32BE(trakSize, trakOffset);
    buf.write("trak", trakOffset + 4, "latin1");
    buf.write("vide", trakOffset + 12, "latin1");
    buf.write(options.videoCodec || "avc1", trakOffset + 20, "latin1");

    if (options.audioCodec) {
      const audioTrakOffset = trakOffset + trakSize;
      if (audioTrakOffset + 64 <= totalSize) {
        buf.writeUInt32BE(64, audioTrakOffset);
        buf.write("trak", audioTrakOffset + 4, "latin1");
        buf.write("soun", audioTrakOffset + 12, "latin1");
        buf.write(options.audioCodec, audioTrakOffset + 20, "latin1");
      }
    }

    return buf;
  }

  it("accepts valid MP4 with approved codecs (avc1/mp4a) and extracts coverage", async () => {
    const mockMp4 = createMockMp4Buffer({
      durationMs: 15000, // 15 seconds
      videoCodec: "avc1",
      audioCodec: "mp4a",
    });

    const posterBuffer = Buffer.from("fake_poster_jpeg_content_12345");

    const result = await extractVideoMetadataAndFrames(mockMp4, "video/mp4", {
      maxBytes: 10 * 1024 * 1024,
      maxDurationSec: 60,
      posterBuffer,
      posterUrl: "https://cdn.example.com/poster.jpg",
    });

    expect(result.success).toBe(true);
    expect(result.status).toBe("READY");
    expect(result.coverage.container).toBe("video/mp4");
    expect(result.coverage.hasVideoTrack).toBe(true);
    expect(result.coverage.durationMs).toBe(15000);
    expect(result.coverage.framesExtracted).toBe(1);
    expect(result.posterMediaRefId).toBeDefined();
    expect(result.coverage.coverageStatus).toBe("POSTER_ONLY");
    expect(result.coverage.limitationReason).toContain("khung hình đại diện");

    // Verify poster is stored in global media cache
    const cachedPoster = globalMediaCache.get(result.posterMediaRefId!);
    expect(cachedPoster).toBeDefined();
    expect(cachedPoster?.mimeType).toBe("image/jpeg");
  });

  it("rejects unsupported video containers outside allowlist", async () => {
    const fakeAvi = Buffer.from("RIFF....AVI ");
    const result = await extractVideoMetadataAndFrames(fakeAvi, "video/x-msvideo");

    expect(result.success).toBe(false);
    expect(result.status).toBe("UNSUPPORTED");
    expect(result.coverage.coverageStatus).toBe("UNSUPPORTED");
    expect(result.coverage.limitationReason).toContain("outside permitted video containers");
  });

  it("rejects videos with disallowed/unsupported codecs (e.g. HEVC/H.265)", async () => {
    const hevcMp4 = createMockMp4Buffer({
      durationMs: 10000,
      videoCodec: "hevc",
    });

    const result = await extractVideoMetadataAndFrames(hevcMp4, "video/mp4");

    expect(result.success).toBe(false);
    expect(result.status).toBe("UNSUPPORTED");
    expect(result.coverage.coverageStatus).toBe("UNSUPPORTED");
    expect(result.coverage.limitationReason).toContain("UNSUPPORTED_CODEC");
  });

  it("rejects videos exceeding maximum allowed duration", async () => {
    const longMp4 = createMockMp4Buffer({
      durationMs: 120000, // 120 seconds
      videoCodec: "avc1",
    });

    const result = await extractVideoMetadataAndFrames(longMp4, "video/mp4", {
      maxDurationSec: 60, // cap is 60s
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe("UNSUPPORTED");
    expect(result.coverage.coverageStatus).toBe("UNSUPPORTED");
    expect(result.coverage.limitationReason).toContain("EXCEEDED_MAX_DURATION");
  });

  it("rejects videos exceeding maximum byte size", async () => {
    const largeMp4 = createMockMp4Buffer({
      size: 2048,
    });

    const result = await extractVideoMetadataAndFrames(largeMp4, "video/mp4", {
      maxBytes: 1024, // cap is 1024 bytes
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe("UNSUPPORTED");
    expect(result.coverage.coverageStatus).toBe("UNSUPPORTED");
    expect(result.error).toBe("MAX_SIZE_EXCEEDED");
  });

  it("formats persona prompt with video coverage caveats and does not hallucinate full video", () => {
    // Put a test poster in cache
    const testPosterRef = "mref_test_poster_01";
    globalMediaCache.set({
      mediaRefId: testPosterRef,
      mimeType: "image/jpeg",
      byteSize: 100,
      buffer: Buffer.from("poster"),
      base64: "cG9zdGVy",
    });

    const videoPart: MessagePart = {
      type: "VIDEO",
      media: {
        mediaId: "vid_01",
        role: "ATTACHMENT",
        status: "READY",
      },
      posterRef: testPosterRef,
      durationMs: 12000,
      coverage: {
        container: "video/mp4",
        codecs: ["avc1"],
        durationMs: 12000,
        hasVideoTrack: true,
        hasAudioTrack: false,
        framesExtracted: 1,
        audioExtracted: false,
        coverageStatus: "POSTER_ONLY",
      },
    };

    const prompt = buildChatMessages(
      {
        conversationId: "conv-1",
        customerName: "Khách",
        recentMessages: [
          {
            direction: "INBOUND",
            text: "",
            parts: [videoPart],
            timestamp: new Date(),
          },
        ],
        settings: SystemSettingsDefaults,
      },
      {
        capabilities: {
          text: true,
          imageInput: true,
          audioInput: false,
          audioTranscription: false,
          videoInput: false,
          structuredOutput: true,
        },
      }
    );

    const userMessage = prompt.find((m) => m.role === "user");
    expect(userMessage).toBeDefined();

    // Check that user message has image block for poster
    const content = userMessage!.content;
    expect(Array.isArray(content)).toBe(true);
    const contentArray = content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    const textPart = contentArray.find((p) => p.type === "text");
    const imagePart = contentArray.find((p) => p.type === "image_url");

    expect(imagePart).toBeDefined();
    expect(imagePart?.image_url?.url).toContain("cG9zdGVy");
    expect(textPart?.text).toContain("KHÔNG đại diện cho toàn bộ nội dung chuyển động");
    expect(textPart?.text).toContain("12s");
  });
});
