// Printable measurement protocols for fibre-optic links (RD 45.156-2000 style).
// Output is a self-contained HTML file that opens in Word/LibreOffice and prints
// to PDF without any external assets.
import { writeFileSync } from "node:fs";

const KINDS = {
  "rd-4": {
    title: "ПРОТОКОЛ измерения затухания оптических волокон",
    subtitle: "ВОЛС-РД-4",
    columns: ["№", "Волокно", "Длина, км", "Затухание, дБ", "Норма, дБ", "Заключение"],
  },
  "rd-6": {
    title: "ПРОТОКОЛ рефлектометрических измерений",
    subtitle: "ВОЛС-РД-6",
    columns: ["№", "Волокно", "Длина, км", "Событий", "Потери, дБ", "Отражение, дБ", "Заключение"],
  },
  "pte-8": {
    title: "ПРОТОКОЛ приёмки смонтированного участка ВОЛС",
    subtitle: "ВОЛС-ПТЭ-8",
    columns: ["№", "Волокно", "Длина, км", "Затухание, дБ", "Норма, дБ", "Заключение"],
  },
};

const esc = (v) =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const fmtDate = (d) => {
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
};

function totalLoss(model) {
  return model.events
    .filter((e) => e.distanceM > 1)
    .reduce((a, e) => a + e.spliceLossDb, 0);
}

function minReflection(model) {
  const values = model.events.filter((e) => e.reflectionLossDb < 0).map((e) => e.reflectionLossDb);
  return values.length ? Math.min(...values) : null;
}

// Simple server-side reflectogram: downsampled polyline in a 900x260 viewBox.
function traceSvg(model, width = 900, height = 260) {
  const trace = model.trace || [];
  if (trace.length < 2) return "";
  const pad = { l: 46, r: 12, t: 12, b: 26 };
  const min = Math.min(...trace);
  const max = Math.max(...trace);
  const span = max - min || 1;
  const n = trace.length;
  const step = Math.max(1, Math.ceil(n / 1600));
  const pts = [];
  for (let i = 0; i < n; i += step) {
    const x = pad.l + (i / (n - 1)) * (width - pad.l - pad.r);
    const y = pad.t + (1 - (trace[i] - min) / span) * (height - pad.t - pad.b);
    pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  const grid = [];
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + (height - pad.t - pad.b) * i / 4;
    grid.push(`<line x1="${pad.l}" y1="${y.toFixed(1)}" x2="${width - pad.r}" y2="${y.toFixed(1)}" stroke="#e6ecf5"/>`);
  }
  const km = (model.rangeM / 1000).toFixed(3);
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" xmlns="http://www.w3.org/2000/svg">
<rect x="0" y="0" width="${width}" height="${height}" fill="#fbfcfe"/>
${grid.join("")}
<polyline points="${pts.join(" ")}" fill="none" stroke="#1f6feb" stroke-width="1.2"/>
<text x="${pad.l}" y="${height - 8}" font-size="11" fill="#65758b">0 км</text>
<text x="${width - pad.r}" y="${height - 8}" font-size="11" fill="#65758b" text-anchor="end">${km} км</text>
</svg>`;
}

function header({ org, object, cable, date, instrument }) {
  return `<table class="head">
<tr><td class="label">Организация</td><td>${esc(org)}</td><td class="label">Дата</td><td>${esc(date)}</td></tr>
<tr><td class="label">Объект</td><td>${esc(object)}</td><td class="label">Кабель</td><td>${esc(cable)}</td></tr>
<tr><td class="label">Прибор</td><td colspan="3">${esc(instrument)}</td></tr>
</table>`;
}

function signatures() {
  return `<table class="sign">
<tr><td>Измерения выполнил:</td><td class="line"></td><td class="small">подпись / Ф.И.О.</td></tr>
<tr><td>Проверил:</td><td class="line"></td><td class="small">подпись / Ф.И.О.</td></tr>
</table>`;
}

export function buildProtocol(models, opts = {}) {
  const kind = KINDS[opts.kind] ? opts.kind : "rd-4";
  const spec = KINDS[kind];
  const date = opts.date || fmtDate(new Date());
  const normPerKm = Number(opts.normPerKm) > 0 ? Number(opts.normPerKm) : 0.35;
  const instrument = models.length
    ? [models[0].sup.supplier, models[0].sup.otdr]
        .map((v) => String(v ?? "").trim())
        .filter(Boolean)
        .join(" ") || "OTDR"
    : "";

  const rows = [];
  models.forEach((m, i) => {
    const km = m.rangeM / 1000;
    const loss = totalLoss(m);
    const norm = normPerKm * km;
    const ok = loss <= norm + 1e-6;
    if (kind === "rd-6") {
      const refl = minReflection(m);
      rows.push(`<tr>
<td>${i + 1}</td><td>${esc(m.gen.fiberId)}</td><td>${km.toFixed(3)}</td>
<td>${m.events.length}</td><td>${loss.toFixed(2)}</td>
<td>${refl == null ? "—" : refl.toFixed(1)}</td>
<td>${ok ? "годен" : "не годен"}</td></tr>`);
    } else {
      rows.push(`<tr>
<td>${i + 1}</td><td>${esc(m.gen.fiberId)}</td><td>${km.toFixed(3)}</td>
<td>${loss.toFixed(2)}</td><td>${norm.toFixed(2)}</td>
<td>${ok ? "годен" : "не годен"}</td></tr>`);
    }
  });

  const details = kind === "rd-6"
    ? models.map((m, i) => {
        const evRows = m.events.map((e) => `<tr>
<td>${e.number}</td><td>${(e.distanceM / 1000).toFixed(3)}</td><td>${esc(e.type)}</td>
<td>${e.spliceLossDb.toFixed(2)}</td><td>${e.reflectionLossDb.toFixed(1)}</td>
<td>${e.slopeDbPerKm.toFixed(3)}</td><td>${esc(e.comment)}</td></tr>`).join("");
        return `<section class="trace">
<h3>${i + 1}. ${esc(m.file)}</h3>
<div class="traceMeta">Дата измерения: ${esc(fmtDate(m.date))} · длина волны ${m.wavelengthNm} нм ·
импульс ${m.pulseNs.join("/")} нс · показатель преломления ${m.ior.toFixed(4)} ·
волокно ${esc(m.gen.fiberId)}</div>
${traceSvg(m)}
<table class="grid"><thead><tr>
<th>№</th><th>Расстояние, км</th><th>Тип</th><th>Потери, дБ</th><th>Отражение, дБ</th><th>Затухание, дБ/км</th><th>Комментарий</th>
</tr></thead><tbody>${evRows}</tbody></table>
</section>`;
      }).join("")
    : "";

  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<title>${esc(spec.subtitle)} · ${esc(opts.object || "протокол")}</title>
<style>
  @page { size: A4; margin: 15mm 12mm; }
  body { margin:0; color:#000; font:11pt/1.35 "Times New Roman", serif; }
  h1 { font-size:14pt; text-align:center; margin:0 0 2px; text-transform:uppercase; }
  h2 { font-size:11.5pt; text-align:center; margin:0 0 12px; font-weight:normal; }
  h3 { font-size:11pt; margin:14px 0 4px; }
  table { border-collapse:collapse; width:100%; table-layout:fixed; }
  th, td { border:1px solid #000; padding:3px 5px; vertical-align:top; overflow-wrap:anywhere; }
  th { background:#eef2f7; font-weight:600; text-align:center; }
  table.head td { border:1px solid #000; }
  table.head .label { width:22%; background:#f4f6f9; }
  .traceMeta { font-size:9.5pt; color:#333; margin-bottom:4px; }
  .trace { page-break-inside:avoid; margin-bottom:14px; }
  .trace svg { border:1px solid #999; margin:4px 0 6px; }
  .trace table.grid { font-size:9pt; }
  table.sign { margin-top:22px; border:none; }
  table.sign td { border:none; padding:8px 4px; }
  table.sign .line { border-bottom:1px solid #000; width:38%; }
  table.sign .small { color:#555; font-size:8.5pt; }
  .note { font-size:9pt; color:#444; margin-top:10px; }
  @media print { .trace { page-break-inside:avoid; } }
</style></head><body>
<h1>${esc(spec.title)}</h1>
<h2>${esc(spec.subtitle)} · РД 45.156-2000</h2>
${header({ org: opts.org, object: opts.object, cable: opts.cable, date, instrument })}
<table class="grid"><thead><tr>${spec.columns.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead>
<tbody>${rows.join("") || `<tr><td colspan="${spec.columns.length}">нет данных</td></tr>`}</tbody></table>
<div class="note">Норма затухания принята ${normPerKm.toFixed(2)} дБ/км; при необходимости скорректируйте её в документе.
Затухание волокна рассчитано как сумма потерь на событиях (без первого события — разъёма).</div>
${details}
${signatures()}
<div class="note">Сформировано OpenSTV. Проверка норм и подписи — на ответственности исполнителя.</div>
</body></html>`;
}

export function writeProtocol(path, models, opts = {}) {
  const html = buildProtocol(models, opts);
  writeFileSync(path, html, "utf8");
  return path;
}
