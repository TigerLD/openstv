#!/usr/bin/env node
// OpenSTV — batch export and batch editing for OTDR traces (SOR).
//
//   OpenSTV                       графическая оболочка (браузер)
//   OpenSTV gui [--port N] [--no-browser]
//   OpenSTV inspect <files-or-dirs...>
//   OpenSTV export  --out report.xlsx <files-or-dirs...>
//   OpenSTV csv     --out events.csv  <files-or-dirs...>
//   OpenSTV transform --out-dir out <files-or-dirs...> [options]
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { isSea } from "node:sea";
import {
  collect,
  exportCsv,
  exportXlsx,
  load,
  parseDateArg,
  transformFiles,
} from "./src/core.mjs";
import { openBrowserUrl, startGui } from "./src/gui.mjs";

const VERSION = "1.3.2";

const HELP = `OpenSTV ${VERSION} — пакетный экспорт и обработка OTDR-трасс (SOR/Bellcore)

Запуск без параметров открывает графическую оболочку в браузере.
Двойной щелчок по OpenSTV.exe делает то же самое.

Использование:
  OpenSTV                                   графическая оболочка
  OpenSTV gui [--port 8756] [--no-browser]  графическая оболочка
  OpenSTV inspect   <файлы-или-папки...>
  OpenSTV export    [--out report.xlsx] <файлы-или-папки...>
  OpenSTV csv       [--out events.csv]  <файлы-или-папки...>
  OpenSTV transform --out-dir <папка> [параметры] <файлы-или-папки...>

Команды:
  gui        локальный интерфейс: таблица трасс, отчёты, пакетные изменения
  inspect    показать содержимое трасс в консоли
  export     Excel-отчёт: сводка по всем трассам + лист на каждую трассу
  csv        один CSV: по строке на событие (;, UTF-8 BOM — открывается в Excel)
  transform  пакетно изменить метаданные SOR и сохранить копии

Параметры transform:
  --out-dir <dir>        куда писать результат (обязательно)
  --date <когда>         единая дата/время измерения, UTC: ГГГГ-ММ-ДД[ ЧЧ:ММ[:СС]]
                         или ДД.ММ.ГГГГ[ ЧЧ:ММ[:СС]]
  --shift-days <N>       сдвинуть дату каждой трассы на N суток (может быть < 0)
  --fiber-start <N>      перенумеровать волокна: N, N+1, N+2... по порядку файлов
  --fiber-id <STR>       одно значение волокна для всех файлов
  --cable <STR>          кабель / код волокна (GenParams cable ID)
  --operator <STR>       оператор
  --location-a <STR>     начало трассы (A)
  --location-b <STR>     конец трассы (B)
  --comment <STR>        комментарий
  --ior <N>              показатель преломления, например 1.4680
  --name-template <T>    шаблон имени файла: {cable} {fiber} {index} {index3}
                         {name} {ext} {date}. Пример: "{cable}_{fiber}.sor"
  --dry-run              только показать, что будет сделано
  --quiet                не печатать список файлов

Общие параметры:
  --help, -h, /?         эта справка
  --version              версия
`;

function fatal(msg, code = 2) {
  console.error(`OpenSTV: ${msg}`);
  process.exit(code);
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "-?" || a === "/?") {
      flags.help = true;
      continue;
    }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

function printInspect(models) {
  for (const m of models) {
    console.log("=".repeat(72));
    console.log(`${m.file}  (${m.format})`);
    console.log(`  дата: ${m.date.toISOString()}  λ=${m.wavelengthNm} нм  импульс=${m.pulseNs.join("/")} нс`);
    console.log(`  точек: ${m.points}  длина: ${(m.rangeM / 1000).toFixed(3)} км  разрешение: ${m.resolutionM.toFixed(3)} м  n=${m.ior}`);
    console.log(`  кабель: ${m.gen.cableId}  волокно: ${m.gen.fiberId}  оператор: ${m.gen.operator}`);
    console.log(`  прибор: ${m.sup.otdr}  S/N: ${m.sup.otdrSerial}  ПО: ${m.sup.software}  CRC: ${m.checksumOk ? "OK" : "BAD"}`);
    for (const e of m.events) {
      console.log(
        `   #${e.number}  ${(e.distanceM / 1000).toFixed(6)} км  потери ${e.spliceLossDb.toFixed(3)} дБ  ` +
        `отраж. ${e.reflectionLossDb.toFixed(3)} дБ  наклон ${e.slopeDbPerKm.toFixed(3)} дБ/км  ${e.type}`
      );
    }
  }
}

async function cmdTransform(files, flags) {
  const outDir = flags["out-dir"];
  if (!outDir || outDir === true) fatal("transform: нужен --out-dir <папка>");
  const dryRun = !!flags["dry-run"];
  const quiet = !!flags["quiet"];

  let dateTs;
  if (flags.date !== undefined) {
    try {
      dateTs = parseDateArg(flags.date);
    } catch (e) {
      fatal(e.message);
    }
  }

  const result = transformFiles(files, {
    outDir: String(outDir),
    dateTs,
    shiftDays: flags["shift-days"],
    fiberStart: flags["fiber-start"],
    fiberId: flags["fiber-id"],
    cable: flags.cable,
    operator: flags.operator,
    locationA: flags["location-a"],
    locationB: flags["location-b"],
    comment: flags.comment,
    ior: flags.ior,
    template: flags["name-template"],
    dryRun,
    onProgress: (_i, _total, item) => {
      if (quiet) return;
      if (item && item.ok) console.log(`${dryRun ? "plan" : "ok  "} ${basename(item.file)} -> ${item.out}`);
    },
  });

  for (const e of result.errors) console.error(`[skip] ${basename(e.file)}: ${e.error}`);
  const verb = dryRun ? "запланировано" : "записано";
  console.log(`${verb}: ${dryRun ? result.planned.length : result.written} из ${files.length} трасс -> ${result.target}`);
  if (result.errors.length) process.exitCode = 1;
}

const PORT_FILE = join(tmpdir(), "openstv.port");
const TOKEN_FILE = join(tmpdir(), "openstv.token");

async function findRunningInstance() {
  try {
    const port = Number(readFileSync(PORT_FILE, "utf8").trim());
    const token = readFileSync(TOKEN_FILE, "utf8").trim();
    if (!Number.isInteger(port) || port <= 0 || !token) return null;
    const url = `http://127.0.0.1:${port}/`;
    const r = await fetch(`${url}api/ping`, {
      headers: { "x-openstv-token": token },
      signal: AbortSignal.timeout(600),
    });
    if (!r.ok) return null;
    const info = await r.json().catch(() => null);
    if (!info || !info.ok) return null;
    return { url, token };
  } catch {
    return null;
  }
}

async function cmdGui(flags) {
  const port = flags.port !== undefined && flags.port !== true ? Number(flags.port) : 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) fatal("gui: некорректный --port");

  if (port === 0) {
    const running = await findRunningInstance();
    if (running) {
      const url = `${running.url}?token=${running.token}`;
      if (flags["no-browser"] !== true) openBrowserUrl(url);
      console.log(`OpenSTV уже запущен: ${url}`);
      return;
    }
  }

  const { url, token } = await startGui({ port, openBrowser: flags["no-browser"] !== true });
  try {
    writeFileSync(PORT_FILE, String(new URL(url).port), "utf8");
    writeFileSync(TOKEN_FILE, token, "utf8");
  } catch {
    // Not critical: only affects reuse of a running instance.
  }
  console.log("");
  console.log(`  OpenSTV ${VERSION}`);
  console.log(`  Интерфейс: ${url}`);
  console.log("  Это окно можно свернуть. Закройте его, чтобы остановить OpenSTV.");
  console.log("");
}

function userArgs() {
  if (!isSea()) return process.argv.slice(2);
  const a = [...process.argv];
  while (a.length && resolve(a[0]).toLowerCase() === resolve(process.execPath).toLowerCase()) a.shift();
  return a;
}

async function main() {
  process.title = "OpenSTV";
  const argv = userArgs();
  const [cmd, ...rest] = argv;

  if (!cmd) {
    await cmdGui({});
    return;
  }
  if (cmd === "--help" || cmd === "help" || cmd === "-h") {
    console.log(HELP);
    return;
  }
  if (cmd === "--version" || cmd === "version") {
    console.log(`OpenSTV ${VERSION}`);
    return;
  }

  const { positional, flags } = parseArgs(rest);
  if (flags.help) {
    console.log(HELP);
    return;
  }
  if (cmd === "gui") {
    await cmdGui(flags);
    return;
  }
  if (positional.length === 0) {
    console.error(HELP);
    process.exit(2);
  }

  const files = collect(positional);
  if (files.length === 0) fatal("не найдено ни одного файла трасс", 1);

  if (cmd === "transform") {
    await cmdTransform(files, flags);
    return;
  }

  const { models, errors } = load(files);
  for (const e of errors) console.error(`[skip] ${basename(e.file)}: ${e.error}`);

  if (cmd === "inspect") {
    if (models.length === 0) fatal("нет читаемых SOR-файлов", 1);
    printInspect(models);
    return;
  }

  if (cmd !== "export" && cmd !== "csv") fatal(`неизвестная команда: ${cmd}`);
  if (models.length === 0) fatal("нет читаемых SOR-файлов", 1);

  const out = flags.out !== undefined && flags.out !== true
    ? String(flags.out)
    : cmd === "csv" ? "events.csv" : "report.xlsx";

  if (cmd === "export") {
    const abs = await exportXlsx(out, models);
    const events = models.reduce((a, m) => a + m.events.length, 0);
    console.log(`written ${abs} (${models.length} trace(s), ${events} events)`);
  } else {
    const abs = exportCsv(out, models);
    console.log(`written ${abs} (${models.reduce((a, m) => a + m.events.length, 0)} events)`);
  }
}

main().catch((e) => {
  console.error(e?.stack ?? e);
  process.exit(1);
});
