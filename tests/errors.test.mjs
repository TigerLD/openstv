import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseSor, SorError } from "../exporter/src/sor.mjs";
import { readTraceData, updateSor } from "../exporter/src/writer.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "small.sor");
const original = readFileSync(fixture);

test("truncated files throw SorError, never RangeError", () => {
  for (const cut of [0, 1, 2, 4, 8, 16, 64, 256, 1024, 2048, original.length - 1]) {
    const buf = original.subarray(0, cut);
    assert.throws(
      () => parseSor(buf),
      (e) => e instanceof SorError,
      `cut=${cut} should be reported as SorError`
    );
  }
});

test("huge point count is rejected with SorError", () => {
  const buf = Buffer.from(original);
  const sor = parseSor(buf);
  buf.writeUInt32LE(0xffffffff, sor.blocks.DataPts.dataStart);
  assert.throws(() => parseSor(buf), (e) => e instanceof SorError && /точек/.test(e.message));
});

test("huge event count is rejected with SorError", () => {
  const buf = Buffer.from(original);
  const sor = parseSor(buf);
  buf.writeUInt16LE(0xffff, sor.blocks.KeyEvents.dataStart);
  assert.throws(() => parseSor(buf), (e) => e instanceof SorError && /обрезано/.test(e.message));
});

test("random mutations never escape as non-SorError", () => {
  for (let i = 0; i < 200; i++) {
    const buf = Buffer.from(original);
    const p = 2 + Math.floor(Math.random() * 40);
    buf[p] = Math.floor(Math.random() * 256);
    try {
      parseSor(buf);
    } catch (e) {
      assert.ok(e instanceof SorError, `mutation ${i} threw ${e.name}: ${e.message}`);
    }
  }
});

test("multi-trace DataPts is rejected on write", () => {
  const buf = Buffer.from(original);
  const sor = parseSor(buf);
  buf.writeInt16LE(2, sor.blocks.DataPts.dataStart + 4);
  assert.throws(() => readTraceData(buf), (e) => e instanceof SorError && /набора точек/.test(e.message));
});

test("writing a v1 (no Map) file is reported clearly", () => {
  const v1 = Buffer.concat([
    Buffer.from("GenParams\0", "latin1"),
    Buffer.alloc(16),
  ]);
  assert.throws(() => updateSor(v1, {}), (e) => e instanceof SorError && /Map/.test(e.message));
});
