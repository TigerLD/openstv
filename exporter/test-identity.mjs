import { readFileSync } from "node:fs";
import { updateSor } from "./src/writer.mjs";

const buf = readFileSync(process.argv[2]);
const same = updateSor(buf, {});
let diffs = 0;
for (let i = 0; i < Math.min(buf.length, same.length); i++) {
  if (buf[i] !== same[i]) {
    if (diffs < 20) console.log(`@0x${i.toString(16)} orig=${buf[i].toString(16)} new=${same[i].toString(16)}`);
    diffs++;
  }
}
console.log({ diffs, origLen: buf.length, newLen: same.length });
