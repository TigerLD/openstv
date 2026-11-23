import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseSor } from "../exporter/src/sor.mjs";
import { toModel } from "../exporter/src/model.mjs";
import { buildProtocol } from "../exporter/src/protocol.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const model = toModel(parseSor(readFileSync(join(here, "fixtures", "small.sor"))), "small.sor");

test("protocol without a norm does not invent a limit", () => {
  const html = buildProtocol([model], { kind: "rd-4" });
  assert.match(html, /норма не задана/i);
  assert.doesNotMatch(html, /0\.35/);
});

test("protocol uses the provided norm", () => {
  const html = buildProtocol([model], { kind: "rd-4", normPerKm: 0.4 });
  assert.match(html, /0\.40/);
  assert.match(html, /Норма затухания принята 0\.40/);
});
