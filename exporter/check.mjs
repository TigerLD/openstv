// Quick self-check of the built-in SOR parser.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parseSor, summarize } from "./src/sor.mjs";

for (const file of process.argv.slice(2)) {
  const sor = parseSor(readFileSync(file));
  const s = summarize(sor, basename(file));
  console.log("=".repeat(72));
  console.log(JSON.stringify({ ...s, eventList: undefined }, null, 2));
  console.table(s.eventList);
  console.log("checksum:", s.checksum);
}
