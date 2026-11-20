// Excel export (xlsx) for one or many OTDR traces.
import ExcelJS from "exceljs";
import { renderTracePng } from "./chartpng.mjs";

const THIN = { style: "thin", color: { argb: "FF9E9E9E" } };
const BORDER = { top: THIN, left: THIN, bottom: THIN, right: THIN };
const HEADER_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDDEBF7" } };
const TITLE_FONT = { bold: true, size: 14 };
const LABEL_FONT = { bold: true };

const EVENT_COLUMNS = [
  { header: "№", key: "number", width: 6 },
  { header: "Тип", key: "type", width: 22 },
  { header: "Дистанция, км", key: "distance", width: 16 },
  { header: "Потери, дБ", key: "splice", width: 14 },
  { header: "Отражение, дБ", key: "reflection", width: 16 },
  { header: "Затухание, дБ/км", key: "slope", width: 18 },
  { header: "Комментарий", key: "comment", width: 32 },
];

function fmtDate(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

function styleHeader(row) {
  row.eachCell((cell) => {
    cell.font = LABEL_FONT;
    cell.fill = HEADER_FILL;
    cell.border = BORDER;
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  });
  row.height = 28;
}

function addInfo(ws, model) {
  const rows = [
    ["Имя файла", model.file],
    ["Дата и время измерения", fmtDate(model.date)],
    ["Длина волны, нм", model.wavelengthNm],
    ["Длина трассы, км", +(model.rangeM / 1000).toFixed(3)],
    ["Разрешение, м", +model.resolutionM.toFixed(3)],
    ["Число точек", model.points],
    ["Импульс, нс", model.pulseNs.join(" / ")],
    ["Показатель преломления", +model.ior.toFixed(5)],
    ["Затухание обратного рассеяния, дБ", +model.backscatterDb.toFixed(2)],
    ["Кабель", model.gen.cableId],
    ["Волокно", model.gen.fiberId],
    ["Начало (A)", model.gen.locationA],
    ["Конец (B)", model.gen.locationB],
    ["Оператор", model.gen.operator],
    ["Комментарий", model.gen.comment],
    ["Рефлектометр", model.sup.otdr],
    ["Модуль", model.sup.module],
    ["Модуль S/N", model.sup.moduleSerial],
    ["Рефлектометр S/N", model.sup.otdrSerial],
    ["Версия ПО", model.sup.software],
  ];
  for (const [label, value] of rows) {
    const r = ws.addRow([label, value]);
    r.getCell(1).font = LABEL_FONT;
    r.getCell(1).border = BORDER;
    r.getCell(2).border = BORDER;
    r.getCell(1).alignment = { wrapText: true, vertical: "top" };
    r.getCell(2).alignment = { wrapText: true, vertical: "top" };
  }
}

function addEvents(ws, model) {
  const header = ws.addRow(EVENT_COLUMNS.map((c) => c.header));
  styleHeader(header);
  for (const e of model.events) {
    const row = ws.addRow([
      e.number,
      e.type,
      +(e.distanceM / 1000).toFixed(6),
      +e.spliceLossDb.toFixed(3),
      +e.reflectionLossDb.toFixed(3),
      +e.slopeDbPerKm.toFixed(3),
      e.comment,
    ]);
    row.eachCell((cell, col) => {
      cell.border = BORDER;
      if (col === 3 || col === 4 || col === 5 || col === 6) cell.numFmt = "0.000";
      cell.alignment = { vertical: "top", wrapText: col === 7 };
    });
  }
  // Total splice loss along the trace (the start-of-fiber event is excluded).
  const last = model.events[model.events.length - 1];
  if (last) {
    const total = model.events
      .filter((e) => e.distanceM > 1)
      .reduce((a, e) => a + e.spliceLossDb, 0);
    const row = ws.addRow(["", "Итого потерь на трассе, дБ", "", +total.toFixed(3)]);
    row.getCell(2).font = LABEL_FONT;
    row.getCell(4).font = LABEL_FONT;
    row.eachCell((cell) => (cell.border = BORDER));
  }
}

function addTraceSheet(wb, model, sheetName) {
  const ws = wb.addWorksheet(sheetName ?? safeSheetName(model.file));
  ws.columns = [
    { width: 32 },
    { width: 42 },
    ...EVENT_COLUMNS.slice(2).map((c) => ({ width: c.width })),
  ];
  const title = ws.addRow(["Отчет по трассе"]);
  title.font = TITLE_FONT;
  ws.mergeCells(title.number, 1, title.number, 7);
  ws.addRow([]);
  addInfo(ws, model);
  ws.addRow([]);
  const h = ws.addRow(["События"]);
  h.font = LABEL_FONT;
  ws.addRow([]);
  addEvents(ws, model);

  if (Array.isArray(model.trace) && model.trace.length > 1) {
    ws.addRow([]);
    const cap = ws.addRow(["Рефлектограмма (по вертикали — дБ, по горизонтали — м)"]);
    cap.font = LABEL_FONT;
    const topRow = ws.rowCount;
    for (let i = 0; i < 17; i++) ws.addRow([]);
    const imageId = wb.addImage({
      buffer: renderTracePng(model, { width: 900, height: 320 }),
      extension: "png",
    });
    ws.addImage(imageId, {
      tl: { col: 0.15, row: topRow + 0.3 },
      ext: { width: 820, height: 292 },
    });
  }
  return ws;
}

function safeSheetName(name) {
  const base = name.replace(/\.[^.]+$/, "") || "Трасса";
  return base.replace(/[\\/?*[\]:]/g, "_").slice(0, 31);
}

export async function buildWorkbook(models, { summary = true } = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "OpenSTV";
  wb.created = new Date();

  if (summary && models.length > 1) {
    const ws = wb.addWorksheet("Сводка");
    const cols = [
      "Файл", "Дата", "Длина волны, нм", "Кабель", "Волокно", "Длина, км",
      "Импульс, нс", "Событий", "Оператор", "S/N", "CRC",
    ];
    ws.addRow(cols);
    styleHeader(ws.getRow(1));
    ws.columns = [
      { width: 34 }, { width: 20 }, { width: 16 }, { width: 14 }, { width: 10 },
      { width: 12 }, { width: 12 }, { width: 10 }, { width: 24 }, { width: 16 }, { width: 8 },
    ];
    for (const m of models) {
      const row = ws.addRow([
        m.file,
        fmtDate(m.date),
        m.wavelengthNm,
        m.gen.cableId,
        m.gen.fiberId,
        +(m.rangeM / 1000).toFixed(3),
        m.pulseNs.join("/"),
        m.events.length,
        m.gen.operator,
        m.sup.otdrSerial,
        m.checksumOk ? "OK" : "—",
      ]);
      row.eachCell((cell) => (cell.border = BORDER));
    }
    ws.views = [{ state: "frozen", ySplit: 1 }];
  }

  for (const m of models) {
    addTraceSheet(wb, m);
  }
  return wb;
}

export async function writeWorkbook(path, models, opts) {
  const wb = await buildWorkbook(models, opts);
  await wb.xlsx.writeFile(path);
  return path;
}

// Loss between two events (by event number) including fibre attenuation of
// every span in between. Mirrors the extended report for GPON sections.
function spanLossDb(model, aNumber, bNumber) {
  const evs = model.events.slice().sort((a, b) => a.distanceM - b.distanceM);
  let total = 0;
  for (let i = 0; i < evs.length; i++) {
    const e = evs[i];
    if (e.number <= aNumber || e.number > bNumber) continue;
    const prev = i > 0 ? evs[i - 1] : null;
    const lenKm = prev ? Math.max(0, e.distanceM - prev.distanceM) / 1000 : e.distanceM / 1000;
    total += e.spliceLossDb + e.slopeDbPerKm * lenKm;
  }
  return total;
}

function findEvent(model, number) {
  return model.events.find((e) => e.number === number) ?? null;
}

export async function writeSpanReport(path, models, { eventA = 1, eventB = 2 } = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "OpenSTV";
  wb.created = new Date();
  const ws = wb.addWorksheet("Участок A-B");
  const title = ws.addRow([`Потери на участке: событие ${eventA} → событие ${eventB}`]);
  title.font = TITLE_FONT;
  ws.mergeCells(title.number, 1, title.number, 10);
  ws.addRow([]);

  const header = ws.addRow([
    "Файл", "Дата", "Длина волны, нм", "Кабель", "Волокно",
    "A, км", "B, км", "Длина участка, км", "Потери участка, дБ", "Затухание, дБ/км",
  ]);
  styleHeader(header);
  ws.columns = [
    { width: 34 }, { width: 20 }, { width: 16 }, { width: 16 }, { width: 10 },
    { width: 12 }, { width: 12 }, { width: 18 }, { width: 20 }, { width: 18 },
  ];

  for (const m of models) {
    const a = findEvent(m, eventA);
    const b = findEvent(m, eventB);
    if (!a || !b || b.distanceM <= a.distanceM) continue;
    const lenKm = (b.distanceM - a.distanceM) / 1000;
    const loss = spanLossDb(m, a.number, b.number);
    const row = ws.addRow([
      m.file,
      fmtDate(m.date),
      m.wavelengthNm,
      m.gen.cableId,
      m.gen.fiberId,
      +(a.distanceM / 1000).toFixed(3),
      +(b.distanceM / 1000).toFixed(3),
      +lenKm.toFixed(3),
      +loss.toFixed(3),
      +(loss / Math.max(lenKm, 1e-9)).toFixed(3),
    ]);
    row.eachCell((cell) => (cell.border = BORDER));
  }
  ws.views = [{ state: "frozen", ySplit: 3 }];
  await wb.xlsx.writeFile(path);
  return path;
}
