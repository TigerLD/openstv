// Dump full parsed SOR as JSON.
import { readFileSync } from "node:fs";
import { parseSor, toJSON } from "sor-reader";

const file = process.argv[2];
const r = parseSor(new Uint8Array(readFileSync(file)), file);
const json = JSON.parse(toJSON(r));
console.log(JSON.stringify(json.KeyEvents, null, 2));
