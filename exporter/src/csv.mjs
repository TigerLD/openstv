// CSV export (semicolon, UTF-8 BOM) for Russian Excel.
import { writeFileSync } from "node:fs";

const esc = (v) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function eventsCsv(models) {
  const lines = [];
  lines.push([
    "Файл", "Дата", "Длина волны, нм", "Кабель", "Волокно", "Оператор",
    "№", "Тип", "Дистанция, км", "Потери, дБ", "Отражение, дБ", "Затухание, дБ/км", "Комментарий",
  ].map(esc).join(";"));
  for (const m of models) {
    for (const e of m.events) {
      lines.push([
        m.file,
        m.date.toISOString().slice(0, 19).replace("T", " "),
        m.wavelengthNm,
        m.gen.cableId,
        m.gen.fiberId,
        m.gen.operator,
        e.number,
        e.type,
        (e.distanceM / 1000).toFixed(6),
        e.spliceLossDb.toFixed(3),
        e.reflectionLossDb.toFixed(3),
        e.slopeDbPerKm.toFixed(3),
        e.comment,
      ].map(esc).join(";"));
    }
  }
  return lines.join("\r\n");
}

export function writeEventsCsv(path, models) {
  writeFileSync(path, "\ufeff" + eventsCsv(models), "utf8");
  return path;
}
