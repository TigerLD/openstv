import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";

import { parseSor, SorError } from "../exporter/src/sor.mjs";
import { updateSor } from "../exporter/src/writer.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const original = readFileSync(joinPath(here, "fixtures", "small.sor"));

function crc16(buf) {
  let crc = 0xffff;
  for (const b of buf) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}
const cstr = (s) => Buffer.concat([Buffer.from(s, "latin1"), Buffer.from([0])]);
const u16 = (v) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v & 0xffff);
  return b;
};
const u32 = (v) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0);
  return b;
};

// Minimal v2 reader/writer used only to inject a vendor block into a fixture.
function split(buf) {
  let p = 0;
  const readCstr = () => {
    const start = p;
    while (buf[p] !== 0) p++;
    p++;
    return buf.toString("latin1", start, p - 1);
  };
  assert.equal(readCstr(), "Map");
  const version = buf.readUInt16LE(p); p += 2;
  const mapSize = buf.readUInt16LE(p); p += 2;
  const unknown = buf.readUInt16LE(p); p += 2;
  const count = buf.readUInt16LE(p); p += 2;
  const entries = [];
  for (let i = 0; i < count - 1; i++) {
    const name = readCstr();
    const ver = buf.readUInt16LE(p); p += 2;
    const size = buf.readUInt32LE(p); p += 4;
    entries.push({ name, version: ver, size });
  }
  let off = mapSize;
  for (const e of entries) {
    e.body = buf.subarray(off, off + e.size);
    if (e.name === "Cksum") e.body = e.body.subarray(0, e.body.length - 2);
    off += e.size;
  }
  return { version, unknown, entries };
}

function assemble(parts, mapVersion) {
  const entriesBuf = Buffer.concat(
    parts.map((e) => Buffer.concat([cstr(e.name), u16(e.version), u32(e.body.length + (e.name === "Cksum" ? 2 : 0))]))
  );
  const mapSize = 12 + entriesBuf.length;
  const map = Buffer.concat([
    Buffer.from("Map\0", "latin1"),
    u16(mapVersion),
    u16(mapSize),
    u16(0),
    u16(parts.length + 1),
    entriesBuf,
  ]);
  const bodies = parts.map((e, i) =>
    e.name === "Cksum" && i !== parts.length - 1 ? Buffer.concat([e.body, Buffer.alloc(2)]) : e.body
  );
  let file = Buffer.concat([map, ...bodies]);
  if (parts.at(-1).name === "Cksum") {
    const crc = crc16(file);
    file = Buffer.concat([file, u16(crc)]);
  }
  return file;
}

function withVendor(insertLast = true) {
  const { version, entries } = split(original);
  const vendor = { name: "VendorX", version: 1, body: Buffer.concat([cstr("VendorX"), Buffer.from("HELLO", "latin1")]) };
  const cksumIdx = entries.findIndex((e) => e.name === "Cksum");
  const copy = entries.map((e) => ({ name: e.name, version: e.version, body: e.body }));
  copy.splice(insertLast ? cksumIdx : cksumIdx + 1, 0, vendor);
  return assemble(copy, version);
}

test("unknown vendor blocks survive a metadata edit byte-for-byte", () => {
  const buf = withVendor(true);
  const before = parseSor(buf);
  assert.equal(before.checksum?.match, true);

  const out = updateSor(buf, { comment: "changed" });
  const after = parseSor(out);
  assert.equal(after.checksum?.match, true);
  assert.ok(out.includes(Buffer.from("VendorX\0HELLO", "latin1")));
});

test("Cksum that is not the last block is rejected on write", () => {
  const bad = withVendor(false);
  assert.throws(() => updateSor(bad, {}), (e) => e instanceof SorError && /последним/.test(e.message));
});
