export type MediaCategory = "image" | "audio" | "video" | "file" | "unknown";

export interface SniffResult {
  mimeType: string | null;
  category: MediaCategory;
  isSafe: boolean;
  rejectionReason?: string;
}

/**
 * Sniffs the MIME type and safety category of a media buffer by inspecting its magic bytes.
 */
export function sniffMimeType(buffer: Buffer | Uint8Array): SniffResult {
  if (!buffer || buffer.length < 4) {
    return {
      mimeType: null,
      category: "unknown",
      isSafe: false,
      rejectionReason: "BUFFER_TOO_SMALL",
    };
  }

  const len = buffer.length;

  // 1. Unsafe format detection (scripts, HTML, SVG, executables disguised as media)
  // Check for executable header "MZ" (DOS/PE)
  if (buffer[0] === 0x4d && buffer[1] === 0x5a) {
    return {
      mimeType: "application/x-dosexec",
      category: "unknown",
      isSafe: false,
      rejectionReason: "EXECUTABLE_CONTENT_REJECTED",
    };
  }

  // Check for ELF header (0x7F 'E' 'L' 'F')
  if (buffer[0] === 0x7f && buffer[1] === 0x45 && buffer[2] === 0x4c && buffer[3] === 0x46) {
    return {
      mimeType: "application/x-executable",
      category: "unknown",
      isSafe: false,
      rejectionReason: "EXECUTABLE_CONTENT_REJECTED",
    };
  }

  // Check ASCII text prefixes for HTML / XML / SVG / scripts
  const headAscii = Buffer.from(buffer.slice(0, Math.min(len, 256))).toString("latin1").toLowerCase();
  const trimmedHead = headAscii.trimStart();
  if (
    trimmedHead.startsWith("<!doctype html") ||
    trimmedHead.startsWith("<html") ||
    trimmedHead.startsWith("<script") ||
    trimmedHead.startsWith("<?xml") ||
    trimmedHead.startsWith("<svg")
  ) {
    return {
      mimeType: "text/html",
      category: "unknown",
      isSafe: false,
      rejectionReason: "HTML_OR_XML_SCRIPT_REJECTED",
    };
  }

  // 2. IMAGE formats
  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mimeType: "image/jpeg", category: "image", isSafe: true };
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    len >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return { mimeType: "image/png", category: "image", isSafe: true };
  }

  // GIF: GIF87a or GIF89a
  if (
    len >= 6 &&
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x38 &&
    (buffer[4] === 0x37 || buffer[4] === 0x39) &&
    buffer[5] === 0x61
  ) {
    return { mimeType: "image/gif", category: "image", isSafe: true };
  }

  // WebP: RIFF .... WEBP
  if (
    len >= 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return { mimeType: "image/webp", category: "image", isSafe: true };
  }

  // 3. AUDIO formats
  // MP3 with ID3 tag: 'I' 'D' '3' (49 44 33)
  if (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) {
    return { mimeType: "audio/mpeg", category: "audio", isSafe: true };
  }

  // MP3 frame sync word: 11 bits set (FF FB, FF F3, FF F2, FF E3)
  if (
    buffer[0] === 0xff &&
    buffer[1] !== undefined &&
    (buffer[1] & 0xe0) === 0xe0 &&
    (buffer[1] & 0x18) !== 0x08 // MPEG version not reserved
  ) {
    return { mimeType: "audio/mpeg", category: "audio", isSafe: true };
  }

  // Ogg container (Opus / Vorbis): 'O' 'g' 'g' 'S' (4F 67 67 53)
  if (
    len >= 4 &&
    buffer[0] === 0x4f &&
    buffer[1] === 0x67 &&
    buffer[2] === 0x67 &&
    buffer[3] === 0x53
  ) {
    return { mimeType: "audio/ogg", category: "audio", isSafe: true };
  }

  // WAV: RIFF .... WAVE
  if (
    len >= 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x41 &&
    buffer[10] === 0x56 &&
    buffer[11] === 0x45
  ) {
    return { mimeType: "audio/wav", category: "audio", isSafe: true };
  }

  // MP4 / M4A / AAC: offset 4 is 'f' 't' 'y' 'p'
  if (
    len >= 12 &&
    buffer[4] === 0x66 &&
    buffer[5] === 0x74 &&
    buffer[6] === 0x79 &&
    buffer[7] === 0x70
  ) {
    const brand = Buffer.from(buffer.slice(8, 12)).toString("latin1").trim().toLowerCase();
    if (brand === "m4a" || brand === "m4b" || brand === "m4p") {
      return { mimeType: "audio/mp4", category: "audio", isSafe: true };
    }
    if (brand === "isom" || brand === "iso2" || brand === "mp41" || brand === "mp42") {
      return { mimeType: "video/mp4", category: "video", isSafe: true };
    }
    return { mimeType: "video/mp4", category: "video", isSafe: true };
  }

  // ADTS AAC: FF F1 or FF F9
  if (buffer[0] === 0xff && buffer[1] !== undefined && (buffer[1] === 0xf1 || buffer[1] === 0xf9)) {
    return { mimeType: "audio/aac", category: "audio", isSafe: true };
  }

  // WebM / Matroska: 1A 45 DF A3
  if (
    len >= 4 &&
    buffer[0] === 0x1a &&
    buffer[1] === 0x45 &&
    buffer[2] === 0xdf &&
    buffer[3] === 0xa3
  ) {
    const headerStr = Buffer.from(buffer.slice(0, Math.min(len, 64))).toString("latin1");
    if (headerStr.includes("webm")) {
      return { mimeType: "audio/webm", category: "audio", isSafe: true };
    }
    return { mimeType: "video/webm", category: "video", isSafe: true };
  }

  // 4. DOCUMENT & TEXT formats
  // PDF: %PDF- (25 50 44 46 2D)
  if (
    len >= 5 &&
    buffer[0] === 0x25 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x44 &&
    buffer[3] === 0x46 &&
    buffer[4] === 0x2d
  ) {
    return { mimeType: "application/pdf", category: "file", isSafe: true };
  }

  // Text formats: check if buffer is valid UTF-8 without binary control bytes
  let isBinary = false;
  const sampleLen = Math.min(len, 512);
  for (let i = 0; i < sampleLen; i++) {
    const byte = buffer[i];
    if (byte === 0x00 || (byte !== undefined && byte < 0x09 && byte !== 0x0a && byte !== 0x0d)) {
      isBinary = true;
      break;
    }
  }

  if (!isBinary) {
    const sampleStr = Buffer.from(buffer.slice(0, sampleLen)).toString("utf8").trimStart();
    if (sampleStr.startsWith("{") || sampleStr.startsWith("[")) {
      return { mimeType: "application/json", category: "file", isSafe: true };
    }
    if (sampleStr.includes(",") && (sampleStr.includes("\n") || sampleStr.includes("\r"))) {
      return { mimeType: "text/csv", category: "file", isSafe: true };
    }
    return { mimeType: "text/plain", category: "file", isSafe: true };
  }

  return {
    mimeType: null,
    category: "unknown",
    isSafe: false,
    rejectionReason: "UNRECOGNIZED_MEDIA_MAGIC_BYTES",
  };
}

/**
 * Checks if the sniffed MIME type is permissible for the expected message part type.
 */
export function isAllowedPartMimeType(
  mimeType: string,
  partType: "IMAGE" | "VOICE" | "AUDIO" | "VIDEO" | "FILE"
): boolean {
  const cleanMime = mimeType.toLowerCase().trim();

  if (partType === "IMAGE") {
    return [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif",
    ].includes(cleanMime);
  }

  if (partType === "VOICE" || partType === "AUDIO") {
    return [
      "audio/mpeg",
      "audio/mp3",
      "audio/ogg",
      "audio/wav",
      "audio/mp4",
      "audio/m4a",
      "audio/aac",
      "audio/webm",
      "audio/x-m4a",
    ].includes(cleanMime);
  }

  if (partType === "VIDEO") {
    return [
      "video/mp4",
      "video/webm",
      "video/quicktime",
    ].includes(cleanMime);
  }

  if (partType === "FILE") {
    return [
      "text/plain",
      "text/csv",
      "application/csv",
      "application/json",
      "text/json",
      "application/pdf",
    ].includes(cleanMime);
  }

  return false;
}
