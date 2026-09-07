import type { ContentStatus } from "@messenger/contracts";

export interface FileExtractionOptions {
  maxBytes?: number;
  maxExtractedChars?: number;
}

export interface FileExtractionResult {
  success: boolean;
  status: ContentStatus;
  mimeType: string;
  extractedText?: string;
  characterCount?: number;
  error?: string;
}

const ALLOWED_FILE_MIMES = new Set([
  "text/plain",
  "text/csv",
  "application/csv",
  "application/json",
  "text/json",
]);

/**
 * Strips terminal ANSI escape sequences, null bytes, and dangerous control characters.
 * Preserves common whitespace: newlines (\n, \r) and tabs (\t).
 */
export function sanitizeTextContent(input: string): string {
  if (!input) return "";
  // 1. Remove ANSI escape sequences
  // eslint-disable-next-line no-control-regex
  let cleaned = input.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
  // 2. Remove null bytes and C0 control characters except \t (0x09), \n (0x0A), \r (0x0D)
  // eslint-disable-next-line no-control-regex
  cleaned = cleaned.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  return cleaned;
}

/**
 * Safely parses CSV lines and limits rows and columns to prevent denial-of-service.
 */
function parseCsvSafely(rawCsv: string, maxRows = 100, maxCols = 20): string {
  const sanitized = sanitizeTextContent(rawCsv);
  const lines = sanitized.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const outputRows: string[] = [];

  const rowLimit = Math.min(lines.length, maxRows);
  for (let r = 0; r < rowLimit; r++) {
    const rawLine = lines[r]!;
    // Basic CSV cell extraction respecting quotes
    const cells: string[] = [];
    let currentCell = "";
    let inQuotes = false;

    for (let c = 0; c < rawLine.length; c++) {
      const char = rawLine[c];
      if (char === '"') {
        if (inQuotes && rawLine[c + 1] === '"') {
          currentCell += '"';
          c++; // skip escaped quote
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === "," && !inQuotes) {
        cells.push(currentCell.trim());
        currentCell = "";
        if (cells.length >= maxCols) break;
      } else {
        currentCell += char;
      }
    }
    if (cells.length < maxCols) {
      cells.push(currentCell.trim());
    }

    // Neutralize formula injection risk: prefix with quote if cell starts with =, +, -, @
    const safeCells = cells.slice(0, maxCols).map((cell) => {
      if (/^[=+\-@]/.test(cell)) {
        return `'${cell}`;
      }
      return cell;
    });

    outputRows.push(safeCells.join(" | "));
  }

  if (lines.length > maxRows) {
    outputRows.push(`... [còn ${lines.length - maxRows} dòng bị cắt bớt để bảo đảm an toàn]`);
  }

  return outputRows.join("\n");
}

/**
 * Safely parses and summarizes JSON data without prototype pollution.
 */
function parseJsonSafely(rawJson: string, maxChars: number): string {
  const sanitized = sanitizeTextContent(rawJson);
  if (sanitized.length > maxChars * 4) {
    throw new Error("JSON_PAYLOAD_TOO_LARGE");
  }

  const parsed = JSON.parse(sanitized, (key, value) => {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      return undefined;
    }
    return value;
  });

  const formatted = JSON.stringify(parsed, null, 2);
  return formatted;
}

/**
 * Extracts text from an allowable file within strict sandbox boundaries and character limits.
 * Unsupported or dangerous files are explicitly flagged with UNSUPPORTED or ERROR status.
 */
export function extractFileTextSafely(
  buffer: Buffer | Uint8Array,
  mimeTypeOrFileName: string,
  options: FileExtractionOptions = {}
): FileExtractionResult {
  const maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
  const maxExtractedChars = options.maxExtractedChars ?? 10000;

  if (!buffer || buffer.length === 0) {
    return {
      success: false,
      status: "UNAVAILABLE",
      mimeType: mimeTypeOrFileName,
      error: "EMPTY_FILE_BUFFER",
    };
  }

  if (buffer.length > maxBytes) {
    return {
      success: false,
      status: "UNSUPPORTED",
      mimeType: mimeTypeOrFileName,
      error: `FILE_SIZE_EXCEEDED: Size ${buffer.length} exceeds limit ${maxBytes}`,
    };
  }

  // 1. Check for PDF header (%PDF-)
  const isPdf =
    buffer.length >= 4 &&
    buffer[0] === 0x25 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x44 &&
    buffer[3] === 0x46;

  const normalizedMime = mimeTypeOrFileName.toLowerCase().trim();
  if (isPdf || normalizedMime === "application/pdf" || normalizedMime.endsWith(".pdf")) {
    return {
      success: false,
      status: "UNSUPPORTED",
      mimeType: "application/pdf",
      error: "PDF_PARSER_NOT_AVAILABLE: PDF text extraction is currently unsupported without heavy external dependencies.",
    };
  }

  // 2. Determine effective MIME type
  let effectiveMime = "text/plain";
  if (normalizedMime.includes("json") || normalizedMime.endsWith(".json")) {
    effectiveMime = "application/json";
  } else if (normalizedMime.includes("csv") || normalizedMime.endsWith(".csv")) {
    effectiveMime = "text/csv";
  } else if (normalizedMime.includes("text/plain") || normalizedMime.endsWith(".txt")) {
    effectiveMime = "text/plain";
  } else if (ALLOWED_FILE_MIMES.has(normalizedMime)) {
    effectiveMime = normalizedMime;
  } else {
    return {
      success: false,
      status: "UNSUPPORTED",
      mimeType: mimeTypeOrFileName,
      error: `DISALLOWED_FILE_TYPE: File format '${mimeTypeOrFileName}' is not in the text extraction allowlist.`,
    };
  }

  // 3. Extract text according to format within sandbox limits
  try {
    const rawUtf8 = Buffer.isBuffer(buffer) ? buffer.toString("utf8") : Buffer.from(buffer).toString("utf8");

    let extracted = "";
    if (effectiveMime === "application/json" || effectiveMime === "text/json") {
      extracted = parseJsonSafely(rawUtf8, maxExtractedChars);
    } else if (effectiveMime === "text/csv" || effectiveMime === "application/csv") {
      extracted = parseCsvSafely(rawUtf8);
    } else {
      extracted = sanitizeTextContent(rawUtf8);
    }

    if (extracted.length > maxExtractedChars) {
      extracted = extracted.slice(0, maxExtractedChars) + "\n... [Nội dung đã được cắt bớt do vượt quá giới hạn an toàn]";
    }

    return {
      success: true,
      status: "READY",
      mimeType: effectiveMime,
      extractedText: extracted,
      characterCount: extracted.length,
    };
  } catch (err) {
    return {
      success: false,
      status: "UNAVAILABLE",
      mimeType: effectiveMime,
      error: `EXTRACTION_FAILED: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
