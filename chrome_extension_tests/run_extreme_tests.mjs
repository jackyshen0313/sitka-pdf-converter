import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import { deflateRawSync } from "node:zlib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(__dirname, "..", "chrome_extension");
await import(pathToFileURL(path.join(extensionRoot, "converter_core.js")).href);
const core = globalThis.SitkaPdfCore;

const encoder = new TextEncoder();

function u16(value) {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value, true);
  return out;
}

function u32(value) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

function u16be(value) {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value, false);
  return out;
}

function u32be(value) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
}

function concat(...chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function fixedAscii(text, length) {
  const out = new Uint8Array(length);
  out.set(bytes(text).slice(0, length));
  return out;
}

function bytes(value) {
  if (value instanceof Uint8Array) return value;
  return encoder.encode(String(value));
}

function createStoredZip(entries, options = {}) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const entry of entries) {
    const nameBytes = bytes(entry.name);
    const originalDataBytes = bytes(entry.data || "");
    const method = entry.method ?? options.defaultMethod ?? 0;
    const dataBytes = method === 8 ? new Uint8Array(deflateRawSync(originalDataBytes)) : originalDataBytes;
    const flags = (entry.flags ?? 0x0800) | (options.encrypted ? 0x0001 : 0);

    const localHeader = concat(
      u32(0x04034b50),
      u16(20),
      u16(flags),
      u16(method),
      u16(0),
      u16(0),
      u32(0),
      u32(dataBytes.length),
      u32(originalDataBytes.length),
      u16(nameBytes.length),
      u16(0),
      nameBytes
    );
    localParts.push(localHeader, dataBytes);

    const centralHeader = concat(
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(flags),
      u16(method),
      u16(0),
      u16(0),
      u32(0),
      u32(dataBytes.length),
      u32(originalDataBytes.length),
      u16(nameBytes.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(localOffset),
      nameBytes
    );
    centralParts.push(centralHeader);
    localOffset += localHeader.length + dataBytes.length;
  }

  const localData = concat(...localParts);
  const centralDirectory = concat(...centralParts);
  const eocd = concat(
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(centralDirectory.length),
    u32(localData.length),
    u16(0)
  );

  return concat(localData, centralDirectory, eocd).buffer;
}

function minimalEpub(overrides = {}) {
  const containerPath = overrides.containerPath || "OPS/package.opf";
  const chapterPath = overrides.chapterPath || "OPS/chapter 1.xhtml";
  const chapterHref = overrides.chapterHref || "chapter%201.xhtml";
  const title = overrides.title || "Extreme <Sitka> & Test";
  const creator = overrides.creator || "Jacky";
  const spine = overrides.spine ?? '<itemref idref="chap1"/>';
  const manifest = overrides.manifest ?? `<item id="chap1" href="${chapterHref}" media-type="application/xhtml+xml"/>`;
  const chapter = overrides.chapter ?? `<?xml version="1.0"?>
    <html xmlns="http://www.w3.org/1999/xhtml">
      <head><title>ignored</title><script>alert("bad")</script></head>
      <body>
        <h1>Chapter &amp; One</h1>
        <p>Hello <strong>world</strong>.</p>
        <script>window.evil = true;</script>
        <blockquote>Quoted text.</blockquote>
      </body>
    </html>`;

  return createStoredZip([
    { name: "mimetype", data: overrides.mimetype || "application/epub+zip" },
    {
      name: "META-INF/container.xml",
      data: overrides.containerXml || `<?xml version="1.0"?>
      <container version="1.0">
        <rootfiles>
          <rootfile full-path="${containerPath}" media-type="application/oebps-package+xml"/>
        </rootfiles>
      </container>`
    },
    {
      name: containerPath,
      data: overrides.opf || `<?xml version="1.0"?>
      <package xmlns:dc="http://purl.org/dc/elements/1.1/">
        <metadata>
          <dc:title>${title}</dc:title>
          <dc:creator>${creator}</dc:creator>
          <dc:language>en</dc:language>
        </metadata>
        <manifest>${manifest}</manifest>
        <spine>${spine}</spine>
      </package>`
    },
    { name: chapterPath, data: chapter }
  ], { defaultMethod: overrides.method ?? 0 });
}

function fileLike(name, buffer, type = "") {
  return {
    name,
    type,
    size: buffer.byteLength,
    async arrayBuffer() {
      return buffer;
    }
  };
}

function createMobi(options = {}) {
  const titleBytes = bytes(options.title || "Mobi Extreme Test");
  const textBytes = options.textBytes || bytes(options.html || "<html><body><h1>MOBI Chapter</h1><p>Hello MOBI world.</p><script>bad()</script></body></html>");
  const compression = options.compression ?? 1;
  const encryption = options.encryption ?? 0;
  const encoding = options.encoding ?? 65001;
  const textLength = options.textLength ?? textBytes.length;
  const mobiHeaderLength = 116;
  const titleOffset = 16 + mobiHeaderLength;

  const palmDocHeader = concat(
    u16be(compression),
    u16be(0),
    u32be(textLength),
    u16be(1),
    u16be(4096),
    u16be(encryption),
    u16be(0)
  );

  const mobiHeader = new Uint8Array(mobiHeaderLength);
  mobiHeader.set(bytes("MOBI"), 0);
  mobiHeader.set(u32be(mobiHeaderLength), 4);
  mobiHeader.set(u32be(2), 8);
  mobiHeader.set(u32be(encoding), 12);
  mobiHeader.set(u32be(1000), 16);
  mobiHeader.set(u32be(6), 20);
  mobiHeader.set(u32be(titleOffset), 84);
  mobiHeader.set(u32be(titleBytes.length), 88);

  const record0 = concat(palmDocHeader, mobiHeader, titleBytes);
  const records = [record0, textBytes];
  const recordCount = records.length;
  const header = new Uint8Array(78);
  header.set(fixedAscii(options.pdbName || "MOBI_TEST", 32), 0);
  header.set(bytes("BOOK"), 60);
  header.set(bytes("MOBI"), 64);
  header.set(u16be(recordCount), 76);

  const recordTable = new Uint8Array(recordCount * 8);
  let offset = 78 + recordTable.length;
  for (let index = 0; index < recordCount; index += 1) {
    recordTable.set(u32be(offset), index * 8);
    recordTable.set(u32be(index), index * 8 + 4);
    offset += records[index].length;
  }

  return concat(header, recordTable, ...records).buffer;
}

async function assertRejectsMessage(fn, pattern, label) {
  let rejected = false;
  try {
    await fn();
  } catch (error) {
    rejected = true;
    assert.match(error.message, pattern, label);
  }
  assert.equal(rejected, true, `${label}: expected rejection`);
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test("manifest is publish-oriented and has no nativeMessaging permission", async () => {
  const manifest = JSON.parse(await readFile(path.join(extensionRoot, "manifest.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal((manifest.permissions || []).includes("nativeMessaging"), false);
});

test("popup contains no personal Windows path or native host instruction", async () => {
  const popup = await readFile(path.join(extensionRoot, "popup.html"), "utf8");
  const popupJs = await readFile(path.join(extensionRoot, "popup.js"), "utf8");
  assert.equal(/C:\\Users\\jacky/i.test(popup + popupJs), false);
  assert.equal(/nativeMessaging|sendNativeMessage|native_host/i.test(popup + popupJs), false);
});

test("popup exposes common font choices", async () => {
  const popup = await readFile(path.join(extensionRoot, "popup.html"), "utf8");
  assert.match(popup, /<select id="font">/);
  assert.match(popup, /<select id="headingFont">/);
  for (const fontName of ["Sitka Text", "Georgia", "Times New Roman", "Arial", "Segoe UI", "Calibri", "Microsoft YaHei", "SimSun", "Noto Serif CJK SC"]) {
    assert.match(popup, new RegExp(fontName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("basic EPUB converts and strips active content", async () => {
  const result = await core.convertFileToPrintableHtml(fileLike("book.epub", minimalEpub()), {});
  assert.equal(result.metadata.title, "Extreme & Test");
  assert.equal(result.metadata.creators[0], "Jacky");
  assert.match(result.html, /Chapter &amp; One/);
  assert.match(result.html, /Hello world\./);
  assert.doesNotMatch(result.html, /alert|window\.evil|<script/i);
});

test("compressed EPUB converts through the browser decompression path", async () => {
  const result = await core.convertFileToPrintableHtml(fileLike("compressed.epub", minimalEpub({ method: 8 })), {});
  assert.match(result.html, /Hello world\./);
});

test("basic MOBI converts and strips active content", async () => {
  const result = await core.convertFileToPrintableHtml(fileLike("book.mobi", createMobi()), {});
  assert.equal(result.metadata.title, "Mobi Extreme Test");
  assert.match(result.html, /MOBI Chapter/);
  assert.match(result.html, /Hello MOBI world\./);
  assert.doesNotMatch(result.html, /bad\(\)|<script/i);
  assert.match(result.warnings.join("\n"), /MOBI support is experimental/i);
});

test("PalmDOC-compressed MOBI converts", async () => {
  const compressedRecord = concat(
    bytes("<html><body><p>A"),
    new Uint8Array([0xc8]),
    bytes("i</p></body></html>")
  );
  const decompressedLength = "<html><body><p>A Hi</p></body></html>".length;
  const result = await core.convertFileToPrintableHtml(
    fileLike("compressed.mobi", createMobi({ compression: 2, textBytes: compressedRecord, textLength: decompressedLength })),
    {}
  );
  assert.match(result.html, /A Hi/);
});

test("PalmDOC MOBI with trailing record byte converts", async () => {
  const compressedRecord = concat(
    bytes("<html><body><p>A"),
    new Uint8Array([0xc8]),
    bytes("i</p></body></html>"),
    new Uint8Array([0x80])
  );
  const result = await core.convertFileToPrintableHtml(
    fileLike("trailing.mobi", createMobi({ compression: 2, textBytes: compressedRecord, textLength: 36 })),
    {}
  );
  assert.match(result.html, /A Hi/);
});

test("encrypted MOBI is rejected", async () => {
  await assertRejectsMessage(
    () => core.convertFileToPrintableHtml(fileLike("encrypted.mobi", createMobi({ encryption: 1 })), {}),
    /Encrypted or DRM-protected MOBI/i,
    "encrypted MOBI rejection"
  );
});

test("HUFF/CDIC MOBI is rejected with a useful message", async () => {
  await assertRejectsMessage(
    () => core.convertFileToPrintableHtml(fileLike("huff.mobi", createMobi({ compression: 17480 })), {}),
    /HUFF\/CDIC-compressed MOBI/i,
    "huff MOBI rejection"
  );
});

test("unknown file type is rejected", async () => {
  const buffer = createStoredZip([{ name: "x", data: "x" }]);
  await assertRejectsMessage(
    () => core.convertFileToPrintableHtml(fileLike("book.txt", buffer), {}),
    /Choose a DRM-free \.epub or \.mobi/i,
    "unknown file rejection"
  );
});

test("oversized input is rejected before reading", async () => {
  let readCalled = false;
  const fakeFile = {
    name: "huge.epub",
    type: "",
    size: 200,
    async arrayBuffer() {
      readCalled = true;
      return new ArrayBuffer(0);
    }
  };
  await assertRejectsMessage(
    () => core.convertFileToPrintableHtml(fakeFile, { maxInputBytes: 100 }),
    /above the browser-only limit/i,
    "oversized input rejection"
  );
  assert.equal(readCalled, false);
});

test("missing container.xml gives a helpful error", async () => {
  const buffer = createStoredZip([{ name: "mimetype", data: "application/epub+zip" }]);
  await assertRejectsMessage(
    () => core.convertFileToPrintableHtml(fileLike("missing-container.epub", buffer), {}),
    /Missing EPUB file: META-INF\/container\.xml/i,
    "missing container"
  );
});

test("missing spine gives a helpful error", async () => {
  const buffer = minimalEpub({ spine: "" });
  await assertRejectsMessage(
    () => core.convertFileToPrintableHtml(fileLike("missing-spine.epub", buffer), {}),
    /no readable spine/i,
    "missing spine"
  );
});

test("missing manifest item is reported and fails if no readable content remains", async () => {
  const buffer = minimalEpub({ manifest: "", spine: '<itemref idref="not-there"/>' });
  await assertRejectsMessage(
    () => core.convertFileToPrintableHtml(fileLike("missing-manifest.epub", buffer), {}),
    /No readable HTML spine content/i,
    "missing manifest"
  );
});

test("unsafe ZIP parent path is rejected", async () => {
  const buffer = createStoredZip([{ name: "../evil.xhtml", data: "bad" }]);
  await assertRejectsMessage(
    () => core.convertFileToPrintableHtml(fileLike("unsafe.epub", buffer), {}),
    /Unsafe parent-directory EPUB path rejected/i,
    "unsafe parent path"
  );
});

test("encrypted ZIP entry is rejected", async () => {
  const buffer = createStoredZip([{ name: "mimetype", data: "application/epub+zip" }], { encrypted: true });
  await assertRejectsMessage(
    () => core.convertFileToPrintableHtml(fileLike("encrypted.epub", buffer), {}),
    /Encrypted or DRM-protected/i,
    "encrypted zip"
  );
});

test("too many files are rejected", async () => {
  const buffer = createStoredZip([
    { name: "a", data: "a" },
    { name: "b", data: "b" }
  ]);
  await assertRejectsMessage(
    () => core.convertFileToPrintableHtml(fileLike("many.epub", buffer), { maxFileCount: 1 }),
    /too many files/i,
    "too many files"
  );
});

test("unsupported compression method is rejected", async () => {
  const buffer = createStoredZip([{ name: "mimetype", data: "application/epub+zip", method: 99 }]);
  await assertRejectsMessage(
    () => core.convertFileToPrintableHtml(fileLike("method.epub", buffer), {}),
    /Unsupported ZIP compression method/i,
    "unsupported compression method"
  );
});

test("href URI decoding resolves spaces in spine files", async () => {
  const result = await core.convertFileToPrintableHtml(fileLike("space-path.epub", minimalEpub()), {});
  assert.match(result.html, /Hello world\./);
});

test("font CSS injection is neutralized", async () => {
  const result = await core.convertFileToPrintableHtml(
    fileLike("css.epub", minimalEpub()),
    { font: "Arial; body { display:none }", headingFont: "H{bad}", paperSize: "moon" }
  );
  assert.doesNotMatch(result.html, /display:none/);
  assert.match(result.html, /Sitka Text/);
  assert.match(result.html, /size: a4/);
});

test("download filename is safe for Windows and Chrome", async () => {
  const result = await core.convertFileToPrintableHtml(
    fileLike("bad.epub", minimalEpub({ title: "Bad:Name&lt;&gt;|&quot;*?" })),
    {}
  );
  assert.equal(result.outputName, "Bad_Name______.html");
});

test("large readable text stops with a warning instead of freezing", async () => {
  const longText = "x".repeat(5000);
  const buffer = minimalEpub({ chapter: `<html><body><p>${longText}</p><p>after</p></body></html>` });
  const result = await core.convertFileToPrintableHtml(fileLike("large.epub", buffer), { maxReadableCharacters: 1000 });
  assert.equal(result.sectionsCount, 1);
  assert.match(result.warnings.join("\n"), /Stopped early/i);
});

let passed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
    break;
  }
}

if (process.exitCode !== 1) {
  console.log(`\n${passed}/${tests.length} extreme tests passed.`);
}

