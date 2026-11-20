// Parse SOR samples with sor-reader and print a compact summary.
import { readFileSync } from "node:fs";
import { parseSor } from "sor-reader";

const files = process.argv.slice(2);
for (const file of files) {
  console.log("=".repeat(70));
  console.log(file);
  try {
    const data = new Uint8Array(readFileSync(file));
    const r = parseSor(data, file);
    console.log(`format v${r.format} (${r.version}), blocks: ${Object.keys(r.blocks).join(", ")}`);
    console.log("-- GenParams --");
    for (const [k, v] of Object.entries(r.GenParams)) if (v !== "" && v !== 0) console.log(`  ${k}: ${JSON.stringify(v)}`);
    console.log("-- SupParams --");
    for (const [k, v] of Object.entries(r.SupParams)) if (v !== "" && v !== 0) console.log(`  ${k}: ${JSON.stringify(v)}`);
    console.log("-- FxdParams --");
    for (const [k, v] of Object.entries(r.FxdParams)) console.log(`  ${k}: ${JSON.stringify(v)}`);
    console.log("-- KeyEvents --");
    const ev = r.KeyEvents;
    const evs = ev["events"] ?? ev["Events"] ?? [];
    console.log(`  num events: ${ev["num events"]}, summary: ${JSON.stringify(ev["summary"] ?? {})}`);
    for (const e of evs) console.log("  ", JSON.stringify(e));
    console.log(`-- Cksum: ${JSON.stringify(r.Cksum)}`);
    console.log(`-- trace points: ${r.trace?.length}`);
  } catch (e) {
    console.log("ERROR:", e.message);
  }
}
