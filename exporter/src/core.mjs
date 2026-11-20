// Shared core: scanning, parsing, reports, batch transform.
// Used by both the CLI and the local web GUI.
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { parseSor } from "./sor.mjs";
import { toModel } from "./model.mjs";
import { writeWorkbook } from "./excel.mjs";
import { writeEventsCsv } from "./csv.mjs";
import { updateSor, readMetadata } from "./writer.mjs";

export const SOR_EXT = new Set([".sor", ".msor", ".csor", ".trc"]);

export function collect(paths, { recursive = true } = {}) {
  const out = [];
  for (const p of paths) {
    const abs = resolve(p);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      for (const entry of readdirSync(abs, { withFileTypes: true })) {
        const full = join(abs, entry.name);
        if (entry.isDirectory()) {
          if (recursive) out.push(...collect([full], { recursive }));
        } else if (SOR_EXT.has(extname(entry.name).toLowerCase())) {
          out.push(full);
        }
      }
    } else {
      out.push(abs);
    }
  }
  return [...new Set(out)].sort();
}

export function load(files) {
  const models = [];
  const errors = [];
  for (const file of files) {
    try {
      const sor = parseSor(readFileSync(file));
      models.push(toModel(sor, basename(file)));
    } catch (e) {
      errors.push({ file, error: e.message });
    }
  }
  return { models, errors };
}

// Same, but keeps the source path next to each parsed model (GUI needs it).
export function loadEntries(files) {
  return files.map((file) => {
    try {
      const sor = parseSor(readFileSync(file));
      return { path: file, model: toModel(sor, basename(file)) };
    } catch (e) {
      return { path: file, error: e.message };
    }
  });
}

// Compact row for tables (GUI / summary).
export function traceRow(model) {
  return {
    file: model.file,
    date: model.date.toISOString(),
    wavelength: model.wavelengthNm,
    cable: model.gen.cableId,
    fiber: model.gen.fiberId,
    operator: model.gen.operator,
    events: model.events.length,
    rangeKm: +(model.rangeM / 1000).toFixed(3),
    pulse: model.pulseNs.join("/"),
    crc: model.checksumOk,
  };
}

export async function exportXlsx(out, models) {
  const abs = resolve(out);
  mkdirSync(dirname(abs), { recursive: true });
  await writeWorkbook(abs, models, { summary: models.length > 1 });
  return abs;
}

export function exportCsv(out, models) {
  const abs = resolve(out);
  mkdirSync(dirname(abs), { recursive: true });
  writeEventsCsv(abs, models);
  return abs;
}

// "2025-01-31 10:20" / "2025-01-31T10:20:30" / "31.01.2025 10:20" — interpreted as UTC.
export function parseDateArg(value) {
  const s = String(value).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (m) {
    const [, y, mo, d, h = 0, mi = 0, se = 0] = m;
    return Math.floor(Date.UTC(+y, +mo - 1, +d, +h, +mi, +se) / 1000);
  }
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?: (\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (m) {
    const [, d, mo, y, h = 0, mi = 0, se = 0] = m;
    return Math.floor(Date.UTC(+y, +mo - 1, +d, +h, +mi, +se) / 1000);
  }
  throw new Error(`не понимаю дату "${value}" (ожидается ГГГГ-ММ-ДД или ДД.ММ.ГГГГ, время UTC)`);
}

export function applyTemplate(tpl, vars) {
  return String(tpl).replace(/\{(cable|fiber|index|index3|name|ext|date)\}/g, (_, k) => String(vars[k] ?? ""));
}

/**
 * Batch-edit metadata of SOR v2 files into a separate directory.
 * @returns {{written:number, planned:Array, errors:Array, target:string}}
 */
export function transformFiles(files, opts) {
  const {
    outDir,
    dateTs,
    shiftDays,
    fiberStart,
    fiberId,
    cable,
    operator,
    locationA,
    locationB,
    comment,
    ior,
    template,
    dryRun = false,
    onProgress,
  } = opts;

  const target = resolve(outDir);
  if (!dryRun) mkdirSync(target, { recursive: true });

  const fields = {};
  if (cable !== undefined && cable !== "") fields.cableId = cable;
  if (operator !== undefined && operator !== "") fields.operator = operator;
  if (locationA !== undefined && locationA !== "") fields.locationA = locationA;
  if (locationB !== undefined && locationB !== "") fields.locationB = locationB;
  if (comment !== undefined && comment !== "") fields.comment = comment;

  const planned = [];
  const errors = [];
  const used = new Set();
  let written = 0;

  files.forEach((file, index) => {
    try {
      const buf = readFileSync(file);
      let meta;
      try {
        meta = readMetadata(buf);
      } catch (e) {
        throw new Error(`не читается для записи: ${e.message}`);
      }
      if (!meta) throw new Error("нет блока GenParams (не SOR v2?)");

      const edits = { ...fields };
      if (ior !== undefined && ior !== "") {
        const n = Number(ior);
        if (!(n > 1 && n < 2)) throw new Error("показатель преломления должен быть в диапазоне 1..2");
        edits.ior = n;
      }
      if (dateTs !== undefined) edits.timestamp = dateTs;
      else if (shiftDays !== undefined && shiftDays !== "") {
        const days = Number(shiftDays);
        if (!Number.isFinite(days)) throw new Error("сдвиг даты должен быть числом");
        if (meta.timestamp != null) edits.timestamp = meta.timestamp + Math.round(days * 86400);
      }
      if (fiberStart !== undefined && fiberStart !== "") {
        const start = Number(fiberStart);
        if (!Number.isFinite(start)) throw new Error("начальный номер волокна должен быть числом");
        edits.fiberId = String(start + index);
      }
      if (fiberId !== undefined && fiberId !== "") edits.fiberId = String(fiberId);

      const srcName = basename(file, extname(file));
      const ext = extname(file);
      const vars = {
        cable: edits.cableId ?? meta.cableId,
        fiber: edits.fiberId ?? meta.fiberId,
        index: index + 1,
        index3: String(index + 1).padStart(3, "0"),
        name: srcName,
        ext: ext.replace(/^\./, ""),
        date: new Date((edits.timestamp ?? meta.timestamp ?? 0) * 1000).toISOString().slice(0, 10),
      };
      const outName = template ? applyTemplate(template, vars) : `${srcName}${ext}`;
      const outPath = resolve(join(target, outName));

      if (outPath.toLowerCase() === resolve(file).toLowerCase()) {
        throw new Error("результат совпадает с исходным файлом (перезапись запрещена)");
      }
      if (used.has(outPath.toLowerCase())) throw new Error(`имя уже занято в этой партии: ${outName}`);
      used.add(outPath.toLowerCase());

      if (!dryRun) {
        writeFileSync(outPath, updateSor(buf, edits));
        written++;
      }
      planned.push({ file, out: outName, path: outPath });
      onProgress?.(index + 1, files.length, { file, out: outName, ok: true });
    } catch (e) {
      errors.push({ file, error: e.message });
      onProgress?.(index + 1, files.length, { file, error: e.message, ok: false });
    }
  });

  return { written, planned, errors, target };
}
