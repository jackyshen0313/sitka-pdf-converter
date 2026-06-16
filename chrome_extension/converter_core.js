(function attachSitkaPdfCore(root, factory) {
  root.SitkaPdfCore = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function createSitkaPdfCore() {
  "use strict";

  const DEFAULTS = Object.freeze({
    bodyFont: "Sitka Text",
    headingFont: "Sitka Heading",
    paperSize: "a4",
    fontSize: 16,
    margin: 36,
    lineHeight: "1.35",
    maxInputBytes: 150 * 1024 * 1024,
    maxFileCount: 4000,
    maxUncompressedBytes: 260 * 1024 * 1024,
    maxReadableCharacters: 8 * 1024 * 1024
  });

  const PAPER_SIZES = new Set([
    "a0", "a1", "a2", "a3", "a4", "a5", "a6",
    "b0", "b1", "b2", "b3", "b4", "b5", "b6",
    "legal", "letter"
  ]);

  class UserFacingError extends Error {
    constructor(message) {
      super(message);
      this.name = "UserFacingError";
    }
  }

  function asArrayBuffer(input) {
    if (input instanceof ArrayBuffer) return input;
    if (ArrayBuffer.isView(input)) {
      return input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
    }
    throw new UserFacingError("Expected binary EPUB data.");
  }

  function getUint16(view, offset) {
    return view.getUint16(offset, true);
  }

  function getUint32(view, offset) {
    return view.getUint32(offset, true);
  }

  function getUint16BE(view, offset) {
    return view.getUint16(offset, false);
  }

  function getUint32BE(view, offset) {
    return view.getUint32(offset, false);
  }

  function decodeUtf8(bytes) {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }

  function decodeAscii(bytes) {
    return new TextDecoder("ascii", { fatal: false }).decode(bytes);
  }

  function decodeMobiText(bytes, encoding) {
    let label = "windows-1252";
    if (encoding === 65001) {
      label = "utf-8";
    } else if (encoding === 1252 || encoding === 0) {
      label = "windows-1252";
    } else if (encoding === 1200) {
      label = "utf-16le";
    }
    return new TextDecoder(label, { fatal: false }).decode(bytes);
  }

  function detectFileKind(file) {
    const name = String(file && file.name ? file.name : "").toLowerCase();
    if (name.endsWith(".epub")) return "epub";
    if (name.endsWith(".mobi")) return "mobi";
    if (file && file.type === "application/epub+zip") return "epub";
    if (file && /mobipocket|x-mobi/i.test(file.type || "")) return "mobi";
    return "unknown";
  }

  function humanBytes(bytes) {
    const value = Number(bytes || 0);
    if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
    if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${value} B`;
  }

  function normalizeZipPath(path) {
    const raw = String(path || "").replace(/\\/g, "/");
    if (!raw || raw.includes("\0")) {
      throw new UserFacingError("The EPUB contains an invalid empty path.");
    }
    if (/^[a-z]+:/i.test(raw) || raw.startsWith("/")) {
      throw new UserFacingError(`Unsafe absolute EPUB path rejected: ${raw}`);
    }

    const parts = [];
    for (const part of raw.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") {
        throw new UserFacingError(`Unsafe parent-directory EPUB path rejected: ${raw}`);
      }
      parts.push(part);
    }
    if (!parts.length) {
      throw new UserFacingError("The EPUB contains an invalid empty path.");
    }
    return parts.join("/");
  }

  function joinZipPath(basePath, href) {
    const cleanHref = String(href || "").split("#")[0].split("?")[0];
    let decoded = cleanHref;
    try {
      decoded = decodeURIComponent(cleanHref);
    } catch {
      decoded = cleanHref;
    }
    const base = String(basePath || "");
    const baseDir = base.includes("/") ? base.slice(0, base.lastIndexOf("/")) : "";
    return normalizeZipPath(baseDir ? `${baseDir}/${decoded}` : decoded);
  }

  function findEndOfCentralDirectory(bytes, view) {
    const minOffset = Math.max(0, bytes.length - 22 - 0xffff);
    for (let offset = bytes.length - 22; offset >= minOffset; offset -= 1) {
      if (getUint32(view, offset) === 0x06054b50) {
        return offset;
      }
    }
    throw new UserFacingError("This file is not a readable EPUB/ZIP file.");
  }

  function parseZipArchive(input, limits = {}) {
    const buffer = asArrayBuffer(input);
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    if (bytes.length < 22) {
      throw new UserFacingError("This file is too small to be a valid EPUB.");
    }

    const eocdOffset = findEndOfCentralDirectory(bytes, view);
    const diskNumber = getUint16(view, eocdOffset + 4);
    const centralDirectoryDisk = getUint16(view, eocdOffset + 6);
    const entryCount = getUint16(view, eocdOffset + 10);
    const centralDirectorySize = getUint32(view, eocdOffset + 12);
    const centralDirectoryOffset = getUint32(view, eocdOffset + 16);
    const maxFileCount = limits.maxFileCount || DEFAULTS.maxFileCount;
    const maxUncompressedBytes = limits.maxUncompressedBytes || DEFAULTS.maxUncompressedBytes;

    if (diskNumber !== 0 || centralDirectoryDisk !== 0) {
      throw new UserFacingError("Multi-disk ZIP/EPUB files are not supported.");
    }
    if (entryCount > maxFileCount) {
      throw new UserFacingError(`The EPUB has too many files (${entryCount}).`);
    }
    if (centralDirectoryOffset + centralDirectorySize > bytes.length) {
      throw new UserFacingError("The EPUB central directory is corrupt.");
    }

    const entries = new Map();
    const lowerCaseIndex = new Map();
    let offset = centralDirectoryOffset;
    let totalUncompressedBytes = 0;

    for (let index = 0; index < entryCount; index += 1) {
      if (offset + 46 > bytes.length || getUint32(view, offset) !== 0x02014b50) {
        throw new UserFacingError("The EPUB central directory is corrupt.");
      }

      const flags = getUint16(view, offset + 8);
      const method = getUint16(view, offset + 10);
      const compressedSize = getUint32(view, offset + 20);
      const uncompressedSize = getUint32(view, offset + 24);
      const fileNameLength = getUint16(view, offset + 28);
      const extraLength = getUint16(view, offset + 30);
      const commentLength = getUint16(view, offset + 32);
      const localHeaderOffset = getUint32(view, offset + 42);
      const nameStart = offset + 46;
      const nameEnd = nameStart + fileNameLength;

      if (nameEnd + extraLength + commentLength > bytes.length) {
        throw new UserFacingError("The EPUB central directory entry is corrupt.");
      }
      if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
        throw new UserFacingError("ZIP64 EPUB files are not supported in this browser-only build.");
      }
      if (flags & 0x0001) {
        throw new UserFacingError("Encrypted or DRM-protected EPUB entries are not supported.");
      }
      if (method !== 0 && method !== 8) {
        throw new UserFacingError(`Unsupported ZIP compression method: ${method}`);
      }

      const rawName = decodeUtf8(bytes.slice(nameStart, nameEnd));
      if (!rawName.endsWith("/")) {
        const path = normalizeZipPath(rawName);
        if (entries.has(path)) {
          throw new UserFacingError(`Duplicate EPUB path rejected: ${path}`);
        }
        totalUncompressedBytes += uncompressedSize;
        if (totalUncompressedBytes > maxUncompressedBytes) {
          throw new UserFacingError(`The EPUB is too large after decompression, above ${humanBytes(maxUncompressedBytes)}.`);
        }
        entries.set(path, {
          path,
          flags,
          method,
          compressedSize,
          uncompressedSize,
          localHeaderOffset
        });
        lowerCaseIndex.set(path.toLowerCase(), path);
      }

      offset = nameEnd + extraLength + commentLength;
    }

    return {
      entries,
      has(path) {
        const normalized = normalizeZipPath(path);
        return entries.has(normalized) || lowerCaseIndex.has(normalized.toLowerCase());
      },
      getEntry(path) {
        const normalized = normalizeZipPath(path);
        return entries.get(normalized) || entries.get(lowerCaseIndex.get(normalized.toLowerCase()));
      },
      async getBytes(path) {
        const entry = this.getEntry(path);
        if (!entry) {
          throw new UserFacingError(`Missing EPUB file: ${path}`);
        }
        return inflateEntry(buffer, view, entry);
      },
      async getText(path) {
        return decodeUtf8(await this.getBytes(path));
      }
    };
  }

  function parsePalmDatabase(input, limits = {}) {
    const buffer = asArrayBuffer(input);
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    const maxFileCount = limits.maxFileCount || DEFAULTS.maxFileCount;

    if (bytes.length < 86) {
      throw new UserFacingError("This file is too small to be a valid MOBI/Palm database.");
    }

    const name = decodeMobiText(bytes.slice(0, 32), 1252).replace(/\0[\s\S]*$/, "").trim();
    const type = decodeAscii(bytes.slice(60, 64));
    const creator = decodeAscii(bytes.slice(64, 68));
    const recordCount = getUint16BE(view, 76);
    const recordTableEnd = 78 + recordCount * 8;

    if (recordCount < 2) {
      throw new UserFacingError("The MOBI file has no readable text records.");
    }
    if (recordCount > maxFileCount) {
      throw new UserFacingError(`The MOBI file has too many records (${recordCount}).`);
    }
    if (recordTableEnd > bytes.length) {
      throw new UserFacingError("The MOBI record table is corrupt.");
    }

    const offsets = [];
    for (let index = 0; index < recordCount; index += 1) {
      const offset = getUint32BE(view, 78 + index * 8);
      if (offset < recordTableEnd || offset > bytes.length) {
        throw new UserFacingError("The MOBI record offsets are corrupt.");
      }
      if (index > 0 && offset < offsets[index - 1]) {
        throw new UserFacingError("The MOBI record offsets are not ordered.");
      }
      offsets.push(offset);
    }

    const records = offsets.map((offset, index) => {
      const end = index + 1 < offsets.length ? offsets[index + 1] : bytes.length;
      return bytes.slice(offset, end);
    });

    return {
      name,
      type,
      creator,
      records
    };
  }

  function decompressPalmDocRecord(record) {
    const out = [];
    for (let index = 0; index < record.length; index += 1) {
      const value = record[index];
      if (value === 0 || (value >= 0x09 && value <= 0x7f)) {
        out.push(value);
      } else if (value >= 0x01 && value <= 0x08) {
        const literalEnd = Math.min(record.length, index + 1 + value);
        for (index += 1; index < literalEnd; index += 1) {
          out.push(record[index]);
        }
        index -= 1;
      } else if (value >= 0x80 && value <= 0xbf) {
        if (index + 1 >= record.length) {
          throw new UserFacingError("The MOBI PalmDOC compressed data is truncated.");
        }
        const next = record[index + 1];
        index += 1;
        const distance = ((value & 0x3f) << 5) | (next >> 3);
        const length = (next & 0x07) + 3;
        if (distance <= 0 || distance > out.length) {
          throw new UserFacingError("The MOBI PalmDOC back-reference is corrupt.");
        }
        for (let copyIndex = 0; copyIndex < length; copyIndex += 1) {
          out.push(out[out.length - distance]);
        }
      } else {
        out.push(0x20, value ^ 0x80);
      }
    }
    return new Uint8Array(out);
  }

  function decompressMobiTextRecord(record, compression) {
    if (compression === 1) return record;
    if (compression === 2) {
      let lastError;
      const maxTrim = Math.min(128, Math.max(0, record.length - 1));
      for (let trim = 0; trim <= maxTrim; trim += 1) {
        try {
          return decompressPalmDocRecord(trim ? record.slice(0, record.length - trim) : record);
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError;
    }
    if (compression === 17480) {
      throw new UserFacingError("HUFF/CDIC-compressed MOBI files are not supported in the browser-only build. Convert the book to EPUB first.");
    }
    throw new UserFacingError(`Unsupported MOBI compression type: ${compression}`);
  }

  function concatUint8Arrays(chunks, maxBytes = DEFAULTS.maxUncompressedBytes) {
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    if (total > maxBytes) {
      throw new UserFacingError(`The book is too large after decompression, above ${humanBytes(maxBytes)}.`);
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  function readMobiTitle(record0, encoding, fallback) {
    if (record0.length >= 108) {
      const view = new DataView(record0.buffer, record0.byteOffset, record0.byteLength);
      const titleOffset = getUint32BE(view, 100);
      const titleLength = getUint32BE(view, 104);
      if (titleLength > 0 && titleOffset >= 0 && titleOffset + titleLength <= record0.length) {
        const title = decodeMobiText(record0.slice(titleOffset, titleOffset + titleLength), encoding)
          .replace(/\0/g, "")
          .trim();
        if (title) return title;
      }
    }
    return fallback || "";
  }

  function parseMobiExth(record0, encoding) {
    const metadata = {
      creators: [],
      title: "",
      language: ""
    };
    if (record0.length < 32) return metadata;

    const view = new DataView(record0.buffer, record0.byteOffset, record0.byteLength);
    const mobiBase = 16;
    if (decodeAscii(record0.slice(mobiBase, mobiBase + 4)) !== "MOBI") {
      return metadata;
    }
    const mobiLength = getUint32BE(view, mobiBase + 4);
    const exthOffset = mobiBase + mobiLength;
    if (exthOffset + 12 > record0.length || decodeAscii(record0.slice(exthOffset, exthOffset + 4)) !== "EXTH") {
      return metadata;
    }

    const exthLength = getUint32BE(view, exthOffset + 4);
    const exthCount = getUint32BE(view, exthOffset + 8);
    let offset = exthOffset + 12;
    const exthEnd = Math.min(record0.length, exthOffset + exthLength);

    for (let index = 0; index < exthCount && offset + 8 <= exthEnd; index += 1) {
      const type = getUint32BE(view, offset);
      const length = getUint32BE(view, offset + 4);
      if (length < 8 || offset + length > exthEnd) break;
      const text = decodeMobiText(record0.slice(offset + 8, offset + length), encoding)
        .replace(/\0/g, "")
        .trim();
      if (text) {
        if (type === 100) metadata.creators.push(text);
        if (type === 503) metadata.title = text;
        if (type === 524) metadata.language = text;
      }
      offset += length;
    }

    return metadata;
  }

  function parseMobiHeader(input, limits = {}) {
    const pdb = parsePalmDatabase(input, limits);
    const record0 = pdb.records[0];
    if (!record0 || record0.length < 32) {
      throw new UserFacingError("The MOBI header record is missing or corrupt.");
    }

    const view = new DataView(record0.buffer, record0.byteOffset, record0.byteLength);
    const compression = getUint16BE(view, 0);
    const textLength = getUint32BE(view, 4);
    const textRecordCount = getUint16BE(view, 8);
    const encryptionType = getUint16BE(view, 12);
    const mobiBase = 16;

    if (encryptionType !== 0) {
      throw new UserFacingError("Encrypted or DRM-protected MOBI files are not supported.");
    }
    if (decodeAscii(record0.slice(mobiBase, mobiBase + 4)) !== "MOBI") {
      throw new UserFacingError("MOBI header not found. Plain PalmDOC files are not supported in this build.");
    }

    const mobiLength = getUint32BE(view, mobiBase + 4);
    const encoding = record0.length >= mobiBase + 16 ? getUint32BE(view, mobiBase + 12) : 1252;
    const fallbackTitle = pdb.name;
    const exth = parseMobiExth(record0, encoding);
    const title = exth.title || readMobiTitle(record0, encoding, fallbackTitle) || fallbackTitle;

    return {
      pdb,
      compression,
      textLength,
      textRecordCount,
      mobiLength,
      encoding,
      metadata: {
        title,
        creators: exth.creators,
        language: exth.language
      }
    };
  }

  async function inflateEntry(buffer, view, entry) {
    const localOffset = entry.localHeaderOffset;
    if (localOffset + 30 > buffer.byteLength || getUint32(view, localOffset) !== 0x04034b50) {
      throw new UserFacingError(`The EPUB local file header is corrupt: ${entry.path}`);
    }
    const localNameLength = getUint16(view, localOffset + 26);
    const localExtraLength = getUint16(view, localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataOffset + entry.compressedSize;
    if (dataEnd > buffer.byteLength) {
      throw new UserFacingError(`The EPUB compressed data is corrupt: ${entry.path}`);
    }

    const compressed = new Uint8Array(buffer.slice(dataOffset, dataEnd));
    if (entry.method === 0) {
      return compressed;
    }

    if (typeof DecompressionStream !== "function" || typeof Blob !== "function" || typeof Response !== "function") {
      throw new UserFacingError("Compressed EPUB files require the browser DecompressionStream API.");
    }

    try {
      const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      const inflated = new Uint8Array(await new Response(stream).arrayBuffer());
      if (entry.uncompressedSize !== 0 && inflated.length !== entry.uncompressedSize) {
        throw new Error("Inflated size mismatch.");
      }
      return inflated;
    } catch (error) {
      throw new UserFacingError(`Could not decompress EPUB file ${entry.path}: ${error.message}`);
    }
  }

  function decodeXmlEntities(text) {
    return String(text || "")
      .replace(/&#x([0-9a-f]+);/gi, (_, value) => String.fromCodePoint(parseInt(value, 16)))
      .replace(/&#([0-9]+);/g, (_, value) => String.fromCodePoint(parseInt(value, 10)))
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, "\"")
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&");
  }

  function parseAttributes(fragment) {
    const attrs = {};
    const re = /([\w:.-]+)\s*=\s*(["'])([\s\S]*?)\2/g;
    let match;
    while ((match = re.exec(fragment))) {
      attrs[match[1]] = decodeXmlEntities(match[3]);
    }
    return attrs;
  }

  function stripTags(fragment) {
    return decodeXmlEntities(String(fragment || "").replace(/<[^>]+>/g, ""))
      .replace(/\s+/g, " ")
      .trim();
  }

  function findAllElementText(xml, localName) {
    const values = [];
    const re = new RegExp(`<(?:[\\w.-]+:)?${localName}\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${localName}>`, "gi");
    let match;
    while ((match = re.exec(xml))) {
      const text = stripTags(match[1]);
      if (text) values.push(text);
    }
    return values;
  }

  function parseContainerXml(xml) {
    const rootfiles = [];
    const re = /<rootfile\b([^>]*)\/?>/gi;
    let match;
    while ((match = re.exec(xml))) {
      const attrs = parseAttributes(match[1]);
      if (attrs["full-path"]) {
        rootfiles.push(attrs);
      }
    }
    if (!rootfiles.length) {
      throw new UserFacingError("EPUB container.xml does not point to a package document.");
    }
    const preferred = rootfiles.find((item) => item["media-type"] === "application/oebps-package+xml") || rootfiles[0];
    return normalizeZipPath(preferred["full-path"]);
  }

  function parseOpfXml(xml, opfPath) {
    const title = findAllElementText(xml, "title")[0] || "";
    const creators = findAllElementText(xml, "creator");
    const language = findAllElementText(xml, "language")[0] || "";
    const manifest = new Map();
    const spine = [];

    const itemRe = /<item\b([^>]*)\/?>/gi;
    let itemMatch;
    while ((itemMatch = itemRe.exec(xml))) {
      const attrs = parseAttributes(itemMatch[1]);
      if (!attrs.id || !attrs.href) continue;
      manifest.set(attrs.id, {
        id: attrs.id,
        href: attrs.href,
        path: joinZipPath(opfPath, attrs.href),
        mediaType: attrs["media-type"] || ""
      });
    }

    const itemrefRe = /<itemref\b([^>]*)\/?>/gi;
    let itemrefMatch;
    while ((itemrefMatch = itemrefRe.exec(xml))) {
      const attrs = parseAttributes(itemrefMatch[1]);
      if (attrs.idref) spine.push(attrs.idref);
    }

    if (!spine.length) {
      throw new UserFacingError("The EPUB package has no readable spine.");
    }

    return {
      metadata: { title, creators, language },
      manifest,
      spine
    };
  }

  function removeUnsafeHtmlBlocks(html) {
    return String(html || "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<script\b[\s\S]*?<\/script>/gi, "")
      .replace(/<style\b[\s\S]*?<\/style>/gi, "")
      .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, "")
      .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, "")
      .replace(/<object\b[\s\S]*?<\/object>/gi, "")
      .replace(/<embed\b[\s\S]*?>/gi, "")
      .replace(/<svg\b[\s\S]*?<\/svg>/gi, "");
  }

  function htmlToText(fragment) {
    return decodeXmlEntities(removeUnsafeHtmlBlocks(fragment)
      .replace(/<br\b[^>]*>/gi, "\n")
      .replace(/<\/(p|div|section|article|li|blockquote|h[1-6]|tr)>/gi, "\n")
      .replace(/<[^>]+>/g, ""))
      .replace(/[ \t\r\f\v]+/g, " ")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function extractBody(html) {
    const match = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html);
    return match ? match[1] : html;
  }

  function extractSectionsFromHtml(html, sourcePath) {
    const body = removeUnsafeHtmlBlocks(extractBody(html));
    const sections = [];
    const blockRe = /<(h[1-6]|p|li|blockquote)\b[^>]*>([\s\S]*?)<\/\1>/gi;
    let match;

    while ((match = blockRe.exec(body))) {
      const tag = match[1].toLowerCase();
      const text = htmlToText(match[2]);
      if (!text) continue;
      if (tag.startsWith("h")) {
        sections.push({ type: "heading", level: Number(tag.slice(1)), text, sourcePath });
      } else if (tag === "li") {
        sections.push({ type: "listItem", text, sourcePath });
      } else if (tag === "blockquote") {
        sections.push({ type: "quote", text, sourcePath });
      } else {
        sections.push({ type: "paragraph", text, sourcePath });
      }
    }

    if (sections.length) return sections;

    const fallbackText = htmlToText(body);
    return fallbackText
      .split(/\n{2,}/)
      .map((text) => text.trim())
      .filter(Boolean)
      .map((text) => ({ type: "paragraph", text, sourcePath }));
  }

  function cleanFileStem(name) {
    const base = String(name || "book").split(/[\\/]/).pop().replace(/\.[^.]+$/, "");
    return base || "book";
  }

  function safeFileName(name, extension) {
    const cleaned = String(name || "book")
      .normalize("NFKC")
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120)
      .replace(/[. ]+$/g, "");
    return `${cleaned || "book"}.${extension}`;
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function clampNumber(value, fallback, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
  }

  function safeFontFamily(value, fallback) {
    const raw = String(value || fallback).trim().slice(0, 80);
    if (!raw || /[;{}<>]/.test(raw)) return fallback;
    return raw.replace(/["\\]/g, "").trim() || fallback;
  }

  function normalizeLineHeight(value) {
    const raw = String(value || DEFAULTS.lineHeight).trim();
    if (raw === "normal") return raw;
    const number = Number(raw);
    if (!Number.isFinite(number)) return DEFAULTS.lineHeight;
    return String(clampNumber(number, Number(DEFAULTS.lineHeight), 1, 2.4));
  }

  function normalizeOptions(raw = {}) {
    const paperSize = String(raw.paperSize || DEFAULTS.paperSize).toLowerCase();
    return {
      bodyFont: safeFontFamily(raw.font || raw.bodyFont, DEFAULTS.bodyFont),
      headingFont: safeFontFamily(raw.headingFont, DEFAULTS.headingFont),
      paperSize: PAPER_SIZES.has(paperSize) ? paperSize : DEFAULTS.paperSize,
      fontSize: clampNumber(raw.fontSize, DEFAULTS.fontSize, 8, 32),
      margin: clampNumber(raw.margin, DEFAULTS.margin, 0, 144),
      lineHeight: normalizeLineHeight(raw.lineHeight),
      maxInputBytes: clampNumber(raw.maxInputBytes, DEFAULTS.maxInputBytes, 1, DEFAULTS.maxInputBytes),
      maxFileCount: clampNumber(raw.maxFileCount, DEFAULTS.maxFileCount, 1, DEFAULTS.maxFileCount),
      maxUncompressedBytes: clampNumber(raw.maxUncompressedBytes, DEFAULTS.maxUncompressedBytes, 1, DEFAULTS.maxUncompressedBytes),
      maxReadableCharacters: clampNumber(raw.maxReadableCharacters, DEFAULTS.maxReadableCharacters, 1000, DEFAULTS.maxReadableCharacters)
    };
  }

  function cssFontStack(primary, fallback) {
    return `"${primary}", "${fallback}", "Sitka", Georgia, "Times New Roman", "Microsoft YaHei", "Noto Serif CJK SC", serif`;
  }

  function buildPrintableHtml({ metadata, sections, sourceName, warnings, options }) {
    const opts = normalizeOptions(options);
    const title = metadata.title || cleanFileStem(sourceName);
    const creators = metadata.creators && metadata.creators.length ? metadata.creators.join(", ") : "";
    const headingStack = cssFontStack(opts.headingFont, opts.bodyFont);
    const bodyStack = cssFontStack(opts.bodyFont, "Sitka");
    const sectionHtml = sections.map((section) => {
      const text = escapeHtml(section.text);
      if (section.type === "heading") {
        const level = Math.min(6, Math.max(1, Number(section.level) || 2));
        return `<h${level}>${text}</h${level}>`;
      }
      if (section.type === "listItem") {
        return `<p class="list-item">• ${text}</p>`;
      }
      if (section.type === "quote") {
        return `<blockquote>${text}</blockquote>`;
      }
      return `<p>${text}</p>`;
    }).join("\n");

    const warningHtml = warnings && warnings.length
      ? `<aside class="warnings"><strong>Conversion notes</strong><ul>${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul></aside>`
      : "";

    return `<!doctype html>
<html lang="${escapeHtml(metadata.language || "en")}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    @page {
      size: ${opts.paperSize};
      margin: ${opts.margin}pt;
    }
    :root {
      color-scheme: light;
    }
    body {
      margin: 0 auto;
      max-width: 760px;
      padding: 32px;
      color: #181818;
      background: #ffffff;
      font-family: ${bodyStack};
      font-size: ${opts.fontSize}px;
      line-height: ${opts.lineHeight};
    }
    .toolbar {
      margin: 0 0 28px;
      padding: 12px 14px;
      border: 1px solid #d6d6d6;
      border-radius: 8px;
      background: #f7f7f7;
      color: #333333;
      font-size: 14px;
    }
    h1, h2, h3, h4, h5, h6 {
      font-family: ${headingStack};
      line-height: 1.18;
      break-after: avoid;
    }
    p, blockquote {
      orphans: 3;
      widows: 3;
    }
    blockquote {
      border-left: 3px solid #cccccc;
      margin-left: 0;
      padding-left: 16px;
      color: #333333;
    }
    .book-title {
      margin-bottom: 0.2em;
    }
    .byline {
      margin-top: 0;
      color: #555555;
    }
    .list-item {
      margin-left: 1.2em;
    }
    .warnings {
      margin: 20px 0;
      padding: 12px 14px;
      border: 1px solid #e1c16e;
      border-radius: 8px;
      background: #fff8df;
    }
    @media print {
      body {
        max-width: none;
        padding: 0;
      }
      .toolbar {
        display: none;
      }
    }
  </style>
</head>
<body>
  <div class="toolbar">
    Use Chrome's Print command and choose <strong>Save as PDF</strong>. This generated page contains no script and does not keep a local file path.
  </div>
  <header>
    <h1 class="book-title">${escapeHtml(title)}</h1>
    ${creators ? `<p class="byline">${escapeHtml(creators)}</p>` : ""}
  </header>
  ${warningHtml}
  <article>
${sectionHtml || "<p>No readable text was found in the EPUB spine.</p>"}
  </article>
</body>
</html>`;
  }

  async function convertFileToPrintableHtml(file, rawOptions = {}) {
    if (!file) {
      throw new UserFacingError("Choose an EPUB or MOBI file first.");
    }

    const kind = detectFileKind(file);
    if (kind !== "epub" && kind !== "mobi") {
      throw new UserFacingError("Choose a DRM-free .epub or .mobi file.");
    }

    const options = normalizeOptions(rawOptions);
    if (Number(file.size || 0) > options.maxInputBytes) {
      throw new UserFacingError(`This book is ${humanBytes(file.size)}, above the browser-only limit of ${humanBytes(options.maxInputBytes)}.`);
    }

    const buffer = await file.arrayBuffer();
    if (kind === "mobi") {
      return convertMobiArrayBuffer(buffer, file.name || "book.mobi", options);
    }
    return convertEpubArrayBuffer(buffer, file.name || "book.epub", options);
  }

  async function convertEpubArrayBuffer(buffer, sourceName = "book.epub", rawOptions = {}) {
    const options = normalizeOptions(rawOptions);
    const zip = parseZipArchive(buffer, options);
    const warnings = [];

    if (zip.has("mimetype")) {
      const mimetype = (await zip.getText("mimetype")).trim();
      if (mimetype !== "application/epub+zip") {
        warnings.push(`Unexpected EPUB mimetype: ${mimetype || "(empty)"}`);
      }
    } else {
      warnings.push("The EPUB has no mimetype entry.");
    }

    const containerXml = await zip.getText("META-INF/container.xml");
    const opfPath = parseContainerXml(containerXml);
    const opf = parseOpfXml(await zip.getText(opfPath), opfPath);
    const sections = [];
    let collectedCharacters = 0;

    for (const idref of opf.spine) {
      const item = opf.manifest.get(idref);
      if (!item) {
        warnings.push(`Missing manifest item for spine idref: ${idref}`);
        continue;
      }
      if (!/xhtml|html/i.test(item.mediaType) && !/\.x?html?$/i.test(item.path)) {
        warnings.push(`Skipped non-HTML spine item: ${item.path}`);
        continue;
      }

      const html = await zip.getText(item.path);
      const nextSections = extractSectionsFromHtml(html, item.path);
      for (const section of nextSections) {
        const length = section.text.length;
        if (collectedCharacters + length > options.maxReadableCharacters) {
          const remaining = options.maxReadableCharacters - collectedCharacters;
          if (remaining > 200) {
            sections.push({
              ...section,
              text: `${section.text.slice(0, remaining).trim()}…`
            });
            collectedCharacters = options.maxReadableCharacters;
          }
          warnings.push(`Stopped early after ${humanBytes(options.maxReadableCharacters)} of readable text to avoid freezing the browser.`);
          break;
        }
        sections.push(section);
        collectedCharacters += length;
      }
      if (collectedCharacters >= options.maxReadableCharacters) break;
    }

    if (!sections.length) {
      throw new UserFacingError("No readable HTML spine content was found in this EPUB.");
    }

    const html = buildPrintableHtml({
      metadata: opf.metadata,
      sections,
      sourceName,
      warnings,
      options
    });

    return {
      html,
      metadata: opf.metadata,
      sectionsCount: sections.length,
      warnings,
      outputName: safeFileName(opf.metadata.title || cleanFileStem(sourceName), "html")
    };
  }

  function addSectionsWithReadableLimit(target, incoming, options, warnings) {
    let collectedCharacters = target.reduce((sum, section) => sum + section.text.length, 0);
    for (const section of incoming) {
      const length = section.text.length;
      if (collectedCharacters + length > options.maxReadableCharacters) {
        const remaining = options.maxReadableCharacters - collectedCharacters;
        if (remaining > 200) {
          target.push({
            ...section,
            text: `${section.text.slice(0, remaining).trim()}…`
          });
          collectedCharacters = options.maxReadableCharacters;
        }
        warnings.push(`Stopped early after ${humanBytes(options.maxReadableCharacters)} of readable text to avoid freezing the browser.`);
        return false;
      }
      target.push(section);
      collectedCharacters += length;
    }
    return true;
  }

  async function convertMobiArrayBuffer(buffer, sourceName = "book.mobi", rawOptions = {}) {
    const options = normalizeOptions(rawOptions);
    const header = parseMobiHeader(buffer, options);
    const warnings = [
      "MOBI support is experimental. Text is extracted from the MOBI text records; images, links, footnotes, and advanced Kindle layout features may not be preserved."
    ];

    const recordCount = Math.min(header.textRecordCount, Math.max(0, header.pdb.records.length - 1));
    if (recordCount <= 0) {
      throw new UserFacingError("The MOBI file has no readable text records.");
    }
    if (header.textRecordCount > recordCount) {
      warnings.push(`The MOBI header references ${header.textRecordCount} text records, but only ${recordCount} are available.`);
    }

    const chunks = [];
    for (let index = 1; index <= recordCount; index += 1) {
      chunks.push(decompressMobiTextRecord(header.pdb.records[index], header.compression));
    }

    let textBytes = concatUint8Arrays(chunks, options.maxUncompressedBytes);
    if (header.textLength > 0 && header.textLength < textBytes.length) {
      textBytes = textBytes.slice(0, header.textLength);
    }

    const mobiHtml = decodeMobiText(textBytes, header.encoding)
      .replace(/\0/g, "")
      .trim();
    if (!mobiHtml) {
      throw new UserFacingError("No readable text was found in the MOBI file.");
    }

    const sections = [];
    addSectionsWithReadableLimit(
      sections,
      extractSectionsFromHtml(mobiHtml, sourceName),
      options,
      warnings
    );

    if (!sections.length) {
      throw new UserFacingError("No readable text was found in the MOBI file.");
    }

    const html = buildPrintableHtml({
      metadata: header.metadata,
      sections,
      sourceName,
      warnings,
      options
    });

    return {
      html,
      metadata: header.metadata,
      sectionsCount: sections.length,
      warnings,
      outputName: safeFileName(header.metadata.title || cleanFileStem(sourceName), "html")
    };
  }

  return {
    UserFacingError,
    convertFileToPrintableHtml,
    detectFileKind,
    humanBytes
  };
});
