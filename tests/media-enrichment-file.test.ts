import { describe, it, expect } from "vitest";
import {
  extractFileTextSafely,
  sanitizeTextContent,
  buildChatMessages,
} from "../packages/ai/src/index.js";
import { SystemSettingsDefaults, type MessagePart } from "../packages/contracts/src/index.js";

describe("PR-07 Media Enrichment: Safe File Text Extraction", () => {
  it("extracts and sanitizes plain text files", () => {
    const rawText = "Xin chào shop,\nTôi muốn hỏi giá sản phẩm này.\n\x1B[31mError message\x1B[0m\x00";
    const buffer = Buffer.from(rawText, "utf8");

    const result = extractFileTextSafely(buffer, "notes.txt");

    expect(result.success).toBe(true);
    expect(result.status).toBe("READY");
    expect(result.mimeType).toBe("text/plain");
    expect(result.extractedText).toContain("Xin chào shop");
    expect(result.extractedText).toContain("Error message");
    // Ensure ANSI escapes and null byte were stripped
    expect(result.extractedText).not.toContain("\x1B[31m");
    expect(result.extractedText).not.toContain("\x00");
  });

  it("sanitizeTextContent directly strips ANSI and control codes", () => {
    const cleaned = sanitizeTextContent("\x1B[32mOK\x1B[0m\x00\x07Hello");
    expect(cleaned).toBe("OKHello");
  });

  it("safely extracts CSV files and neutralizes formula injection", () => {
    const csvContent = "Tên,Giá,Công thức\nÁo thun,150000,=CMD|' /C calc'!A0\nQuần jeans,350000,@SUM(1+2)";
    const buffer = Buffer.from(csvContent, "utf8");

    const result = extractFileTextSafely(buffer, "products.csv");

    expect(result.success).toBe(true);
    expect(result.status).toBe("READY");
    expect(result.mimeType).toBe("text/csv");
    expect(result.extractedText).toContain("Áo thun | 150000");
    // Formula prefixes should be neutralized with quote
    expect(result.extractedText).toContain("'=CMD|");
    expect(result.extractedText).toContain("'@SUM(1+2)");
  });

  it("safely extracts JSON files and protects against prototype pollution", () => {
    const jsonContent = JSON.stringify({
      orderId: "ORD-12345",
      product: "Tai nghe bluetooth",
      price: 250000,
      __proto__: { isAdmin: true },
    });
    const buffer = Buffer.from(jsonContent, "utf8");

    const result = extractFileTextSafely(buffer, "order.json");

    expect(result.success).toBe(true);
    expect(result.status).toBe("READY");
    expect(result.mimeType).toBe("application/json");
    expect(result.extractedText).toContain("ORD-12345");
    expect(result.extractedText).toContain("Tai nghe bluetooth");
    // Prototype pollution key must be stripped
    expect(result.extractedText).not.toContain("isAdmin");
  });

  it("explicitly marks PDF files as UNSUPPORTED when no PDF parser dependency exists", () => {
    const fakePdf = Buffer.from("%PDF-1.5 fake pdf content stream endstream");

    const result = extractFileTextSafely(fakePdf, "contract.pdf");

    expect(result.success).toBe(false);
    expect(result.status).toBe("UNSUPPORTED");
    expect(result.mimeType).toBe("application/pdf");
    expect(result.error).toContain("PDF_PARSER_NOT_AVAILABLE");
  });

  it("rejects binary and executable files outside allowlist as UNSUPPORTED", () => {
    // DOS header MZ
    const fakeExe = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);

    const result = extractFileTextSafely(fakeExe, "setup.exe");

    expect(result.success).toBe(false);
    expect(result.status).toBe("UNSUPPORTED");
    expect(result.error).toContain("DISALLOWED_FILE_TYPE");
  });

  it("truncates files exceeding maximum character limit", () => {
    const longText = "A".repeat(5000);
    const buffer = Buffer.from(longText, "utf8");

    const result = extractFileTextSafely(buffer, "long.txt", {
      maxExtractedChars: 1000,
    });

    expect(result.success).toBe(true);
    expect(result.status).toBe("READY");
    expect(result.extractedText!.length).toBeLessThan(1200);
    expect(result.extractedText).toContain("cắt bớt do vượt quá giới hạn");
  });

  it("formats persona prompt with extracted file text and provenance label", () => {
    const filePart: MessagePart = {
      type: "FILE",
      media: {
        mediaId: "file_01",
        role: "ATTACHMENT",
        status: "READY",
      },
      fileName: "danh_sach_dat_hang.txt",
      byteSize: 1024,
      extractedText: "Khách đặt 2 hộp khẩu trang, giao buổi chiều.",
    };

    const prompt = buildChatMessages({
      conversationId: "conv-1",
      customerName: "Khách",
      recentMessages: [
        {
          direction: "INBOUND",
          text: "",
          parts: [filePart],
          timestamp: new Date(),
        },
      ],
      settings: SystemSettingsDefaults,
    });

    const userMessage = prompt.find((m) => m.role === "user");
    expect(userMessage).toBeDefined();
    const content = userMessage!.content as string;
    expect(content).toContain('Nội dung trích xuất từ tệp tin "danh_sach_dat_hang.txt"');
    expect(content).toContain("Khách đặt 2 hộp khẩu trang, giao buổi chiều.");
  });
});
