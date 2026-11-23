import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseSor } from "../exporter/src/sor.mjs";
import {
  readTraceData,
  readTraceEvents,
  rewriteSor,
  updateSor,
} from "../exporter/src/writer.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = ["small.sor", "medium.sor", "long.sor"].map((name) => ({
  name,
  path: join(here, "fixtures", name),
}));

for (const { name, path } of fixtures) {
  test(`${name}: parses as Bellcore v2 and keeps CRC`, () => {
    const sor = parseSor(readFileSync(path));
    assert.equal(sor.format, 2);
    assert.ok(sor.fxd.numDataPoints > 0);
    assert.ok(sor.fxd.rangeM > 0);
    assert.ok(sor.events.count >= 1);
    assert.equal(sor.checksum?.match, true);
  });

  test(`${name}: rewriteSor without changes is byte-identical`, () => {
    const buf = readFileSync(path);
    const data = readTraceData(buf);
    const events = readTraceEvents(buf);
    const out = rewriteSor(buf, { data, events });
    assert.equal(Buffer.compare(buf, out), 0);
  });

  test(`${name}: updateSor without edits is byte-identical`, () => {
    const buf = readFileSync(path);
    const out = updateSor(buf, {});
    assert.equal(Buffer.compare(buf, out), 0);
  });

  test(`${name}: corrupted payload is detected and repaired on write`, () => {
    const buf = Buffer.from(readFileSync(path));
    const sor = parseSor(buf);
    const payload = sor.blocks.DataPts.dataStart + 12 + 10;
    buf[payload] ^= 0xff;
    const broken = parseSor(buf);
    assert.equal(broken.checksum?.match, false);

    const fixed = updateSor(buf, {});
    assert.equal(parseSor(fixed).checksum?.match, true);
  });
}
