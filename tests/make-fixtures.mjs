// Generates reproducible SOR fixtures for the test suite.
// Usage: node tests/make-fixtures.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSor } from "../exporter/src/generator.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "fixtures");
mkdirSync(dir, { recursive: true });

const base = {
  ior: 1.468,
  wavelengthNm: 1310,
  pulseNs: 10,
  slopeDbPerKm: 0.35,
  cableId: "TEST",
  fiberId: "1",
  operator: "Test Operator",
  comment: "Generated fixture",
};

const fixtures = [
  {
    name: "small.sor",
    opts: {
      ...base,
      rangeM: 1000,
      points: 1200,
      events: [
        { distanceM: 0, spliceLossDb: 0.3, reflectionLossDb: -50, comment: "connector" },
        { distanceM: 500, spliceLossDb: 0.2, reflectionLossDb: -58, comment: "splice" },
      ],
    },
  },
  {
    name: "medium.sor",
    opts: {
      ...base,
      rangeM: 5000,
      points: 4000,
      wavelengthNm: 1550,
      pulseNs: 20,
      fiberId: "7",
      events: [
        { distanceM: 0, spliceLossDb: 0.4, reflectionLossDb: -52, comment: "connector" },
        { distanceM: 1500, spliceLossDb: 0.25, reflectionLossDb: -60 },
        { distanceM: 4000, spliceLossDb: 0.4, reflectionLossDb: -58 },
      ],
    },
  },
  {
    name: "long.sor",
    opts: {
      ...base,
      rangeM: 80000,
      points: 100000,
      wavelengthNm: 1550,
      pulseNs: 100,
      fiberId: "12",
      events: [
        { distanceM: 0, spliceLossDb: 0.4, reflectionLossDb: -50 },
        { distanceM: 40000, spliceLossDb: 0.3, reflectionLossDb: -58 },
      ],
    },
  },
];

for (const f of fixtures) {
  const buf = createSor(f.opts);
  writeFileSync(join(dir, f.name), buf);
  console.log(`${f.name}: ${buf.length} bytes`);
}
