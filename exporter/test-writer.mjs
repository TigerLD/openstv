// Verify write round-trip: identity, metadata patch, CRC.
import { readFileSync, writeFileSync } from "node:fs";
import { updateSor, readMetadata } from "./src/writer.mjs";
import { parseSor } from "./src/sor.mjs";

const file = process.argv[2];
const buf = readFileSync(file);

const same = updateSor(buf, {});
console.log("identity bytes equal:", Buffer.compare(same, buf) === 0, same.length, buf.length);

const edited = updateSor(buf, {
  fiberId: "77",
  cableId: "TEST",
  operator: "Иванов И.И.",
  comment: "пакетное преобразование",
  ior: 1.47,
  timestamp: 1735689600,
});

const out = "..\\out\\edited.sor";
writeFileSync(out, edited);
const sor = parseSor(readFileSync(out));
console.log({
  fiber: sor.gen.fiberId,
  cable: sor.gen.cableId,
  operator: sor.gen.operator,
  comment: sor.gen.comment,
  ior: sor.fxd.indexOfRefraction,
  date: sor.fxd.date.toISOString(),
  crc: sor.checksum,
  events: sor.events.count,
});
console.log("meta:", readMetadata(readFileSync(out)));
