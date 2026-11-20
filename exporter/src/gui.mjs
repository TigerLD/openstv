// Local graphical shell: a tiny HTTP server + browser UI (no external deps).
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import {
  collect,
  exportCsv,
  exportXlsx,
  loadEntries,
  parseDateArg,
  traceRow,
  transformFiles,
} from "./core.mjs";
import { writeSpanReport } from "./excel.mjs";
import { writeProtocol } from "./protocol.mjs";
import { createSor } from "./generator.mjs";
import { parseSor } from "./sor.mjs";
import { toModel } from "./model.mjs";
import { readTraceData, readTraceEvents, rewriteSor, updateSor } from "./writer.mjs";

const VERSION = "1.3.2";
const SOL_KM_PER_US = 0.299792458;

const PAGE = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenSTV</title>
<style>
  :root { --face:#f0f0f0; --panel:#fff; --border:#a6a6a6; --light:#d9d9d9; --sel:#0078d7; --text:#000; --muted:#666; --accent:#0a64ad; --ok:#107c10; --warn:#9a6700; --err:#c42b1c; }
  * { box-sizing:border-box; }
  [hidden] { display:none !important; }
  html, body { height:100%; }
  body { margin:0; background:var(--face); color:var(--text); font:9pt "Segoe UI", Tahoma, sans-serif; overflow:hidden; }
  button { font:9pt "Segoe UI", Tahoma, sans-serif; padding:3px 10px; border:1px solid #adadad; background:#fdfdfd; cursor:pointer; white-space:nowrap; }
  button:hover:not(:disabled) { background:#e5f3ff; border-color:#7eb4ea; }
  button:active:not(:disabled) { background:#cce8ff; }
  button:disabled { color:#999; background:#f5f5f5; cursor:default; }
  button.primary { background:#e1f0fb; border-color:#7eb4ea; font-weight:600; }
  button.wide { width:100%; margin-top:6px; }
  button.ghost { padding:3px 8px; }
  input, select, textarea { font:9pt "Segoe UI", Tahoma, sans-serif; border:1px solid #adadad; background:#fff; padding:2px 4px; min-width:0; }
  input:focus, select:focus, textarea:focus { outline:1px solid #0078d7; outline-offset:-1px; }
  textarea { width:100%; resize:vertical; font:9pt Consolas, "Courier New", monospace; }
  /* ---- menu bar ---- */
  .menubar { display:flex; align-items:center; height:23px; background:var(--face); border-bottom:1px solid #d0d0d0; user-select:none; }
  .menubar .brand { font-weight:600; padding:0 10px 0 8px; }
  .menu { position:relative; }
  .menu > button { border:0; background:transparent; height:23px; padding:0 9px; }
  .menu > button:hover, .menu.open > button { background:#cce8ff; }
  .menu .pop { position:absolute; left:0; top:23px; min-width:245px; background:#fff; border:1px solid var(--border); box-shadow:2px 2px 5px rgba(0,0,0,.18); z-index:60; padding:2px 0; display:none; }
  .menu.open .pop { display:block; }
  .menu .pop button { display:block; width:100%; text-align:left; border:0; background:#fff; padding:4px 24px 4px 26px; }
  .menu .pop button:hover { background:#cce8ff; }
  .menu .pop .sep { height:1px; background:#e2e2e2; margin:3px 0; }
  .menubar .spacer { flex:1; }
  .menubar .ver { color:var(--muted); padding:0 10px; font-size:8pt; }
  /* ---- toolbar ---- */
  .toolbar { display:flex; align-items:stretch; gap:1px; padding:2px 4px; height:58px; background:var(--face); border-bottom:1px solid #c8c8c8; overflow-x:auto; overflow-y:hidden; }
  .toolbar button { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:0; min-width:50px; height:52px; border:1px solid transparent; background:transparent; padding:1px 5px; flex:none; }
  .toolbar button:hover:not(:disabled) { background:#e5f3ff; border-color:#99c9e8; }
  .toolbar button .ico { font-size:18px; line-height:22px; color:#2b579a; }
  .toolbar button .cap { font-size:8pt; color:#222; }
  .toolbar .sep { width:1px; background:#c8c8c8; margin:6px 5px; }
  /* ---- work area ---- */
  .work { display:grid; grid-template-columns:284px minmax(0,1fr) 300px; height:calc(100vh - 23px - 58px - 23px); min-height:320px; }
  .work.nofiles { grid-template-columns:0 minmax(0,1fr) 300px; }
  .files { display:flex; flex-direction:column; background:#fff; border-right:1px solid #c8c8c8; min-width:0; overflow:hidden; }
  .pathbar { display:flex; flex-wrap:wrap; gap:3px; padding:3px; border-bottom:1px solid #e0e0e0; background:var(--face); align-items:center; }
  .pathbar input { flex:1; }
  .stats { padding:3px 6px; color:var(--muted); font-size:8pt; border-bottom:1px solid #e0e0e0; background:var(--face); }
  .filelist { flex:1; overflow:auto; }
  .viewer { display:flex; flex-direction:column; min-width:0; background:var(--face); }
  .viewhead { display:flex; align-items:center; gap:8px; padding:2px 6px; border-bottom:1px solid #d0d0d0; background:var(--face); font-size:8.5pt; min-height:24px; overflow:hidden; }
  .viewhead .name { font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:34%; }
  .viewhead .meta { color:var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; flex:1; }
  .viewhead button { flex:none; }
  .viewhead button.slim { padding:1px 6px; font-size:11px; }
  .viewhead .spacer { flex:1; }
  .chartarea { flex:1; min-height:160px; padding:2px; background:#fff; border-bottom:1px solid #c8c8c8; }
  #chart { width:100%; height:100%; display:block; background:#fff; cursor:crosshair; touch-action:none; }
  .eventarea { height:184px; display:flex; flex-direction:column; background:#fff; }
  .eventarea .evtable { flex:1; max-height:none; overflow:auto; }
  .side { overflow:auto; background:#fff; border-left:1px solid #c8c8c8; }
  .sidehead { padding:3px 6px; background:#e8e8e8; border-bottom:1px solid #c8c8c8; font-weight:600; font-size:8.5pt; }
  .params { border-top:1px solid #e0e0e0; font-size:8.5pt; }
  .params table { border-collapse:collapse; width:100%; }
  .params td { padding:1px 5px; border-bottom:1px solid #ededed; vertical-align:top; }
  .params td.k { width:46%; color:#333; background:#fafafa; }
  .params td.v { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .statusbar { height:23px; display:flex; align-items:center; gap:12px; padding:0 6px; background:var(--face); border-top:1px solid #c8c8c8; font-size:8.5pt; white-space:nowrap; overflow:hidden; }
  .statusbar .spacer { flex:1; }
  .statusbar label { display:inline-flex; align-items:center; gap:4px; }
  /* ---- tables ---- */
  .tablewrap { overflow:auto; }
  .evtable { overflow:auto; }
  table { border-collapse:collapse; width:100%; font-size:8.5pt; }
  thead th { position:sticky; top:0; z-index:2; background:#f0f0f0; border:1px solid #c8c8c8; padding:2px 5px; text-align:left; font-weight:400; white-space:nowrap; }
  tbody td { border:1px solid #e6e6e6; padding:1px 5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  tbody tr:nth-child(even) td { background:#fafafa; }
  tbody tr:hover td { background:#eaf6ff; }
  tbody tr.sel td { background:var(--sel); color:#fff; }
  th.r, td.r { text-align:right; }
  th.c, td.c { text-align:center; width:30px; }
  .bad { color:var(--err); font-weight:600; }
  /* ---- dialogs ---- */
  .overlay { position:fixed; inset:0; background:rgba(0,0,0,.18); display:flex; align-items:center; justify-content:center; z-index:100; }
  .overlay[hidden] { display:none; }
  .dialog { background:var(--face); border:1px solid #7a7a7a; box-shadow:0 4px 18px rgba(0,0,0,.25); width:min(880px,94vw); max-height:92vh; display:flex; flex-direction:column; }
  .dialog.narrow { width:min(520px,94vw); }
  .dlgtitle { display:flex; align-items:center; background:#e8e8e8; border-bottom:1px solid #c8c8c8; padding:3px 4px 3px 8px; font-weight:600; }
  .dlgtitle span { flex:1; }
  .dlgtitle button { border:0; background:transparent; padding:2px 8px; }
  .dlgbody { padding:8px; overflow:auto; }
  .dlgbody h3 { margin:10px 0 4px; font-size:9pt; color:#333; border-bottom:1px solid #d8d8d8; padding-bottom:2px; }
  .dlgbody h3:first-child { margin-top:0; }
  .dlgfoot { display:flex; gap:6px; justify-content:flex-end; padding:6px 8px; border-top:1px solid #d0d0d0; background:var(--face); }
  .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:6px 14px; }
  .edits { display:grid; grid-template-columns:repeat(3,1fr); gap:4px 12px; }
  .fl { display:block; color:#444; font-size:8.5pt; margin:6px 0 2px; }
  .span2 { grid-column:1 / -1; }
  .row { display:flex; gap:6px; align-items:center; flex-wrap:wrap; }
  .chk { display:inline-flex; gap:5px; align-items:center; }
  .lbl { color:#444; }
  pre#log { margin:0; max-height:340px; overflow:auto; font:9pt/1.4 Consolas, monospace; background:#fff; color:#111; border:1px solid #adadad; padding:6px; white-space:pre-wrap; }
  #log .ok { color:var(--ok); } #log .warn { color:var(--warn); } #log .err { color:var(--err); }
  body.busy { cursor:progress; }
  .hint { color:var(--muted); font-size:8pt; }
  /* ---- print ---- */
  #printArea { display:none; }
  @media print {
    body { background:#fff; overflow:visible; }
    body > *:not(#printArea) { display:none !important; }
    #printArea { display:block !important; font:10pt/1.4 "Times New Roman", serif; color:#000; }
    #printArea h1 { font-size:15pt; margin:0 0 2px; }
    #printArea h2 { font-size:11pt; margin:12px 0 5px; color:#222; }
    #printArea .note { color:#555; margin-bottom:8px; font-size:8.5pt; }
    #printArea table { width:100%; border-collapse:collapse; font-size:8.5pt; }
    #printArea th, #printArea td { border:1px solid #666; padding:2px 4px; text-align:left; }
    #printArea tr { page-break-inside:avoid; }
    #printArea svg { width:100%; height:230px; display:block; }
  }
  @media (max-width:1100px) {
    .work { grid-template-columns:240px minmax(0,1fr) 250px; }
    .edits { grid-template-columns:1fr 1fr; }
  }
  @media (max-width:820px) {
    .work { grid-template-columns:200px minmax(0,1fr); }
    .side { display:none; }
  }
</style>
</head>
<body>
<div class="menubar">
  <div class="brand">OpenSTV</div>
  <div class="menu" data-menu><button>Файл</button><div class="pop">
    <button data-cmd="browseFiles">Открыть файлы…</button>
    <button data-cmd="browse">Открыть папку…</button>
    <button data-cmd="scan">Сканировать</button>
    <div class="sep"></div>
    <button data-cmd="create">Создать трассу…</button>
    <button data-cmd="save">Сохранить изменённую копию</button>
    <button data-cmd="closeTrace">Закрыть трассу</button>
    <div class="sep"></div>
    <button data-cmd="quit">Выход</button>
  </div></div>
  <div class="menu" data-menu><button>Вид</button><div class="pop">
    <button data-cmd="files">Таблица файлов</button>
    <button data-cmd="log">Журнал</button>
    <button data-cmd="settings">Настройки…</button>
    <div class="sep"></div>
    <button data-cmd="zoom1">Показать всю трассу</button>
  </div></div>
  <div class="menu" data-menu><button>Отчёт</button><div class="pop">
    <button data-cmd="xlsx">Отчёт по трассам в Excel</button>
    <button data-cmd="csv">Таблица событий в CSV</button>
    <button data-cmd="print">Печать текущей трассы</button>
    <button data-cmd="printAll">Печать всех выбранных</button>
    <div class="sep"></div>
    <button data-cmd="span">Отчёт по участку A→B</button>
    <button data-cmd="protocol">Протокол ВОЛС…</button>
  </div></div>
  <div class="menu" data-menu><button>Сервис</button><div class="pop">
    <button data-cmd="batch">Пакетное преобразование…</button>
    <button data-cmd="measure">Параметры измерения…</button>
    <button data-cmd="props">Свойства трассы и события…</button>
    <div class="sep"></div>
    <button data-cmd="bidir">Двунаправленный режим</button>
    <button data-cmd="crop">Обрезать по A/B</button>
    <button data-cmd="smooth">Шумоподавитель A/B</button>
    <button data-cmd="visual">Правка графика</button>
  </div></div>
  <div class="menu" data-menu><button>Справка</button><div class="pop">
    <button data-cmd="about">О программе</button>
    <button data-cmd="gaps">Что умеет OpenSTV</button>
  </div></div>
  <div class="spacer"></div>
  <div class="ver">v__VERSION__</div>
</div>

<div class="toolbar">
  <button id="tbOpen" title="Открыть файлы трасс"><span class="ico">📂</span><span class="cap">Открыть</span></button>
  <button id="tbSave" title="Сохранить изменённую копию"><span class="ico">💾</span><span class="cap">Сохранить</span></button>
  <button id="tbPrint" title="Печать / PDF"><span class="ico">🖨</span><span class="cap">Печать</span></button>
  <button id="tbTable" title="Показать или скрыть список файлов"><span class="ico">▦</span><span class="cap">Таблица</span></button>
  <span class="sep"></span>
  <button id="tbZoomIn" title="Приблизить"><span class="ico">🔍</span><span class="cap">Зум +</span></button>
  <button id="tbZoomOut" title="Отдалить"><span class="ico">🔎</span><span class="cap">Зум −</span></button>
  <button id="tbZoom1" title="Показать всю трассу"><span class="ico">1:1</span><span class="cap">Зум 1:1</span></button>
  <span class="sep"></span>
  <button id="tbSettings" title="Настройки"><span class="ico">⚙</span><span class="cap">Настройки</span></button>
  <button id="tbProps" title="Свойства трассы и события"><span class="ico">🛈</span><span class="cap">Свойства</span></button>
  <button id="tbReports" title="Отчёты и протоколы"><span class="ico">📊</span><span class="cap">Отчёты</span></button>
</div>

<div class="work" id="work">
  <aside class="files" id="filesPane">
    <div class="pathbar">
      <input id="dir" placeholder="Папка с трассами или файл">
      <button id="browseDir" title="Выбрать папку">📁</button>
      <button id="browseFiles" title="Выбрать один или несколько файлов">📄</button>
      <button class="primary" id="scan" title="Сканировать папку">Сканировать</button>
    </div>
    <label class="chk" style="padding:2px 6px;border-bottom:1px solid #e0e0e0"><input type="checkbox" id="rec" checked> подпапки</label>
    <div class="stats" id="stats">Папка не выбрана</div>
    <div class="filelist" id="resultCard" hidden>
      <table>
        <thead><tr>
          <th class="c"><input type="checkbox" id="all" checked></th>
          <th>Файл</th><th class="r">Длина, км</th><th>CRC</th>
        </tr></thead>
        <tbody id="tbody"></tbody>
      </table>
    </div>
  </aside>

  <section class="viewer" id="viewerCard" hidden>
    <div class="viewhead">
      <span class="name" id="vName">—</span>
      <span class="meta" id="vMeta"></span>
      <span class="spacer"></span>
      <button class="ghost slim" id="vReveal" title="Открыть папку с файлом">📂</button>
      <button class="ghost slim" id="vPrint" title="Печать / PDF">🖨</button>
      <button class="ghost slim" id="vClose" title="Закрыть трассу">✕</button>
    </div>
    <div class="chartarea">
      <svg id="chart" viewBox="0 0 1000 340" preserveAspectRatio="none"></svg>
    </div>
    <div class="eventarea">
      <div class="sidehead" style="display:flex;align-items:center;gap:10px">События<span class="hint" id="evSel"></span></div>
      <div class="evtable">
        <table><thead><tr>
          <th>Тип</th><th class="r">№</th><th class="r">Дистанция, м</th>
          <th class="r">Потери, дБ</th><th class="r">Отражение, дБ</th><th class="r">Затухание, дБ/км</th><th>Комментарий</th>
        </tr></thead><tbody id="vEvents"></tbody></table>
      </div>
    </div>
  </section>

  <aside class="side">
    <div class="sidehead">Параметры</div>
    <div class="params" id="vParams"></div>
  </aside>
</div>

<div class="statusbar">
  <span id="vReadout">Курсоры: —</span>
  <span id="lgBack" hidden style="color:#107c10">обратная трасса</span>
  <span class="spacer"></span>
  <label title="Линейная аппроксимация наклона между курсорами"><input type="checkbox" id="lsa"> LSA</label>
  <span id="statusInfo"></span>
</div>

<div class="overlay" id="dlgProps" hidden>
  <div class="dialog">
    <div class="dlgtitle"><span>Свойства трассы и события</span><button data-close="dlgProps">✕</button></div>
    <div class="dlgbody">
      <h3>Событие</h3>
      <div class="edits">
        <div><label class="fl">Расстояние, км</label><input id="evDist"></div>
        <div><label class="fl">Потери, дБ</label><input id="evLoss" value="0"></div>
        <div><label class="fl">Отражение, дБ</label><input id="evRefl" value="0"></div>
        <div><label class="fl">Затухание, дБ/км</label><input id="evSlope" value="0"></div>
        <div><label class="fl">Тип</label><select id="evType"><option value="loss">Потери</option><option value="reflection">Отражение</option></select></div>
        <div><label class="fl">Комментарий</label><input id="evComment"></div>
      </div>
      <div class="row" style="margin-top:6px">
        <button id="evAdd">Добавить</button>
        <button id="evUpdate">Сохранить выбранное</button>
        <button id="evDelete">Удалить выбранное</button>
        <span class="hint" id="evSelDlg"></span>
      </div>

      <h3>Паспорт трассы</h3>
      <div class="edits">
        <div><label class="fl">Дата и время (UTC)</label><input id="eDate"></div>
        <div><label class="fl">Кабель</label><input id="eCable"></div>
        <div><label class="fl">Волокно</label><input id="eFiber"></div>
        <div><label class="fl">Оператор</label><input id="eOperator"></div>
        <div><label class="fl">Начало (A)</label><input id="eLocA"></div>
        <div><label class="fl">Конец (B)</label><input id="eLocB"></div>
        <div><label class="fl">Показатель преломления</label><input id="eIor"></div>
        <div><label class="fl">Комментарий</label><input id="eComment"></div>
        <div class="span2"><label class="fl">Куда сохранить копию</label>
          <div class="row"><input id="eOutDir" placeholder="рядом с исходным файлом"><button class="ghost" data-pick="eOutDir">…</button></div></div>
      </div>
      <button class="primary wide" id="vSave">Сохранить изменённую копию</button>

      <h3>Операции с трассой</h3>
      <div class="edits">
        <div><label class="fl">Ширина сглаживания, точек</label><input id="dWidth" value="9"></div>
        <div class="span2"><label class="fl">Куда сохранить результат</label>
          <div class="row"><input id="tOutDir" placeholder="рядом с исходным файлом"><button class="ghost" data-pick="tOutDir">…</button></div></div>
      </div>
      <div class="row" style="margin-top:6px">
        <button id="vCrop">Обрезать по A/B</button>
        <button id="vSmooth">Шумоподавить A/B</button>
        <button id="vBiDir">Двунаправленный режим</button>
        <button id="vVisual">Правка графика</button>
        <button id="vApplyVisual" disabled>Сохранить правку</button>
      </div>
      <div class="hint" style="margin-top:4px"><span id="vToolsHint"></span> <span id="vEditHint"></span></div>

      <div id="biDirBox" hidden>
        <h3>Двунаправленное сравнение <span id="biDirMeta" style="font-weight:400;color:#666"></span></h3>
        <div class="evtable" style="max-height:220px">
          <table><thead><tr>
            <th class="r">№</th><th class="r">Дистанция, м</th><th class="r">Прямые, дБ</th><th class="r">Обратные, дБ</th>
            <th class="r">Средние, дБ</th><th class="r">Отражение пр./обр.</th><th>Комментарий</th>
          </tr></thead><tbody id="biRows"></tbody></table>
        </div>
      </div>
    </div>
    <div class="dlgfoot"><button data-close="dlgProps">Закрыть</button></div>
  </div>
</div>

<div class="overlay" id="dlgBatch" hidden>
  <div class="dialog">
    <div class="dlgtitle"><span>Пакетное преобразование</span><button data-close="dlgBatch">✕</button></div>
    <div class="dlgbody">
      <div class="grid2">
        <div class="span2"><label class="fl">Папка результата</label>
          <div class="row"><input id="outDir"><button class="ghost" data-pick="outDir">…</button></div></div>
        <div><label class="fl">Дата и время (UTC)</label><input id="date" placeholder="2025-06-01 09:00"></div>
        <div><label class="fl">Сдвиг даты, суток</label><input id="shiftDays" placeholder="1 или -1"></div>
        <div><label class="fl">Волокна с номера</label><input id="fiberStart" placeholder="1"></div>
        <div><label class="fl">Кабель</label><input id="cable" placeholder="BN1"></div>
        <div><label class="fl">Оператор</label><input id="operator"></div>
        <div><label class="fl">Показатель преломления</label><input id="ior" placeholder="1.4680"></div>
        <div><label class="fl">Начало (A)</label><input id="locationA"></div>
        <div><label class="fl">Конец (B)</label><input id="locationB"></div>
        <div><label class="fl">Комментарий</label><input id="comment"></div>
        <div><label class="fl">Импульс, нс</label><input id="mPulse" placeholder="10"></div>
        <div><label class="fl">Время накопления, с</label><input id="mAveraging" placeholder="10"></div>
        <div class="span2"><label class="fl">Шаблон имени файла</label>
          <input id="template" placeholder="{cable}_{fiber}.sor"></div>
      </div>
      <label class="chk" style="margin-top:8px"><input type="checkbox" id="dry"> только план (dry-run)</label>
      <div class="dlgfoot" style="padding:8px 0 0;border:0;background:transparent">
        <button class="primary" id="doTransform">Применить к выбранным</button>
        <button id="doMeasure">Применить параметры измерения</button>
      </div>
    </div>
    <div class="dlgfoot"><button data-close="dlgBatch">Закрыть</button></div>
  </div>
</div>

<div class="overlay" id="dlgReports" hidden>
  <div class="dialog">
    <div class="dlgtitle"><span>Отчёты и документация</span><button data-close="dlgReports">✕</button></div>
    <div class="dlgbody">
      <h3>Excel и CSV</h3>
      <label class="fl">Excel-файл</label>
      <div class="row"><input id="xlsxOut"><button class="ghost" data-pick="xlsx">…</button></div>
      <button class="primary wide" id="doXlsx">Экспорт Excel по выбранным</button>
      <label class="fl">CSV-файл</label>
      <div class="row"><input id="csvOut"><button class="ghost" data-pick="csv">…</button></div>
      <button class="wide" id="doCsv">Экспорт CSV по выбранным</button>
      <button class="wide" id="doPrintAll">Печать / PDF по выбранным</button>

      <h3>Участок A→B (GPON)</h3>
      <div class="row">
        <span class="lbl">событие A</span><input id="spanA" type="number" min="1" value="1" style="width:70px">
        <span class="lbl">событие B</span><input id="spanB" type="number" min="2" value="2" style="width:70px">
        <input id="spanOut" placeholder="span_report.xlsx">
        <button class="ghost" data-pick="spanOut">…</button>
      </div>
      <button class="wide" id="doSpan">Отчёт по участку в Excel</button>

      <h3>Протокол ВОЛС (РД 45.156-2000)</h3>
      <select id="protoKind" style="width:100%">
        <option value="rd-4">ВОЛС-РД-4 — затухание волокон</option>
        <option value="rd-6">ВОЛС-РД-6 — рефлектометрия</option>
        <option value="pte-8">ВОЛС-ПТЭ-8 — приёмка участка</option>
      </select>
      <div class="row" style="margin-top:4px"><input id="protoOrg" placeholder="Организация"><input id="protoObject" placeholder="Объект / участок"></div>
      <div class="row" style="margin-top:4px"><input id="protoCable" placeholder="Кабель"><input id="protoNorm" placeholder="Норма, дБ/км" value="0.35" style="width:130px"><span class="hint">дБ/км</span></div>
      <div class="row" style="margin-top:4px"><input id="protoOut" placeholder="protocol.html"><button class="ghost" data-pick="protoOut">…</button></div>
      <button class="wide" id="doProtocol">Создать протокол</button>
    </div>
    <div class="dlgfoot"><button data-close="dlgReports">Закрыть</button></div>
  </div>
</div>

<div class="overlay" id="dlgCreate" hidden>
  <div class="dialog">
    <div class="dlgtitle"><span>Создание новой рефлектограммы</span><button data-close="dlgCreate">✕</button></div>
    <div class="dlgbody">
      <div class="edits">
        <div><label class="fl">Длина, км</label><input id="gRange" value="2"></div>
        <div><label class="fl">Точек</label><input id="gPoints" value="4000"></div>
        <div><label class="fl">Длина волны, нм</label><input id="gWave" value="1310"></div>
        <div><label class="fl">Импульс, нс</label><input id="gPulse" value="10"></div>
        <div><label class="fl">Показатель преломления</label><input id="gIor" value="1.4680"></div>
        <div><label class="fl">Затухание, дБ/км</label><input id="gSlope" value="0.35"></div>
        <div><label class="fl">Кабель</label><input id="gCable" value="TEST"></div>
        <div><label class="fl">Волокно</label><input id="gFiber" value="1"></div>
        <div><label class="fl">Оператор</label><input id="gOperator"></div>
        <div><label class="fl">Комментарий</label><input id="gComment" value="Смоделированная трасса"></div>
        <div><label class="fl">Имя файла</label><input id="gName" value="new_trace.sor"></div>
        <div><label class="fl">Папка результата</label>
          <div class="row"><input id="gOutDir" placeholder="куда записать"><button class="ghost" data-pick="gOutDir">…</button></div></div>
      </div>
      <label class="fl" style="margin-top:8px">События: км; потери, дБ; отражение, дБ; комментарий — по одной строке</label>
      <textarea id="gEvents" rows="4" placeholder="0; 0.3; -50; разъём&#10;1.5; 0.25; -60; муфта"></textarea>
      <button class="primary wide" id="doCreate">Создать трассу</button>
      <div class="hint">Созданная трасса — моделирование; используйте её для проверки отчётов и печати.</div>
    </div>
    <div class="dlgfoot"><button data-close="dlgCreate">Закрыть</button></div>
  </div>
</div>

<div class="overlay" id="dlgLog" hidden>
  <div class="dialog">
    <div class="dlgtitle"><span>Журнал</span><button data-close="dlgLog">✕</button></div>
    <div class="dlgbody"><pre id="log"></pre></div>
    <div class="dlgfoot"><button data-close="dlgLog">Закрыть</button></div>
  </div>
</div>

<div class="overlay" id="dlgSettings" hidden>
  <div class="dialog narrow">
    <div class="dlgtitle"><span>Настройки</span><button data-close="dlgSettings">✕</button></div>
    <div class="dlgbody">
      <label class="chk"><input type="checkbox" id="setFiles" checked> показывать таблицу файлов</label>
      <label class="chk" style="margin-top:6px"><input type="checkbox" id="setLsa"> LSA: линейная аппроксимация наклона</label>
      <label class="chk" style="margin-top:6px"><input type="checkbox" id="setRatio"> пропорции графика 4:1 (иначе 1:1)</label>
      <div class="row" style="margin-top:10px"><button id="setReset">Сбросить сохранённые поля</button></div>
      <div class="hint" style="margin-top:8px">Настройки интерфейса хранятся локально в профиле приложения.</div>
    </div>
    <div class="dlgfoot"><button data-close="dlgSettings">Закрыть</button></div>
  </div>
</div>

<div id="printArea"></div>
<script>
var rows = [], selected = new Set();
function $(s) { return document.querySelector(s); }
function log(msg, cls) {
  var p = $("#log"), d = document.createElement("div");
  d.className = cls || "";
  d.textContent = msg;
  p.appendChild(d);
  p.scrollTop = p.scrollHeight;
}
function busy(on) {
  document.querySelectorAll("button").forEach(function (b) { b.disabled = on; });
  document.body.classList.toggle("busy", on);
}
async function api(path, body) {
  var r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  var j = {};
  try { j = await r.json(); } catch (e) {}
  if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
  return j;
}
function p2(n) { return String(n).padStart(2, "0"); }
function fmtDate(iso) {
  var d = new Date(iso);
  return p2(d.getUTCDate()) + "." + p2(d.getUTCMonth() + 1) + "." + d.getUTCFullYear() + " " + p2(d.getUTCHours()) + ":" + p2(d.getUTCMinutes());
}
function selectedFiles() { return rows.filter(function (r) { return selected.has(r.path); }).map(function (r) { return r.path; }); }

function render() {
  var tb = $("#tbody");
  tb.textContent = "";
  rows.forEach(function (r) {
    var tr = document.createElement("tr");
    if (selected.has(r.path)) tr.className = "sel";
    var td = document.createElement("td");
    td.className = "c";
    var cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = selected.has(r.path);
    cb.addEventListener("change", function () {
      if (cb.checked) selected.add(r.path); else selected.delete(r.path);
      tr.classList.toggle("sel", cb.checked);
      $("#all").checked = selected.size === rows.length;
    });
    td.appendChild(cb);
    tr.appendChild(td);
    [r.file, r.rangeKm].forEach(function (v, i) {
      var c = document.createElement("td");
      if (i === 1) c.className = "r";
      c.textContent = v;
      tr.appendChild(c);
    });
    var crc = document.createElement("td");
    crc.textContent = r.crc ? "OK" : "BAD";
    if (!r.crc) crc.className = "bad";
    tr.appendChild(crc);
    tr.title = r.file;
    tr.addEventListener("click", function (e) {
      if (e.target && e.target.tagName === "INPUT") return;
      openTrace(r.path);
    });
    tb.appendChild(tr);
  });
  $("#all").checked = rows.length > 0 && selected.size === rows.length;
  $("#statusInfo").textContent = "Файлов: " + rows.length + " · выбрано: " + selected.size;
}

// ---- просмотр рефлектограммы ----
var view = null;
var editMode = false;
var pendingEdits = [];
var CH = { w: 1000, h: 340, l: 62, r: 18, t: 18, b: 36 };

function fmtKm(m) { return (m / 1000).toFixed(3); }

function viewRange() {
  var maxM = view.data.rangeM || 1;
  var z0 = view.z0 == null ? 0 : view.z0;
  var z1 = view.z1 == null ? maxM : view.z1;
  if (z1 - z0 < 0.5) z1 = z0 + 0.5;
  return { x0: z0, x1: z1 };
}

function sampleAt(m) {
  var s = view.data.samples, xs = s.x, ys = s.y, hi = xs.length - 1;
  if (!xs.length) return null;
  if (m <= xs[0]) return ys[0];
  if (m >= xs[hi]) return ys[hi];
  var lo = 0;
  while (hi - lo > 1) {
    var mid = (lo + hi) >> 1;
    if (xs[mid] <= m) lo = mid; else hi = mid;
  }
  var t = (m - xs[lo]) / ((xs[hi] - xs[lo]) || 1);
  return ys[lo] + (ys[hi] - ys[lo]) * t;
}

function yBounds(rr) {
  var s = view.data.samples, xs = s.x, ys = s.y;
  var ymin = Infinity, ymax = -Infinity, i;
  for (i = 0; i < xs.length; i++) {
    if (xs[i] < rr.x0 - 1 || xs[i] > rr.x1 + 1) continue;
    if (ys[i] < ymin) ymin = ys[i];
    if (ys[i] > ymax) ymax = ys[i];
  }
  if (!isFinite(ymin)) { ymin = 0; ymax = 1; }
  if (ymax - ymin < 0.2) { var c0 = (ymin + ymax) / 2; ymin = c0 - 0.1; ymax = c0 + 0.1; }
  var pad = (ymax - ymin) * 0.08;
  return { ymin: ymin - pad, ymax: ymax + pad };
}

function chartSvg(rr) {
  var d = view.data, s = d.samples, xs = s.x, ys = s.y;
  var w = CH.w, h = CH.h, L = CH.l, R = CH.r, T = CH.t, B = CH.b;
  var bounds = yBounds(rr), ymin = bounds.ymin, ymax = bounds.ymax, i;
  function X(m) { return L + (m - rr.x0) / (rr.x1 - rr.x0) * (w - L - R); }
  // dB level: higher value = stronger signal = higher on the chart.
  function Y(v) { return T + (ymax - v) / (ymax - ymin) * (h - T - B); }
  var o = [];
  o.push('<rect x="0" y="0" width="' + w + '" height="' + h + '" fill="#ffffff"/>');

  // Plot frame and grid.
  o.push('<rect x="' + L + '" y="' + T + '" width="' + (w - L - R) + '" height="' + (h - T - B) + '" fill="none" stroke="#9a9a9a"/>');
  for (i = 0; i <= 5; i++) {
    var tx = rr.x0 + (rr.x1 - rr.x0) * i / 5, px = X(tx);
    o.push('<line x1="' + px.toFixed(1) + '" y1="' + T + '" x2="' + px.toFixed(1) + '" y2="' + (h - B) + '" stroke="#dfdfdf"/>');
    var label = rr.x1 >= 2000 ? Math.round(tx) + "" : tx.toFixed(0);
    o.push('<text x="' + px.toFixed(1) + '" y="' + (h - B + 14) + '" font-size="11" fill="#333" text-anchor="middle">' + label + '</text>');
  }
  for (i = 0; i <= 4; i++) {
    var vy = ymin + (ymax - ymin) * i / 4, py = Y(vy);
    o.push('<line x1="' + L + '" y1="' + py.toFixed(1) + '" x2="' + (w - R) + '" y2="' + py.toFixed(1) + '" stroke="#dfdfdf"/>');
    o.push('<text x="' + (L - 6) + '" y="' + (py + 4).toFixed(1) + '" font-size="11" fill="#333" text-anchor="end">' + vy.toFixed(2) + '</text>');
  }
  o.push('<text x="' + (w - R) + '" y="' + (h - 5) + '" font-size="10" fill="#555" text-anchor="end">м</text>');
  o.push('<text x="' + (L - 6) + '" y="' + (T - 4) + '" font-size="10" fill="#555" text-anchor="end">дБ</text>');

  // Full trace in black; the A..B span is drawn green on top.
  var parts = [], span = [];
  var aM = Math.min(view.A, view.B), bM = Math.max(view.A, view.B);
  for (i = 0; i < xs.length; i++) {
    if (xs[i] < rr.x0 || xs[i] > rr.x1) continue;
    var seg = (parts.length ? "L" : "M") + X(xs[i]).toFixed(1) + " " + Y(ys[i]).toFixed(1);
    parts.push(seg);
    if (xs[i] >= aM && xs[i] <= bM) span.push(seg);
  }
  if (parts.length) {
    o.push('<path d="' + parts.join("") + '" fill="none" stroke="#111" stroke-width="1" stroke-linejoin="round"/>');
  }
  if (span.length > 1) {
    o.push('<path d="' + span.join("") + '" fill="none" stroke="#00b050" stroke-width="2" stroke-linejoin="round"/>');
  }

  // Event marks: short red ticks and number.
  d.events.forEach(function (ev) {
    if (ev.distanceM < rr.x0 || ev.distanceM > rr.x1) return;
    var ex = X(ev.distanceM);
    o.push('<line x1="' + ex.toFixed(1) + '" y1="' + (T + 2) + '" x2="' + ex.toFixed(1) + '" y2="' + (T + 16) + '" stroke="#c00000" stroke-width="1.5"/>');
    o.push('<line x1="' + ex.toFixed(1) + '" y1="' + (h - B - 16) + '" x2="' + ex.toFixed(1) + '" y2="' + (h - B - 2) + '" stroke="#c00000" stroke-width="1.5"/>');
    o.push('<text x="' + (ex + 3).toFixed(1) + '" y="' + (T + 13) + '" font-size="10" fill="#c00000">' + ev.number + '</text>');
  });

  if (view.back) {
    var bs = view.back.samples, bparts = [];
    var backRange = view.back.rangeM || view.data.rangeM || 1;
    for (i = 0; i < bs.x.length; i++) {
      var bx = backRange - bs.x[i];
      if (bx < rr.x0 || bx > rr.x1) continue;
      bparts.push((bparts.length ? "L" : "M") + X(bx).toFixed(1) + " " + Y(bs.y[i]).toFixed(1));
    }
    if (bparts.length) {
      o.push('<path d="' + bparts.join("") + '" fill="none" stroke="#7030a0" stroke-width="1" stroke-linejoin="round" opacity="0.9"/>');
    }
  }

  if (!rr.hideCursors) {
    o.push(cursorMark("A", view.A, rr, X, T, h - B, "#d00000"));
    o.push(cursorMark("B", view.B, rr, X, T, h - B, "#0000d0"));
  }

  // Overview inset in the upper right corner (whole trace + visible window).
  if (!rr.hideCursors) {
  var ow = Math.min(152, Math.round(w * 0.28)), oh = Math.min(58, Math.round(h * 0.22));
  var ox = w - R - ow - 6, oy = T + 6;
  var oxs = [], oymin = Infinity, oymax = -Infinity;
  for (i = 0; i < xs.length; i++) {
    if (ys[i] < oymin) oymin = ys[i];
    if (ys[i] > oymax) oymax = ys[i];
  }
  if (xs.length && oymax > oymin) {
    var maxM = d.rangeM || xs[xs.length - 1] || 1;
    var step = Math.max(1, Math.floor(xs.length / 220));
    for (i = 0; i < xs.length; i += step) {
      oxs.push((ox + xs[i] / maxM * ow).toFixed(1) + "," + (oy + oh - (ys[i] - oymin) / (oymax - oymin) * oh).toFixed(1));
    }
    o.push('<rect x="' + ox + '" y="' + oy + '" width="' + ow + '" height="' + oh + '" fill="#ffffff" stroke="#808080"/>');
    o.push('<polyline points="' + oxs.join(" ") + '" fill="none" stroke="#111" stroke-width="0.8"/>');
    var vx0 = ox + rr.x0 / maxM * ow, vx1 = ox + rr.x1 / maxM * ow;
    o.push('<rect x="' + vx0.toFixed(1) + '" y="' + oy + '" width="' + Math.max(1, vx1 - vx0).toFixed(1) + '" height="' + oh + '" fill="none" stroke="#0078d7"/>');
  }
  }
  return o.join("");
}

function cursorMark(label, m, rr, X, T, B, color) {
  var x = X(Math.max(rr.x0, Math.min(rr.x1, m)));
  var o = [];
  o.push('<line x1="' + x.toFixed(1) + '" y1="' + T + '" x2="' + x.toFixed(1) + '" y2="' + B + '" stroke="' + color + '" stroke-width="1"/>');
  o.push('<path d="M' + (x - 4).toFixed(1) + ' ' + T + ' L' + (x + 4).toFixed(1) + ' ' + T + ' L' + x.toFixed(1) + ' ' + (T + 7) + ' Z" fill="' + color + '"/>');
  return o.join("");
}

function lsaSlope() {
  var s = view.data.samples, xs = s.x, ys = s.y;
  var a = Math.min(view.A, view.B), b = Math.max(view.A, view.B);
  var n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (var i = 0; i < xs.length; i++) {
    if (xs[i] < a || xs[i] > b) continue;
    n++; sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i];
  }
  if (n < 3) return null;
  var den = n * sxx - sx * sx;
  if (!den) return null;
  var k = (n * sxy - sx * sy) / den; // dB per metre, negative because level falls
  return -k * 1000; // dB per km, positive loss
}

function updateReadout() {
  var a = sampleAt(view.A), b = sampleAt(view.B);
  if (a == null || b == null) { $("#vReadout").textContent = ""; return; }
  var dist = Math.abs(view.B - view.A);
  var text =
    "Курсоры: A: " + view.A.toFixed(2) + " м " + a.toFixed(3) + " дБ | " +
    "B: " + view.B.toFixed(2) + " м " + b.toFixed(3) + " дБ | " +
    "B-A: " + (view.B - view.A).toFixed(2) + " м " + (b - a).toFixed(3) + " дБ";
  if ($("#lsa").checked) {
    var slope = lsaSlope();
    text += " | LSA: " + (slope == null ? "—" : slope.toFixed(3) + " дБ/км");
  }
  $("#vReadout").textContent = text;
  if ($("#vToolsHint")) $("#vToolsHint").textContent = "операции применяются к участку A…B (" + fmtKm(dist) + " км)";
}

function renderChart() {
  var area = $("#chart").parentNode;
  var w = Math.max(320, (area.clientWidth || 900) - 4);
  var h = Math.max(160, (area.clientHeight || 320) - 4);
  CH.w = w;
  CH.h = h;
  var svg = $("#chart");
  svg.setAttribute("viewBox", "0 0 " + w + " " + h);
  svg.innerHTML = chartSvg(viewRange());
  updateReadout();
}

window.addEventListener("resize", function () { if (view) renderChart(); });

function renderParams(d) {
  var p = d.params;
  var items = [
    ["Файл", d.name],
    ["Дата измерения", fmtDate(p.date)],
    ["Длина волны", p.wavelengthNm + " нм"],
    ["Импульс", p.pulseNs.join(" / ") + " нс"],
    ["Диапазон", fmtKm(d.rangeM) + " км"],
    ["Число точек", d.points],
    ["Разрешение", (d.resolutionM * 1000).toFixed(0) + " мм"],
    ["Показатель преломления", p.ior.toFixed(4)],
    ["Накоплений", p.numAverages],
    ["Время накопления", p.averagingTimeS ? p.averagingTimeS.toFixed(1) + " с" : "—"],
    ["Полные потери", d.summary && d.summary.totalLossDb > 0 ? d.summary.totalLossDb.toFixed(3) + " дБ" : "—"],
    ["Прибор", [p.supplier, p.otdr].filter(function (v) { return v && v.trim(); }).join(" ") || "—"],
    ["Серийный номер", p.otdrSerial || "—"],
    ["ПО", p.software || "—"],
    ["Формат", "Bellcore v" + d.format],
    ["CRC", p.checksumOk === null ? "—" : (p.checksumOk ? "OK" : "BAD")],
    ["Кабель", p.cable || "—"],
    ["Волокно", p.fiber || "—"],
    ["Оператор", p.operator || "—"],
    ["Начало (A)", p.locationA || "—"],
    ["Конец (B)", p.locationB || "—"],
    ["Комментарий", p.comment || "—"]
  ];
  var box = $("#vParams");
  box.textContent = "";
  var table = document.createElement("table");
  var body = document.createElement("tbody");
  items.forEach(function (kv) {
    var tr = document.createElement("tr");
    var k = document.createElement("td");
    k.className = "k";
    k.textContent = kv[0];
    var v = document.createElement("td");
    v.className = "v";
    v.textContent = String(kv[1]);
    v.title = String(kv[1]);
    tr.appendChild(k);
    tr.appendChild(v);
    body.appendChild(tr);
  });
  table.appendChild(body);
  box.appendChild(table);
}

var selEvent = null;

function fillEventForm(ev) {
  selEvent = ev ? ev.number : null;
  if (ev) {
    $("#evDist").value = fmtKm(ev.distanceM);
    $("#evLoss").value = ev.spliceLossDb.toFixed(3);
    $("#evRefl").value = ev.reflectionLossDb.toFixed(1);
    $("#evSlope").value = ev.slopeDbPerKm.toFixed(3);
    $("#evType").value = ev.reflectionLossDb < 0 ? "reflection" : "loss";
    $("#evComment").value = ev.comment || "";
    $("#evSel").textContent = "выбрано событие №" + ev.number;
    if ($("#evSelDlg")) $("#evSelDlg").textContent = "выбрано событие №" + ev.number;
  } else {
    $("#evSel").textContent = "новое событие";
    if ($("#evSelDlg")) $("#evSelDlg").textContent = "новое событие";
  }
}

function eventPayload() {
  return {
    distanceM: parseFloat(String($("#evDist").value).replace(",", ".")) * 1000,
    spliceLossDb: parseFloat(String($("#evLoss").value).replace(",", ".")) || 0,
    reflectionLossDb: parseFloat(String($("#evRefl").value).replace(",", ".")) || 0,
    slopeDbPerKm: parseFloat(String($("#evSlope").value).replace(",", ".")) || 0,
    type: $("#evType").value,
    comment: $("#evComment").value.trim()
  };
}

async function applyEvent(action) {
  if (!view) return;
  if ((action === "update" || action === "delete") && selEvent == null) {
    log("Сначала выберите событие в таблице", "err");
    return;
  }
  if (action === "delete" && !confirm("Удалить событие №" + selEvent + "?")) return;
  busy(true);
  try {
    var j = await api("/api/event", {
      file: view.path,
      action: action,
      index: selEvent,
      event: eventPayload(),
      outDir: $("#tOutDir").value.trim()
    });
    log("События сохранены: " + j.out + " · всего " + j.events, "ok");
    var keep = selEvent;
    await openTrace(j.out);
    selEvent = keep;
  } catch (e) {
    log(e.message, "err");
  } finally {
    busy(false);
  }
}

function eventIcon(ev) {
  if (ev.reflectionLossDb < -30) return "↯";
  if (ev.spliceLossDb >= 1) return "⌐";
  return "↳";
}

function renderEvents(d) {
  var tb = $("#vEvents");
  tb.textContent = "";
  d.events.forEach(function (ev) {
    var tr = document.createElement("tr");
    var cells = [
      eventIcon(ev) + " " + ev.type,
      ev.number,
      (ev.distanceM).toFixed(2),
      ev.spliceLossDb.toFixed(3),
      ev.reflectionLossDb.toFixed(3),
      ev.slopeDbPerKm.toFixed(3),
      ev.comment || ""
    ];
    cells.forEach(function (v, i) {
      var td = document.createElement("td");
      if (i >= 1 && i <= 5) td.className = "r";
      td.textContent = v;
      tr.appendChild(td);
    });
    tr.title = "щелчок — выбрать событие и поставить курсор A, Shift+щелчок — курсор B";
    tr.addEventListener("click", function (e) {
      if (e.shiftKey) view.B = ev.distanceM; else view.A = ev.distanceM;
      if (view.B <= view.A) view.B = d.rangeM;
      renderChart();
      fillEventForm(ev);
    });
    tb.appendChild(tr);
  });
}

function fillEdit(d) {
  var p = d.params;
  $("#eDate").value = fmtDate(p.date);
  $("#eCable").value = p.cable || "";
  $("#eFiber").value = p.fiber || "";
  $("#eOperator").value = p.operator || "";
  $("#eLocA").value = p.locationA || "";
  $("#eLocB").value = p.locationB || "";
  $("#eIor").value = p.ior.toFixed(4);
  $("#eComment").value = p.comment || "";
  $("#eOutDir").value = d.dir || "";
  $("#tOutDir").value = d.dir || "";
}

async function openTrace(path) {
  busy(true);
  try {
    var d = await api("/api/trace", { file: path });
    view = { path: path, data: d, A: 0, B: d.rangeM, drag: null, z0: null, z1: null };
    $("#viewerCard").hidden = false;
    $("#vName").textContent = d.name;
    $("#vMeta").textContent = "v" + d.format + " · " + fmtKm(d.rangeM) + " км · точек " + d.points +
      " · событий " + d.events.length +
      (d.params.checksumOk === null ? "" : (d.params.checksumOk ? " · CRC OK" : " · CRC BAD"));
    renderParams(d);
    renderEvents(d);
    fillEdit(d);
    $("#evDist").value = fmtKm(0);
    $("#evLoss").value = "0";
    $("#evRefl").value = "0";
    $("#evSlope").value = "0";
    $("#evComment").value = "";
    $("#biDirBox").hidden = true;
    $("#lgBack").hidden = true;
    editMode = false;
    pendingEdits = [];
    $("#vVisual").textContent = "Правка графика";
    $("#vApplyVisual").disabled = true;
    $("#vEditHint").textContent = "";
    $("#chart").style.cursor = "crosshair";
    fillEventForm(null);
    renderChart();
    $("#viewerCard").scrollIntoView({ block: "start" });
  } catch (e) {
    log(e.message, "err");
  } finally {
    busy(false);
  }
}

function svgDist(evt) {
  var svg = $("#chart"), r = svg.getBoundingClientRect(), rr = viewRange();
  var vx = (evt.clientX - r.left) / r.width * CH.w;
  var m = rr.x0 + (vx - CH.l) / (CH.w - CH.l - CH.r) * (rr.x1 - rr.x0);
  return Math.max(rr.x0, Math.min(rr.x1, m));
}

function svgLevel(evt) {
  var svg = $("#chart"), r = svg.getBoundingClientRect(), rr = viewRange(), b = yBounds(rr);
  var vy = (evt.clientY - r.top) / r.height * CH.h;
  var level = b.ymax - (vy - CH.t) / (CH.h - CH.t - CH.b) * (b.ymax - b.ymin);
  return Math.max(0, Math.min(65, level));
}

$("#chart").addEventListener("mousedown", function (e) {
  if (!view) return;
  if (editMode) {
    var em = svgDist(e), el = svgLevel(e);
    pendingEdits.push({ distanceM: Number(em.toFixed(2)), levelDb: Number(el.toFixed(3)) });
    var sm = view.data.samples, best = 0, bd = Infinity;
    for (var i = 0; i < sm.x.length; i++) {
      var dd = Math.abs(sm.x[i] - em);
      if (dd < bd) { bd = dd; best = i; }
    }
    sm.y[best] = el;
    renderChart();
    $("#vEditHint").textContent = "изменено точек: " + pendingEdits.length;
    $("#vApplyVisual").disabled = false;
    e.preventDefault();
    return;
  }
  var m = svgDist(e), rr = viewRange();
  var tol = (rr.x1 - rr.x0) * 12 / (CH.w - CH.l - CH.r);
  if (Math.abs(m - view.A) <= tol) view.drag = "A";
  else if (Math.abs(m - view.B) <= tol) view.drag = "B";
  else {
    view.drag = Math.abs(m - view.A) <= Math.abs(m - view.B) ? "A" : "B";
    view[view.drag] = m;
    renderChart();
  }
  e.preventDefault();
});
window.addEventListener("mousemove", function (e) {
  if (!view || !view.drag) return;
  view[view.drag] = svgDist(e);
  renderChart();
});
window.addEventListener("mouseup", function () { if (view) view.drag = null; });
$("#chart").addEventListener("wheel", function (e) {
  if (!view) return;
  e.preventDefault();
  var rr = viewRange();
  var maxM = view.data.rangeM || rr.x1;
  var span = rr.x1 - rr.x0;
  if (e.shiftKey) {
    var shift = span * (e.deltaY > 0 ? 0.12 : -0.12);
    var a0 = Math.max(0, rr.x0 + shift), b0 = Math.min(maxM, rr.x1 + shift);
    if (b0 - a0 >= span - 1e-6) { view.z0 = a0; view.z1 = b0; }
  } else {
    var factor = e.deltaY > 0 ? 1.25 : 0.8;
    var c = svgDist(e);
    var n0 = Math.max(0, c - (c - rr.x0) * factor);
    var n1 = Math.min(maxM, c + (rr.x1 - c) * factor);
    if (n1 - n0 >= 0.5) { view.z0 = n0; view.z1 = n1; }
  }
  renderChart();
}, { passive: false });
$("#chart").addEventListener("dblclick", function () {
  if (!view) return;
  view.z0 = null; view.z1 = null; renderChart();
});

$("#vClose").addEventListener("click", function () {
  $("#viewerCard").hidden = true;
  view = null;
});
$("#vReveal").addEventListener("click", async function () {
  if (!view) return;
  try { await api("/api/reveal", { file: view.path }); } catch (e) { log(e.message, "err"); }
});
$("#vPrint").addEventListener("click", function () { printReport(); });
$("#vSave").addEventListener("click", async function () {
  if (!view) return;
  var body = {
    file: view.path,
    outDir: $("#eOutDir").value.trim(),
    fields: {
      date: $("#eDate").value.trim(),
      cable: $("#eCable").value.trim(),
      fiber: $("#eFiber").value.trim(),
      operator: $("#eOperator").value.trim(),
      locationA: $("#eLocA").value.trim(),
      locationB: $("#eLocB").value.trim(),
      comment: $("#eComment").value.trim(),
      ior: $("#eIor").value.trim()
    }
  };
  busy(true);
  try {
    var j = await api("/api/edit", body);
    log("Сохранена копия: " + j.out, "ok");
  } catch (e) {
    log(e.message, "err");
  } finally {
    busy(false);
  }
});

$("#vCrop").addEventListener("click", async function () {
  if (!view) return;
  if (view.B - view.A < 1) {
    log("Разнесите курсоры A и B: обрезка идёт по их положению", "err");
    return;
  }
  busy(true);
  try {
    var j = await api("/api/crop", { file: view.path, aM: view.A, bM: view.B, outDir: $("#tOutDir").value.trim() });
    log("Обрезано: " + j.out + " · " + fmtKm(j.rangeM) + " км · событий " + j.events, "ok");
    await openTrace(j.out);
  } catch (e) {
    log(e.message, "err");
  } finally {
    busy(false);
  }
});

$("#vSmooth").addEventListener("click", async function () {
  if (!view) return;
  if (view.B - view.A < view.data.resolutionM * 10) {
    log("Для шумоподавления нужен участок между A и B не короче 10 точек", "err");
    return;
  }
  busy(true);
  try {
    var j = await api("/api/denoise", {
      file: view.path, aM: view.A, bM: view.B,
      width: $("#dWidth").value.trim() || 9,
      outDir: $("#tOutDir").value.trim()
    });
    log("Шумоподавление: " + j.out + " · окно " + j.width + " точек", "ok");
    await openTrace(j.out);
  } catch (e) {
    log(e.message, "err");
  } finally {
    busy(false);
  }
});

$("#evAdd").addEventListener("click", function () { applyEvent("add"); });
$("#evUpdate").addEventListener("click", function () { applyEvent("update"); });
$("#evDelete").addEventListener("click", function () { applyEvent("delete"); });

function renderBiDir(j) {
  var tb = $("#biRows");
  tb.textContent = "";
  var matched = 0;
  j.pairs.forEach(function (p) {
    var tr = document.createElement("tr");
    if (p.backwardLossDb != null) matched++;
    var refl = p.forwardReflectionDb.toFixed(1) + " / " +
      (p.backwardReflectionDb == null ? "—" : p.backwardReflectionDb.toFixed(1));
    [p.number, fmtKm(p.distanceM), p.forwardLossDb.toFixed(3),
      p.backwardLossDb == null ? "—" : p.backwardLossDb.toFixed(3),
      p.averageLossDb == null ? "—" : p.averageLossDb.toFixed(3),
      refl, p.comment || ""].forEach(function (v, i) {
      var td = document.createElement("td");
      if (i >= 2 && i <= 5) td.className = "r";
      td.textContent = v;
      tr.appendChild(td);
    });
    tb.appendChild(tr);
  });
  $("#biDirMeta").textContent = " · прямая " + j.front.name + " ↔ " + j.back.name +
    " · сопоставлено " + matched + " из " + j.pairs.length +
    " (допуск " + j.toleranceM.toFixed(0) + " м)";
  $("#biDirBox").hidden = false;
  $("#lgBack").hidden = false;
}

$("#vBiDir").addEventListener("click", async function () {
  if (!view) return;
  try {
    var picked = await api("/api/browse", { kind: "open", title: "Выберите обратную трассу", default: view.path });
    if (!picked.path) return;
    busy(true);
    var j = await api("/api/bidir", { file: view.path, backFile: picked.path });
    view.back = j.back;
    renderChart();
    renderBiDir(j);
    log("Двунаправленный режим: " + j.front.name + " ↔ " + j.back.name, "ok");
  } catch (e) {
    log(e.message, "err");
  } finally {
    busy(false);
  }
});

$("#vVisual").addEventListener("click", function () {
  if (!view) return;
  editMode = !editMode;
  $("#vVisual").textContent = editMode ? "Правка графика: включена" : "Правка графика";
  $("#chart").style.cursor = editMode ? "cell" : "crosshair";
  $("#vEditHint").textContent = editMode
    ? "щелчок по графику задаёт уровень в этой точке"
    : (pendingEdits.length ? "изменено точек: " + pendingEdits.length : "");
});

$("#vApplyVisual").addEventListener("click", async function () {
  if (!view || !pendingEdits.length) return;
  busy(true);
  try {
    var j = await api("/api/setpoint", { file: view.path, points: pendingEdits, outDir: $("#tOutDir").value.trim() });
    log("Правка графика сохранена: " + j.out + " · точек " + j.changed, "ok");
    pendingEdits = [];
    await openTrace(j.out);
  } catch (e) {
    log(e.message, "err");
  } finally {
    busy(false);
  }
});

function buildPrintSection(d, withCursors) {
  var p = d.params;
  var saveView = view;
  view = { path: d.path, data: d, A: 0, B: d.rangeM, drag: null, z0: null, z1: null };
  var wrap = document.createElement("div");
  wrap.style.pageBreakAfter = "always";

  var h1 = document.createElement("h1");
  h1.textContent = "Протокол рефлектограммы: " + d.name;
  wrap.appendChild(h1);
  var note = document.createElement("div");
  note.className = "note";
  note.textContent = "OpenSTV __VERSION__ · сформировано " + new Date().toLocaleString("ru-RU");
  wrap.appendChild(note);

  var params = [
    ["Файл", d.path],
    ["Дата измерения (UTC)", fmtDate(p.date)],
    ["Длина волны", p.wavelengthNm + " нм"],
    ["Импульс", p.pulseNs.join(" / ") + " нс"],
    ["Диапазон", fmtKm(d.rangeM) + " км"],
    ["Точек", String(d.points)],
    ["Разрешение", (d.resolutionM * 1000).toFixed(0) + " мм"],
    ["Показатель преломления", p.ior.toFixed(4)],
    ["Кабель", p.cable || "—"],
    ["Волокно", p.fiber || "—"],
    ["Оператор", p.operator || "—"],
    ["Начало (A)", p.locationA || "—"],
    ["Конец (B)", p.locationB || "—"],
    ["Прибор", [p.supplier, p.otdr].filter(Boolean).join(" ") || "—"],
    ["Серийный номер", p.otdrSerial || "—"],
    ["ПО", p.software || "—"]
  ];
  var t = document.createElement("table");
  for (var i = 0; i < params.length; i += 2) {
    var tr = document.createElement("tr");
    [params[i], params[i + 1] || ["", ""]].forEach(function (kv) {
      var th = document.createElement("th");
      th.textContent = kv[0];
      var td = document.createElement("td");
      td.textContent = kv[1];
      tr.appendChild(th);
      tr.appendChild(td);
    });
    t.appendChild(tr);
  }
  wrap.appendChild(t);

  var h2c = document.createElement("h2");
  h2c.textContent = "Рефлектограмма";
  wrap.appendChild(h2c);
  var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  var savedW = CH.w, savedH = CH.h;
  CH.w = 1000;
  CH.h = 300;
  svg.setAttribute("viewBox", "0 0 1000 300");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.innerHTML = chartSvg({ x0: 0, x1: d.rangeM || 1, hideCursors: !withCursors });
  CH.w = savedW;
  CH.h = savedH;
  wrap.appendChild(svg);

  var h2e = document.createElement("h2");
  h2e.textContent = "События";
  wrap.appendChild(h2e);
  var et = document.createElement("table");
  var head = document.createElement("tr");
  ["№", "Расстояние, км", "Тип", "Потери, дБ", "Отражение, дБ", "Затухание, дБ/км", "Комментарий"].forEach(function (label) {
    var th = document.createElement("th");
    th.textContent = label;
    head.appendChild(th);
  });
  et.appendChild(head);
  d.events.forEach(function (ev) {
    var tr = document.createElement("tr");
    [ev.number, fmtKm(ev.distanceM), ev.type, ev.spliceLossDb.toFixed(3), ev.reflectionLossDb.toFixed(1), ev.slopeDbPerKm.toFixed(3), ev.comment || ""].forEach(function (v) {
      var td = document.createElement("td");
      td.textContent = v;
      tr.appendChild(td);
    });
    et.appendChild(tr);
  });
  wrap.appendChild(et);
  view = saveView;
  return wrap;
}

function printReport() {
  if (!view) return;
  var area = $("#printArea");
  area.textContent = "";
  area.appendChild(buildPrintSection(view.data, true));
  window.print();
}

async function printAll() {
  var files = selectedFiles();
  if (!files.length) { log("Ничего не выбрано", "err"); return; }
  busy(true);
  try {
    var area = $("#printArea");
    area.textContent = "";
    for (var i = 0; i < files.length; i++) {
      var d = await api("/api/trace", { file: files[i] });
      area.appendChild(buildPrintSection(d, false));
    }
    log("Печать: " + files.length + " трасс", "ok");
    window.print();
  } catch (e) {
    log(e.message, "err");
  } finally {
    busy(false);
  }
}

var pickedFiles = null;

function applyScan(j) {
  rows = j.rows;
  selected = new Set(rows.map(function (r) { return r.path; }));
  render();
  $("#resultCard").hidden = rows.length === 0;
  var label = j.source === "files" ? "Файлов" : "Трасс";
  $("#stats").innerHTML = label + ": <b>" + j.total + "</b> · событий: <b>" + j.events + "</b>" +
    (j.errors.length ? " · пропущено: <b>" + j.errors.length + "</b>" : "");
  if (j.suggest) {
    $("#xlsxOut").value = j.suggest.xlsx;
    $("#csvOut").value = j.suggest.csv;
    $("#outDir").value = j.suggest.outDir;
    $("#spanOut").value = j.suggest.xlsx.replace(/\.xlsx$/i, "_span.xlsx");
    $("#protoOut").value = j.suggest.xlsx.replace(/report\.xlsx$/i, "protocol.html");
    $("#gOutDir").value = j.suggest.outDir.replace(/_испр$/, "");
  }
  j.errors.slice(0, 10).forEach(function (e) { log("пропуск: " + e.file + " — " + e.error, "warn"); });
  log("Найдено: " + j.total, "ok");
}

async function scan() {
  var dir = $("#dir").value.trim();
  var useFiles = pickedFiles && pickedFiles.length;
  if (!useFiles && !dir) { log("Выберите папку или файлы", "err"); return; }
  busy(true);
  log(useFiles ? "Читаю выбранные файлы: " + pickedFiles.length + " …" : "Сканирую " + dir + " …");
  try {
    var j = await api("/api/scan", useFiles
      ? { files: pickedFiles }
      : { dir: dir, recursive: $("#rec").checked });
    applyScan(j);
  } catch (e) {
    log(e.message, "err");
  } finally {
    busy(false);
  }
}

async function scanFiles(paths) {
  pickedFiles = paths.slice();
  if (paths.length === 1) $("#dir").value = paths[0];
  await scan();
}

async function doExport(type) {
  var files = selectedFiles();
  if (!files.length) { log("Ничего не выбрано", "err"); return; }
  var out = type === "xlsx" ? $("#xlsxOut").value.trim() : $("#csvOut").value.trim();
  var folder = files[0].replace(/[\\/][^\\/]+$/, "");
  var suggested = out || folder + (type === "xlsx" ? "\\report.xlsx" : "\\events.csv");
  try {
    var picked = await api("/api/browse", { kind: "save", title: "Куда сохранить отчёт", default: suggested });
    if (!picked.path) { log("Экспорт отменён", "warn"); return; }
    out = picked.path;
    if (type === "xlsx") $("#xlsxOut").value = out; else $("#csvOut").value = out;
  } catch (e) {
    log(e.message, "err");
    return;
  }
  busy(true);
  log("Экспорт: " + files.length + " трасс …");
  try {
    var j = await api("/api/export", { type: type, files: files, out: out });
    log("Готово: " + j.out + " · трасс " + j.traces + " · событий " + j.events, "ok");
    if (j.skipped && j.skipped.length) log("пропущено файлов: " + j.skipped.length, "warn");
  } catch (e) {
    log(e.message, "err");
  } finally {
    busy(false);
  }
}

async function doTransform() {
  var files = selectedFiles();
  if (!files.length) { log("Ничего не выбрано", "err"); return; }
  var outDir = $("#outDir").value.trim();
  if (!outDir) { log("Укажите папку результата", "err"); return; }
  function v(id) { return $("#" + id).value.trim(); }
  var body = {
    files: files, outDir: outDir, dryRun: $("#dry").checked,
    date: v("date"), shiftDays: v("shiftDays"), fiberStart: v("fiberStart"),
    cable: v("cable"), operator: v("operator"), locationA: v("locationA"),
    locationB: v("locationB"), comment: v("comment"), ior: v("ior"), template: v("template")
  };
  busy(true);
  log((body.dryRun ? "Планирую" : "Обрабатываю") + ": " + files.length + " трасс …");
  try {
    var j = await api("/api/transform", body);
    log((j.dryRun ? "План" : "Записано") + ": " + j.written + " из " + files.length + " → " + j.target, "ok");
    j.errors.slice(0, 20).forEach(function (e) { log("пропуск: " + e.file + " — " + e.error, "warn"); });
    if (j.errors.length > 20) log("…ещё " + (j.errors.length - 20) + " ошибок", "warn");
  } catch (e) {
    log(e.message, "err");
  } finally {
    busy(false);
  }
}

async function doSpan() {
  var files = selectedFiles();
  if (!files.length) { log("Ничего не выбрано", "err"); return; }
  busy(true);
  try {
    var j = await api("/api/span", {
      files: files,
      out: $("#spanOut").value.trim(),
      eventA: Number($("#spanA").value) || 1,
      eventB: Number($("#spanB").value) || 2
    });
    log("Отчёт по участку: " + j.out + " · трасс " + j.traces + " · события " + j.eventA + "→" + j.eventB, "ok");
  } catch (e) {
    log(e.message, "err");
  } finally {
    busy(false);
  }
}

async function doProtocol() {
  var files = selectedFiles();
  if (!files.length) { log("Ничего не выбрано", "err"); return; }
  busy(true);
  try {
    var j = await api("/api/protocol", {
      files: files,
      kind: $("#protoKind").value,
      org: $("#protoOrg").value.trim(),
      object: $("#protoObject").value.trim(),
      cable: $("#protoCable").value.trim(),
      normPerKm: $("#protoNorm").value.trim(),
      out: $("#protoOut").value.trim()
    });
    log("Протокол: " + j.out + " · трасс " + j.traces + ". Откройте его в Word или распечатайте.", "ok");
  } catch (e) {
    log(e.message, "err");
  } finally {
    busy(false);
  }
}

async function doCreate() {
  var outDir = $("#gOutDir").value.trim() || $("#outDir").value.trim();
  if (!outDir) { log("Укажите папку результата", "err"); return; }
  var events = [];
  $("#gEvents").value.split(/\\r?\\n/).forEach(function (line, i) {
    if (!line.trim()) return;
    var p = line.split(";").map(function (s) { return s.trim(); });
    var km = parseFloat((p[0] || "0").replace(",", "."));
    if (!isFinite(km)) { log("Строка событий " + (i + 1) + ": не понимаю расстояние", "err"); return; }
    events.push({
      distanceM: km * 1000,
      spliceLossDb: parseFloat((p[1] || "0").replace(",", ".")) || 0,
      reflectionLossDb: parseFloat((p[2] || "0").replace(",", ".")) || 0,
      comment: p[3] || ""
    });
  });
  busy(true);
  try {
    var j = await api("/api/create", {
      outDir: outDir,
      name: $("#gName").value.trim(),
      rangeM: (parseFloat(String($("#gRange").value).replace(",", ".")) || 0) * 1000,
      points: parseInt($("#gPoints").value, 10) || 4000,
      wavelengthNm: parseInt($("#gWave").value, 10) || 1310,
      pulseNs: parseInt($("#gPulse").value, 10) || 10,
      ior: parseFloat(String($("#gIor").value).replace(",", ".")) || 1.468,
      slopeDbPerKm: parseFloat(String($("#gSlope").value).replace(",", ".")) || 0.35,
      cableId: $("#gCable").value.trim(),
      fiberId: $("#gFiber").value.trim(),
      operator: $("#gOperator").value.trim(),
      comment: $("#gComment").value.trim(),
      events: events
    });
    log("Создана трасса: " + j.out + " · точек " + j.points + " · событий " + j.events, "ok");
    await openTrace(j.out);
  } catch (e) {
    log(e.message, "err");
  } finally {
    busy(false);
  }
}

async function doMeasure() {
  var files = selectedFiles();
  if (!files.length) { log("Ничего не выбрано", "err"); return; }
  var outDir = $("#outDir").value.trim();
  if (!outDir) { log("Укажите папку результата", "err"); return; }
  busy(true);
  try {
    var j = await api("/api/measure", {
      files: files,
      outDir: outDir,
      ior: $("#ior").value.trim(),
      pulseNs: $("#mPulse").value.trim(),
      averagingTimeS: $("#mAveraging").value.trim()
    });
    log("Параметры измерения записаны: " + j.written + " из " + files.length + " → " + j.target, "ok");
    j.errors.slice(0, 20).forEach(function (e) { log("пропуск: " + e.file + " — " + e.error, "warn"); });
  } catch (e) {
    log(e.message, "err");
  } finally {
    busy(false);
  }
}

async function pick(kind, targetId, title, def) {
  try {
    var j = await api("/api/browse", { kind: kind, title: title, default: def || "" });
    if (j.path) $("#" + targetId).value = j.path;
  } catch (e) {
    log(e.message, "err");
  }
}

$("#browseDir").addEventListener("click", async function () {
  pickedFiles = null;
  await pick("dir", "dir", "Папка с трассами", $("#dir").value);
});
$("#browseFiles").addEventListener("click", async function () {
  try {
    var j = await api("/api/browse", { kind: "files", title: "Выберите файлы трасс", default: $("#dir").value });
    if (j.paths && j.paths.length) await scanFiles(j.paths);
  } catch (e) {
    log(e.message, "err");
  }
});
$("#dir").addEventListener("input", function () { pickedFiles = null; });

async function quitApp() {
  try { await fetch("/api/quit", { method: "POST" }); } catch (e) {}
  document.body.innerHTML = '<div style="padding:48px;font:16px system-ui,sans-serif;color:#1b2430">OpenSTV остановлен. Это окно можно закрыть.</div>';
}

// ---- menus and dialogs ----
function closeMenus() {
  document.querySelectorAll(".menu.open").forEach(function (m) { m.classList.remove("open"); });
}
document.querySelectorAll(".menu > button").forEach(function (b) {
  b.addEventListener("click", function (e) {
    var menu = b.parentNode;
    var was = menu.classList.contains("open");
    closeMenus();
    if (!was) menu.classList.add("open");
    e.stopPropagation();
  });
});
document.addEventListener("click", function (e) {
  if (!e.target.closest(".menu")) closeMenus();
});

function openDlg(id) {
  var d = $("#" + id);
  if (!d) return;
  d.hidden = false;
}
function closeDlg(id) {
  var d = $("#" + id);
  if (d) d.hidden = true;
}
document.querySelectorAll("[data-close]").forEach(function (b) {
  b.addEventListener("click", function () { closeDlg(b.getAttribute("data-close")); });
});
document.querySelectorAll(".overlay").forEach(function (o) {
  o.addEventListener("click", function (e) { if (e.target === o) o.hidden = true; });
});
document.addEventListener("keydown", function (e) {
  if (e.key === "Escape") {
    closeMenus();
    document.querySelectorAll(".overlay:not([hidden])").forEach(function (o) { o.hidden = true; });
  }
});

function toggleFiles() {
  var work = $("#work");
  work.classList.toggle("nofiles");
  $("#setFiles").checked = !work.classList.contains("nofiles");
  saveSettings();
}

function zoomBy(factor) {
  if (!view) return;
  var rr = viewRange(), maxM = view.data.rangeM || rr.x1;
  var c = (rr.x0 + rr.x1) / 2;
  var n0 = Math.max(0, c - (c - rr.x0) * factor);
  var n1 = Math.min(maxM, c + (rr.x1 - c) * factor);
  if (n1 - n0 >= 0.5) { view.z0 = n0; view.z1 = n1; renderChart(); }
}
function zoomReset() {
  if (!view) return;
  view.z0 = null; view.z1 = null; renderChart();
}

// Toolbar and menu commands.
var COMMANDS = {
  browse: function () { $("#browseDir").click(); },
  browseFiles: function () { $("#browseFiles").click(); },
  scan: function () { scan(); },
  create: function () { openDlg("dlgCreate"); },
  save: function () { if (view) openDlg("dlgProps"); },
  closeTrace: function () { if (view) $("#vClose").click(); },
  quit: quitApp,
  files: toggleFiles,
  log: function () { openDlg("dlgLog"); },
  settings: function () { openDlg("dlgSettings"); },
  zoom1: zoomReset,
  ratio: function () { $("#setRatio").checked = !$("#setRatio").checked; applyRatio(); },
  addEvent: function () { if (view) { openDlg("dlgProps"); $("#evAdd").click(); } },
  saveEvent: function () { if (view) { openDlg("dlgProps"); $("#evUpdate").click(); } },
  delEvent: function () { if (view) { openDlg("dlgProps"); $("#evDelete").click(); } },
  props: function () { if (view) openDlg("dlgProps"); },
  xlsx: function () { doExport("xlsx"); },
  csv: function () { doExport("csv"); },
  print: function () { if (view) printReport(); },
  printAll: printAll,
  span: function () { openDlg("dlgReports"); },
  protocol: function () { openDlg("dlgReports"); },
  batch: function () { openDlg("dlgBatch"); },
  measure: function () { openDlg("dlgBatch"); },
  bidir: function () { if (view) $("#vBiDir").click(); },
  crop: function () { if (view) $("#vCrop").click(); },
  smooth: function () { if (view) $("#vSmooth").click(); },
  visual: function () { if (view) $("#vVisual").click(); },
  about: function () {
    alert("OpenSTV __VERSION__\\nПросмотр, редактирование и пакетная обработка OTDR-трасс (SOR/Bellcore).\\n\\nФайлы SOR читаются напрямую.");
  },
  gaps: function () {
    alert("Просмотр рефлектограмм, курсоры A/B, зум, события.\\nПравка паспорта и событий, обрезка, шумоподавление, правка графика.\\nExcel/CSV, печать и PDF, протоколы ВОЛС, отчёт по участку A→B.\\nСоздание новых трасс, двунаправленный режим, пакетные преобразования.");
  }
};
document.querySelectorAll("[data-cmd]").forEach(function (b) {
  b.addEventListener("click", function () {
    closeMenus();
    var fn = COMMANDS[b.getAttribute("data-cmd")];
    if (fn) fn();
  });
});

$("#tbOpen").addEventListener("click", function () { $("#browseFiles").click(); });
$("#tbSave").addEventListener("click", function () { if (view) { openDlg("dlgProps"); } });
$("#tbPrint").addEventListener("click", function () { if (view) printReport(); });
$("#tbTable").addEventListener("click", toggleFiles);
$("#tbZoomIn").addEventListener("click", function () { zoomBy(0.7); });
$("#tbZoomOut").addEventListener("click", function () { zoomBy(1.4); });
$("#tbZoom1").addEventListener("click", zoomReset);
$("#tbSettings").addEventListener("click", function () { openDlg("dlgSettings"); });
$("#tbProps").addEventListener("click", function () { if (view) openDlg("dlgProps"); });
$("#tbReports").addEventListener("click", function () { openDlg("dlgReports"); });

function applyRatio() {
  var wide = $("#setRatio").checked;
  var ev = document.querySelector(".eventarea");
  if (ev) ev.style.height = wide ? "120px" : "184px";
  if (view) renderChart();
}
$("#setRatio").addEventListener("change", applyRatio);
$("#setFiles").addEventListener("change", function () {
  $("#work").classList.toggle("nofiles", !$("#setFiles").checked);
  saveSettings();
});
$("#setLsa").addEventListener("change", function () {
  $("#lsa").checked = $("#setLsa").checked;
  if (view) updateReadout();
  saveSettings();
});
$("#lsa").addEventListener("change", function () {
  $("#setLsa").checked = $("#lsa").checked;
  if (view) updateReadout();
  saveSettings();
});
$("#setReset").addEventListener("click", function () {
  try { localStorage.removeItem(SETTINGS_KEY); } catch (e) {}
  log("Сохранённые поля сброшены", "ok");
});

$("#scan").addEventListener("click", scan);
$("#dir").addEventListener("keydown", function (e) { if (e.key === "Enter") scan(); });
$("#all").addEventListener("change", function () {
  selected = $("#all").checked ? new Set(rows.map(function (r) { return r.path; })) : new Set();
  render();
});
$("#doXlsx").addEventListener("click", function () { doExport("xlsx"); });
$("#doCsv").addEventListener("click", function () { doExport("csv"); });
$("#doSpan").addEventListener("click", doSpan);
$("#doProtocol").addEventListener("click", doProtocol);
$("#doCreate").addEventListener("click", doCreate);
$("#doPrintAll").addEventListener("click", printAll);
$("#doTransform").addEventListener("click", doTransform);
$("#doMeasure").addEventListener("click", doMeasure);
document.querySelectorAll("[data-pick]").forEach(function (b) {
  b.addEventListener("click", function () {
    var id = b.getAttribute("data-pick");
    var isOut = id === "outDir" || id === "eOutDir" || id === "tOutDir" || id === "gOutDir";
    pick(isOut ? "dir" : "save", id, isOut ? "Папка результата" : "Куда сохранить", $("#" + id).value);
  });
});
log("Готово к работе. Выберите папку и нажмите «Сканировать».");

// Persist the working folders and form values between runs (browser profile of
// the app only; nothing is written outside it).
var SETTINGS_KEY = "openstv.settings.v1";
function saveSettings() {
  try {
    var s = {};
    ["dir", "outDir", "tOutDir", "protoOrg", "protoObject", "protoCable", "protoNorm",
      "protoKind", "protoOut", "xlsxOut", "csvOut", "spanOut",
      "gRange", "gPoints", "gWave", "gPulse", "gIor", "gSlope", "gCable",
      "gFiber", "gOperator", "gName", "gOutDir", "spanA", "spanB"].forEach(function (id) {
      var el = $("#" + id);
      if (el) s[id] = el.value;
    });
    ["rec", "setFiles", "setLsa", "setRatio", "lsa"].forEach(function (id) {
      var el = $("#" + id);
      if (el) s[id] = !!el.checked;
    });
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch (e) {}
}
function loadSettings() {
  try {
    var raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return;
    var s = JSON.parse(raw);
    Object.keys(s).forEach(function (id) {
      var el = $("#" + id);
      if (!el) return;
      if (el.type === "checkbox") el.checked = !!s[id];
      else el.value = s[id];
    });
    if (s.setFiles === false) $("#work").classList.add("nofiles");
    $("#setRatio").checked = !!s.setRatio;
    applyRatio();
    $("#lsa").checked = !!s.lsa;
    $("#setLsa").checked = $("#lsa").checked;
  } catch (e) {}
}
loadSettings();
["input", "select", "change"].forEach(function (evt) {
  document.addEventListener(evt, function (e) {
    if (e.target && e.target.id && e.target.closest(".work, .menubar, .statusbar, .overlay")) saveSettings();
  }, true);
});
</script>
</body>
</html>`;

function send(res, code, type, body) {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

function sendJson(res, code, obj) {
  send(res, code, "application/json; charset=utf-8", JSON.stringify(obj));
}

function readJson(req) {
  return new Promise((resolvePromise, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 32 * 1024 * 1024) {
        reject(new Error("слишком большой запрос"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolvePromise(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch (e) {
        reject(new Error("некорректный JSON"));
      }
    });
    req.on("error", reject);
  });
}

// Downsample a reflectogram to min/max pairs so the browser gets a light payload
// that still keeps narrow spikes and dips (important for event detection).
function downsample(points, resolutionM, maxBuckets = 1600) {
  const x = [];
  const y = [];
  if (!points || points.length === 0) return { x, y };
  const n = points.length;
  const push = (i) => {
    x.push(Number((i * resolutionM).toFixed(3)));
    y.push(Number(points[i].toFixed(3)));
  };
  if (n <= maxBuckets * 2) {
    for (let i = 0; i < n; i++) push(i);
    return { x, y };
  }
  const step = n / maxBuckets;
  for (let b = 0; b < maxBuckets; b++) {
    const start = Math.floor(b * step);
    const end = Math.min(n, Math.floor((b + 1) * step));
    if (end <= start) continue;
    let iMin = start;
    let iMax = start;
    for (let i = start + 1; i < end; i++) {
      if (points[i] < points[iMin]) iMin = i;
      if (points[i] > points[iMax]) iMax = i;
    }
    if (iMin === iMax) {
      push(iMin);
    } else if (iMin < iMax) {
      push(iMin);
      push(iMax);
    } else {
      push(iMax);
      push(iMin);
    }
  }
  return { x, y };
}

function runPowerShell(bodyLines) {
  const script = [
    "[Console]::OutputEncoding=[Text.Encoding]::UTF8",
    "$ErrorActionPreference='Stop'",
    "Add-Type -AssemblyName System.Windows.Forms | Out-Null",
    ...bodyLines,
  ].join("\n");
  const r = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-STA", "-WindowStyle", "Hidden", "-Command", script],
    { encoding: "utf8", windowsHide: true, timeout: 300000 }
  );
  if (r.error) return "";
  return (r.stdout || "").trim();
}

const psQuote = (s) => String(s ?? "").replace(/'/g, "''");

// Keep repeated edits from piling up suffixes: a_edit -> a_crop, not a_edit_crop.
function sourceStem(file) {
  return basename(file, extname(file)).replace(/_(edit|edit2|crop|smooth|events)$/i, "");
}

function pickFolder(title, initial) {
  const lines = [
    "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
    `$d.Description = '${psQuote(title)}'`,
    "$d.ShowNewFolderButton = $true",
  ];
  if (initial) lines.push(`$d.SelectedPath = '${psQuote(initial)}'`);
  lines.push("if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }");
  return runPowerShell(lines);
}

function pickSaveFile(title, initial, filter) {
  const name = initial ? initial.split(/[\\/]/).pop() : "";
  const lines = [
    "$d = New-Object System.Windows.Forms.SaveFileDialog",
    `$d.Title = '${psQuote(title)}'`,
    `$d.Filter = '${psQuote(filter || "Все файлы (*.*)|*.*")}'`,
    `$d.OverwritePrompt = $true`,
  ];
  if (name) lines.push(`$d.FileName = '${psQuote(name)}'`);
  lines.push("if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.FileName) }");
  return runPowerShell(lines);
}

function pickOpenFile(title, initial, filter, multiselect = false) {
  const lines = [
    "$d = New-Object System.Windows.Forms.OpenFileDialog",
    `$d.Title = '${psQuote(title)}'`,
    `$d.Filter = '${psQuote(filter || "Все файлы (*.*)|*.*")}'`,
  ];
  if (multiselect) lines.push("$d.Multiselect = $true");
  if (initial) lines.push(`$d.InitialDirectory = '${psQuote(dirname(initial))}'`);
  if (multiselect) {
    lines.push("if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $d.FileNames | ForEach-Object { [Console]::Out.WriteLine($_) } }");
  } else {
    lines.push("if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.FileName) }");
  }
  return runPowerShell(lines);
}

function tracePayload(rawFile) {
  const raw = String(rawFile ?? "").trim();
  if (!raw) {
    const e = new Error("не указан файл");
    e.status = 400;
    throw e;
  }
  const file = resolve(raw);
  let st;
  try {
    st = statSync(file);
  } catch {
    const e = new Error(`файл не найден: ${file}`);
    e.status = 400;
    throw e;
  }
  if (!st.isFile()) {
    const e = new Error("это не файл");
    e.status = 400;
    throw e;
  }
  let sor;
  try {
    sor = parseSor(readFileSync(file));
  } catch (e) {
    const err = new Error(`не удалось прочитать трассу: ${e.message}`);
    err.status = 400;
    throw err;
  }
  const model = toModel(sor, basename(file));
  const samples = downsample(sor.data?.points, sor.fxd.resolutionM, 1600);
  const params = {
    date: sor.fxd.date.toISOString(),
    wavelengthNm: model.wavelengthNm,
    pulseNs: sor.fxd.pulseWidths,
    ior: model.ior,
    numAverages: model.numAverages,
    averagingTimeS: sor.fxd.averagingTimeS ?? 0,
    cable: model.gen.cableId,
    fiber: model.gen.fiberId,
    operator: model.gen.operator,
    locationA: model.gen.locationA,
    locationB: model.gen.locationB,
    comment: model.gen.comment,
    supplier: model.sup.supplier,
    otdr: model.sup.otdr,
    otdrSerial: model.sup.otdrSerial,
    module: model.sup.module,
    software: model.sup.software,
    checksumOk: model.checksumOk,
  };
  return {
    name: basename(file),
    path: file,
    dir: dirname(file),
    format: String(sor.format),
    points: model.points,
    rangeM: model.rangeM,
    resolutionM: model.resolutionM,
    summary: model.summary,
    params,
    events: model.events.map((e) => ({
      number: e.number,
      distanceM: Number(e.distanceM.toFixed(2)),
      type: e.type,
      typeRaw: e.typeRaw,
      spliceLossDb: e.spliceLossDb,
      reflectionLossDb: e.reflectionLossDb,
      slopeDbPerKm: e.slopeDbPerKm,
      comment: e.comment,
    })),
    samples,
  };
}

async function handle(req, res, opts = {}) {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    return send(res, 200, "text/html; charset=utf-8", PAGE.replaceAll("__VERSION__", VERSION));
  }
  if (req.method === "GET" && url.pathname === "/favicon.ico") {
    res.writeHead(204);
    return res.end();
  }

  if (req.method === "GET" && url.pathname === "/api/ping") {
    return sendJson(res, 200, { ok: true, version: VERSION });
  }

  if (req.method === "POST" && url.pathname === "/api/quit") {
    sendJson(res, 200, { ok: true });
    const quit = typeof opts.onQuit === "function" ? opts.onQuit : () => process.exit(0);
    setTimeout(() => {
      try {
        quit();
      } catch {
        process.exit(0);
      }
    }, 150);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/scan") {
    const body = await readJson(req);
    const picked = Array.isArray(body.files) ? body.files.map((f) => resolve(String(f))).filter(Boolean) : [];
    let files;
    let base;
    if (picked.length) {
      files = picked;
      base = dirname(files[0]);
    } else {
      const dir = String(body.dir ?? "").trim();
      if (!dir) return sendJson(res, 400, { error: "не указана папка или файлы" });
      let st;
      try {
        st = statSync(dir);
      } catch {
        return sendJson(res, 400, { error: `папка не найдена: ${dir}` });
      }
      if (!st.isDirectory()) {
        files = [resolve(dir)];
        base = dirname(files[0]);
      } else {
        files = collect([dir], { recursive: body.recursive !== false });
        base = resolve(dir).replace(/[\\/]+$/, "");
      }
    }
    if (files.length === 0) {
      return sendJson(res, 200, { rows: [], total: 0, events: 0, errors: [], suggest: null });
    }
    const entries = loadEntries(files);
    const rows = [];
    const errors = [];
    let events = 0;
    for (const e of entries) {
      if (e.error) {
        errors.push({ file: e.path, error: e.error });
        continue;
      }
      const row = traceRow(e.model);
      row.path = e.path;
      rows.push(row);
      events += e.model.events.length;
    }
    return sendJson(res, 200, {
      rows,
      total: rows.length,
      events,
      errors,
      source: picked.length ? "files" : "dir",
      suggest: {
        xlsx: join(base, "report.xlsx"),
        csv: join(base, "events.csv"),
        outDir: `${base}_испр`,
      },
    });
  }

  if (req.method === "POST" && url.pathname === "/api/export") {
    const body = await readJson(req);
    const files = Array.isArray(body.files) ? body.files.map(String) : [];
    if (files.length === 0) return sendJson(res, 400, { error: "не выбраны файлы" });
    const entries = loadEntries(files);
    const models = entries.filter((e) => e.model).map((e) => e.model);
    const skipped = entries.filter((e) => e.error).map((e) => ({ file: e.path, error: e.error }));
    if (models.length === 0) return sendJson(res, 400, { error: "не удалось прочитать ни одной трассы" });

    const type = body.type === "csv" ? "csv" : "xlsx";
    const fallback = join(resolve(files[0] ?? ".").replace(/[\\/][^\\/]+$/, ""), type === "csv" ? "events.csv" : "report.xlsx");
    const out = String(body.out ?? "").trim() || fallback;
    try {
      mkdirSync(dirname(resolve(out)), { recursive: true });
    } catch (e) {
      return sendJson(res, 400, { error: `не удалось создать папку: ${e.message}` });
    }
    const abs = type === "csv" ? exportCsv(out, models) : await exportXlsx(out, models);
    return sendJson(res, 200, {
      out: abs,
      traces: models.length,
      events: models.reduce((a, m) => a + m.events.length, 0),
      skipped,
    });
  }

  if (req.method === "POST" && url.pathname === "/api/transform") {
    const body = await readJson(req);
    const files = Array.isArray(body.files) ? body.files.map(String) : [];
    if (files.length === 0) return sendJson(res, 400, { error: "не выбраны файлы" });
    const outDir = String(body.outDir ?? "").trim();
    if (!outDir) return sendJson(res, 400, { error: "не указана папка результата" });

    let dateTs;
    if (body.date) {
      try {
        dateTs = parseDateArg(body.date);
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    const result = transformFiles(files, {
      outDir,
      dateTs,
      shiftDays: body.shiftDays,
      fiberStart: body.fiberStart,
      fiberId: body.fiberId,
      cable: body.cable,
      operator: body.operator,
      locationA: body.locationA,
      locationB: body.locationB,
      comment: body.comment,
      ior: body.ior,
      template: body.template,
      dryRun: !!body.dryRun,
    });
    return sendJson(res, 200, {
      written: body.dryRun ? result.planned.length : result.written,
      target: result.target,
      dryRun: !!body.dryRun,
      errors: result.errors,
    });
  }

  if (req.method === "POST" && url.pathname === "/api/trace") {
    const body = await readJson(req);
    try {
      return sendJson(res, 200, tracePayload(String(body.file ?? "")));
    } catch (e) {
      return sendJson(res, e.status || 400, { error: e.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/bidir") {
    const body = await readJson(req);
    try {
      const front = tracePayload(String(body.file ?? ""));
      const back = tracePayload(String(body.backFile ?? ""));
      const totalM = Math.max(front.rangeM, back.rangeM);
      const tol = Math.max(5, totalM * 0.002);
      const pairs = front.events.map((f) => {
        const candidates = [
          { distanceM: f.distanceM, mirrored: false },
          { distanceM: totalM - f.distanceM, mirrored: true },
        ];
        let best = null;
        let bestDiff = Infinity;
        let bestMirrored = false;
        for (const c of candidates) {
          for (const b of back.events) {
            const diff = Math.abs(b.distanceM - c.distanceM);
            if (diff < bestDiff) {
              bestDiff = diff;
              best = b;
              bestMirrored = c.mirrored;
            }
          }
        }
        const matched = best && bestDiff <= tol ? best : null;
        return {
          number: f.number,
          distanceM: f.distanceM,
          mirrored: matched ? bestMirrored : null,
          forwardLossDb: f.spliceLossDb,
          backwardLossDb: matched ? matched.spliceLossDb : null,
          averageLossDb: matched ? Number(((f.spliceLossDb + matched.spliceLossDb) / 2).toFixed(3)) : null,
          forwardReflectionDb: f.reflectionLossDb,
          backwardReflectionDb: matched ? matched.reflectionLossDb : null,
          comment: f.comment,
        };
      });
      return sendJson(res, 200, { front, back, totalM, toleranceM: tol, pairs });
    } catch (e) {
      return sendJson(res, e.status || 400, { error: e.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/edit") {
    const body = await readJson(req);
    const raw = String(body.file ?? "").trim();
    if (!raw) return sendJson(res, 400, { error: "не указан файл" });
    const file = resolve(raw);
    let buf;
    try {
      buf = readFileSync(file);
    } catch {
      return sendJson(res, 400, { error: `файл не найден: ${file}` });
    }

    const fields = body.fields && typeof body.fields === "object" ? body.fields : {};
    const edits = {};
    const text = (v) => String(v ?? "").trim();

    if (text(fields.date)) {
      try {
        edits.timestamp = parseDateArg(text(fields.date));
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }
    if (text(fields.ior)) {
      const ior = Number(text(fields.ior).replace(",", "."));
      if (!isFinite(ior) || ior < 1.0 || ior > 2.0) {
        return sendJson(res, 400, { error: "показатель преломления должен быть в диапазоне 1.0…2.0" });
      }
      edits.ior = ior;
    }
    for (const [key, field] of [
      ["cableId", "cable"],
      ["fiberId", "fiber"],
      ["operator", "operator"],
      ["locationA", "locationA"],
      ["locationB", "locationB"],
      ["comment", "comment"],
    ]) {
      if (fields[field] !== undefined) edits[key] = text(fields[field]);
    }

    let out;
    try {
      out = updateSor(buf, edits);
    } catch (e) {
      return sendJson(res, 400, {
        error: `не удалось изменить файл: ${e.message}. Правка поддерживается только для формата Bellcore v2.`,
      });
    }

    const outDir = text(body.outDir) ? resolve(text(body.outDir)) : dirname(file);
    try {
      mkdirSync(outDir, { recursive: true });
    } catch (e) {
      return sendJson(res, 400, { error: `не удалось создать папку: ${e.message}` });
    }
    const stem = sourceStem(file);
    let target = join(outDir, `${stem}_edit.sor`);
    if (resolve(target) === file) target = join(outDir, `${stem}_edit2.sor`);
    try {
      writeFileSync(target, out);
    } catch (e) {
      return sendJson(res, 400, { error: `не удалось записать файл: ${e.message}` });
    }
    return sendJson(res, 200, { out: target, bytes: out.length });
  }

  if (req.method === "POST" && url.pathname === "/api/reveal") {
    const body = await readJson(req);
    const raw = String(body.file ?? "").trim();
    if (!raw) return sendJson(res, 400, { error: "не указан файл" });
    const file = resolve(raw);
    let target = file;
    try {
      if (!statSync(file).isFile()) target = dirname(file);
    } catch {
      target = dirname(file);
    }
    try {
      spawn("explorer.exe", target === file ? [`/select,${file}`] : [target], {
        windowsHide: false,
        detached: true,
        stdio: "ignore",
      }).unref();
    } catch (e) {
      return sendJson(res, 400, { error: `не удалось открыть проводник: ${e.message}` });
    }
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/crop") {
    const body = await readJson(req);
    const file = resolve(String(body.file ?? "").trim());
    if (!file) return sendJson(res, 400, { error: "не указан файл" });
    let buf;
    try {
      buf = readFileSync(file);
    } catch {
      return sendJson(res, 400, { error: `файл не найден: ${file}` });
    }
    let sor;
    try {
      sor = parseSor(buf);
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
    let data;
    let evs;
    try {
      data = readTraceData(buf);
      evs = readTraceEvents(buf);
    } catch {
      return sendJson(res, 400, { error: "обрезка поддерживается только для SOR v2 (блок Map)" });
    }
    if (!data || !sor.data) return sendJson(res, 400, { error: "в файле нет данных рефлектограммы" });

    const resolution = sor.fxd.resolutionM;
    const totalM = resolution * (data.n - 1);
    const aM = Math.max(0, Math.min(Number(body.aM) || 0, totalM));
    const bM = Math.max(0, Math.min(Number(body.bM) || totalM, totalM));
    if (bM - aM < resolution * 4) return sendJson(res, 400, { error: "диапазон обрезки слишком мал" });

    const aIdx = Math.max(0, Math.min(data.n - 2, Math.round(aM / resolution)));
    const bIdx = Math.max(aIdx + 1, Math.min(data.n - 1, Math.round(bM / resolution)));
    const newRaw = data.raw.slice(aIdx, bIdx + 1);
    const newData = { ...data, n: newRaw.length, n2: newRaw.length, raw: newRaw };

    const ior = sor.fxd.indexOfRefraction;
    const metersPerRaw = 1e-4 * SOL_KM_PER_US / ior * 1000;
    const shiftM = aIdx * resolution;
    const shiftRaw = Math.round(shiftM / metersPerRaw);
    const newEndM = (newRaw.length - 1) * resolution;

    const kept = [];
    for (const ev of evs.events) {
      const m = ev.distanceRaw * metersPerRaw;
      if (m < shiftM - resolution || m > shiftM + newEndM + resolution) continue;
      const next = { ...ev, distanceRaw: Math.max(0, ev.distanceRaw - shiftRaw) };
      for (const key of ["endOfPreviousRaw", "startOfCurrentRaw", "endOfCurrentRaw", "startOfNextRaw", "peakRaw"]) {
        if (next[key] !== undefined) next[key] = Math.max(0, next[key] - shiftRaw);
      }
      kept.push(next);
    }
    kept.forEach((ev, i) => (ev.number = i + 1));

    const summary = evs.summary
      ? {
          ...evs.summary,
          lossStartRaw: Math.max(0, evs.summary.lossStartRaw - shiftRaw),
          lossEndRaw: Math.max(0, evs.summary.lossEndRaw - shiftRaw),
          orlStartRaw: Math.max(0, evs.summary.orlStartRaw - shiftRaw),
          orlFinishRaw: Math.max(0, evs.summary.orlFinishRaw - shiftRaw),
        }
      : null;

    let out;
    try {
      out = rewriteSor(buf, { data: newData, events: { events: kept, summary }, numDataPoints: newData.n });
    } catch (e) {
      return sendJson(res, 400, { error: `не удалось пересобрать файл: ${e.message}` });
    }

    const outDir = String(body.outDir ?? "").trim() ? resolve(String(body.outDir).trim()) : dirname(file);
    mkdirSync(outDir, { recursive: true });
    const stem = sourceStem(file);
    const target = join(outDir, `${stem}_crop.sor`);
    writeFileSync(target, out);
    return sendJson(res, 200, {
      out: target,
      points: newData.n,
      rangeM: Number(newEndM.toFixed(3)),
      events: kept.length,
      bytes: out.length,
    });
  }

  if (req.method === "POST" && url.pathname === "/api/denoise") {
    const body = await readJson(req);
    const file = resolve(String(body.file ?? "").trim());
    if (!file) return sendJson(res, 400, { error: "не указан файл" });
    let buf;
    try {
      buf = readFileSync(file);
    } catch {
      return sendJson(res, 400, { error: `файл не найден: ${file}` });
    }
    let sor;
    try {
      sor = parseSor(buf);
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
    let data;
    try {
      data = readTraceData(buf);
    } catch {
      return sendJson(res, 400, { error: "шумоподавление поддерживается только для SOR v2 (блок Map)" });
    }
    if (!data || !sor.data) return sendJson(res, 400, { error: "в файле нет данных рефлектограммы" });
    const resolution = sor.fxd.resolutionM;
    const totalM = resolution * (data.n - 1);
    const aM = Math.max(0, Math.min(Number(body.aM) || 0, totalM));
    const bM = Math.max(0, Math.min(Number(body.bM) || totalM, totalM));
    const width = Math.max(3, Math.min(101, Math.round(Number(body.width) || 9) | 1));
    const aIdx = Math.max(0, Math.round(aM / resolution));
    const bIdx = Math.min(data.n - 1, Math.round(bM / resolution));
    if (bIdx - aIdx < width) return sendJson(res, 400, { error: "участок короче окна сглаживания" });

    const raw = Uint16Array.from(data.raw);
    const half = (width - 1) >> 1;
    const window = [];
    for (let i = aIdx; i <= bIdx; i++) {
      const lo = Math.max(aIdx, i - half);
      const hi = Math.min(bIdx, i + half);
      let sum = 0;
      let count = 0;
      for (let j = lo; j <= hi; j++) {
        sum += data.raw[j];
        count++;
      }
      window.push([i, Math.round(sum / count)]);
    }
    for (const [i, v] of window) raw[i] = v;

    let out;
    try {
      out = rewriteSor(buf, { data: { ...data, raw } });
    } catch (e) {
      return sendJson(res, 400, { error: `не удалось пересобрать файл: ${e.message}` });
    }
    const outDir = String(body.outDir ?? "").trim() ? resolve(String(body.outDir).trim()) : dirname(file);
    mkdirSync(outDir, { recursive: true });
    const stem = sourceStem(file);
    const target = join(outDir, `${stem}_smooth.sor`);
    writeFileSync(target, out);
    return sendJson(res, 200, {
      out: target,
      fromM: Number(aM.toFixed(3)),
      toM: Number(bM.toFixed(3)),
      width,
      bytes: out.length,
    });
  }

  if (req.method === "POST" && url.pathname === "/api/event") {
    const body = await readJson(req);
    const file = resolve(String(body.file ?? "").trim());
    if (!file) return sendJson(res, 400, { error: "не указан файл" });
    let buf;
    try {
      buf = readFileSync(file);
    } catch {
      return sendJson(res, 400, { error: `файл не найден: ${file}` });
    }
    let sor;
    try {
      sor = parseSor(buf);
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
    let evs;
    try {
      evs = readTraceEvents(buf);
    } catch {
      return sendJson(res, 400, { error: "правка событий поддерживается только для SOR v2 (блок Map)" });
    }
    if (!evs) return sendJson(res, 400, { error: "в файле нет блока событий" });
    const ior = sor.fxd.indexOfRefraction;
    const metersPerRaw = 1e-4 * SOL_KM_PER_US / ior * 1000;
    const toRaw = (m) => Math.max(0, Math.round(Number(m) / metersPerRaw));
    const toDb1000 = (v) => Math.round(Number(v) * 1000);
    const rangeM = sor.fxd.rangeM;

    let events = evs.events.map((e) => ({ ...e }));
    const action = String(body.action ?? "");
    const payload = body.event && typeof body.event === "object" ? body.event : {};

    if (action === "add") {
      const distanceM = Number(payload.distanceM);
      if (!isFinite(distanceM) || distanceM < 0 || distanceM > rangeM) {
        return sendJson(res, 400, { error: "расстояние вне диапазона трассы" });
      }
      const raw = toRaw(distanceM);
      const refl = Number(payload.reflectionLossDb) || 0;
      const ev = {
        number: events.length + 1,
        distanceRaw: raw,
        slopeDbPerKm: toDb1000(payload.slopeDbPerKm || 0),
        spliceLossDb: toDb1000(payload.spliceLossDb || 0),
        reflectionLossDb: toDb1000(refl),
        typeRaw: payload.type === "reflection" || refl < 0 ? "1FFFFFLS" : "0FFFFFLS",
        comment: String(payload.comment ?? ""),
        endOfPreviousRaw: raw,
        startOfCurrentRaw: raw,
        endOfCurrentRaw: raw,
        startOfNextRaw: raw,
        peakRaw: raw,
      };
      events.push(ev);
    } else if (action === "delete") {
      const index = Number(body.index);
      events = events.filter((e) => e.number !== index);
    } else if (action === "update") {
      const index = Number(body.index);
      const ev = events.find((e) => e.number === index);
      if (!ev) return sendJson(res, 400, { error: `событие №${index} не найдено` });
      if (payload.distanceM !== undefined) {
        const distanceM = Number(payload.distanceM);
        if (!isFinite(distanceM) || distanceM < 0 || distanceM > rangeM) {
          return sendJson(res, 400, { error: "расстояние вне диапазона трассы" });
        }
        const raw = toRaw(distanceM);
        const delta = raw - ev.distanceRaw;
        ev.distanceRaw = raw;
        for (const key of ["endOfPreviousRaw", "startOfCurrentRaw", "endOfCurrentRaw", "startOfNextRaw", "peakRaw"]) {
          if (ev[key] !== undefined) ev[key] = Math.max(0, ev[key] + delta);
        }
      }
      if (payload.spliceLossDb !== undefined) ev.spliceLossDb = toDb1000(payload.spliceLossDb);
      if (payload.reflectionLossDb !== undefined) ev.reflectionLossDb = toDb1000(payload.reflectionLossDb);
      if (payload.slopeDbPerKm !== undefined) ev.slopeDbPerKm = toDb1000(payload.slopeDbPerKm);
      if (payload.comment !== undefined) ev.comment = String(payload.comment ?? "");
      if (payload.type === "reflection") ev.typeRaw = "1FFFFFLS";
      else if (payload.type === "loss") ev.typeRaw = "0FFFFFLS";
    } else {
      return sendJson(res, 400, { error: "неизвестное действие с событием" });
    }

    events.sort((a, b) => a.distanceRaw - b.distanceRaw);
    events.forEach((e, i) => (e.number = i + 1));

    let out;
    try {
      out = rewriteSor(buf, { events: { events, summary: evs.summary } });
    } catch (e) {
      return sendJson(res, 400, { error: `не удалось пересобрать файл: ${e.message}` });
    }
    const outDir = String(body.outDir ?? "").trim() ? resolve(String(body.outDir).trim()) : dirname(file);
    mkdirSync(outDir, { recursive: true });
    const stem = sourceStem(file);
    const target = join(outDir, `${stem}_events.sor`);
    writeFileSync(target, out);
    return sendJson(res, 200, { out: target, events: events.length });
  }

  if (req.method === "POST" && url.pathname === "/api/span") {
    const body = await readJson(req);
    const files = Array.isArray(body.files) ? body.files.map(String) : [];
    if (files.length === 0) return sendJson(res, 400, { error: "не выбраны файлы" });
    const entries = loadEntries(files);
    const models = entries.filter((e) => e.model).map((e) => e.model);
    if (models.length === 0) return sendJson(res, 400, { error: "не удалось прочитать ни одной трассы" });
    const eventA = Math.max(1, Number(body.eventA) || 1);
    const eventB = Math.max(eventA + 1, Number(body.eventB) || 2);
    const out = String(body.out ?? "").trim() ||
      join(resolve(files[0] ?? ".").replace(/[\\/][^\\/]+$/, ""), "span_report.xlsx");
    const abs = await writeSpanReport(out, models, { eventA, eventB });
    return sendJson(res, 200, { out: abs, traces: models.length, eventA, eventB });
  }

  if (req.method === "POST" && url.pathname === "/api/protocol") {
    const body = await readJson(req);
    const files = Array.isArray(body.files) ? body.files.map(String) : [];
    if (files.length === 0) return sendJson(res, 400, { error: "не выбраны файлы" });
    const entries = loadEntries(files);
    const models = entries.filter((e) => e.model).map((e) => e.model);
    if (models.length === 0) return sendJson(res, 400, { error: "не удалось прочитать ни одной трассы" });
    const out = String(body.out ?? "").trim() ||
      join(resolve(files[0] ?? ".").replace(/[\\/][^\\/]+$/, ""), "protocol.html");
    try {
      writeProtocol(out, models, {
        kind: body.kind,
        org: body.org,
        object: body.object,
        cable: body.cable,
        date: body.date,
        normPerKm: body.normPerKm,
      });
    } catch (e) {
      return sendJson(res, 400, { error: `не удалось создать протокол: ${e.message}` });
    }
    return sendJson(res, 200, { out, traces: models.length });
  }

  if (req.method === "POST" && url.pathname === "/api/create") {
    const body = await readJson(req);
    const outDir = String(body.outDir ?? "").trim();
    if (!outDir) return sendJson(res, 400, { error: "не указана папка результата" });
    const rangeM = Number(body.rangeM);
    if (!isFinite(rangeM) || rangeM < 10 || rangeM > 500000) {
      return sendJson(res, 400, { error: "длина трассы должна быть от 10 м до 500 км" });
    }
    const points = Number(body.points) || 3000;
    if (points < 250 || points > 200000) {
      return sendJson(res, 400, { error: "число точек должно быть от 250 до 200000" });
    }
    const events = Array.isArray(body.events)
      ? body.events
          .filter((e) => e && isFinite(Number(e.distanceM)))
          .map((e) => ({
            distanceM: Math.max(0, Number(e.distanceM)),
            spliceLossDb: Number(e.spliceLossDb) || 0,
            reflectionLossDb: Number(e.reflectionLossDb) || 0,
            slopeDbPerKm: Number(e.slopeDbPerKm) || 0,
            comment: String(e.comment ?? ""),
          }))
      : [];
    const bad = events.find((e) => e.distanceM > rangeM);
    if (bad) return sendJson(res, 400, { error: `событие на ${(bad.distanceM / 1000).toFixed(3)} км выходит за длину трассы` });

    let buf;
    try {
      buf = createSor({
        rangeM,
        points,
        ior: Number(body.ior) || 1.468,
        wavelengthNm: Number(body.wavelengthNm) || 1310,
        pulseNs: Number(body.pulseNs) || 10,
        slopeDbPerKm: Number(body.slopeDbPerKm) || 0.35,
        noiseDb: Number(body.noiseDb) || 0.02,
        cableId: String(body.cableId ?? ""),
        fiberId: String(body.fiberId ?? ""),
        operator: String(body.operator ?? ""),
        comment: String(body.comment ?? ""),
        locationA: String(body.locationA ?? ""),
        locationB: String(body.locationB ?? ""),
        events,
      });
    } catch (e) {
      return sendJson(res, 400, { error: `не удалось создать трассу: ${e.message}` });
    }

    try {
      mkdirSync(resolve(outDir), { recursive: true });
    } catch (e) {
      return sendJson(res, 400, { error: `не удалось создать папку: ${e.message}` });
    }
    const name = (String(body.name ?? "").trim() || "new_trace").replace(/[\\/:*?"<>|]+/g, "_");
    const target = join(resolve(outDir), /\.sor$/i.test(name) ? name : `${name}.sor`);
    writeFileSync(target, buf);
    return sendJson(res, 200, {
      out: target,
      bytes: buf.length,
      points,
      rangeM,
      events: events.length,
    });
  }

  if (req.method === "POST" && url.pathname === "/api/measure") {
    const body = await readJson(req);
    const files = Array.isArray(body.files) ? body.files.map(String) : [];
    if (files.length === 0) return sendJson(res, 400, { error: "не выбраны файлы" });
    const outDir = String(body.outDir ?? "").trim();
    if (!outDir) return sendJson(res, 400, { error: "не указана папка результата" });
    const ior = body.ior !== undefined && String(body.ior).trim() ? Number(String(body.ior).replace(",", ".")) : undefined;
    if (ior !== undefined && (!isFinite(ior) || ior < 1 || ior > 2)) {
      return sendJson(res, 400, { error: "показатель преломления должен быть в диапазоне 1.0…2.0" });
    }
    const pulseNs = body.pulseNs !== undefined && String(body.pulseNs).trim() ? Number(body.pulseNs) : undefined;
    const averagingTimeS = body.averagingTimeS !== undefined && String(body.averagingTimeS).trim()
      ? Number(body.averagingTimeS)
      : undefined;
    if (pulseNs === undefined && averagingTimeS === undefined && ior === undefined) {
      return sendJson(res, 400, { error: "не задан ни один параметр измерения" });
    }

    mkdirSync(resolve(outDir), { recursive: true });
    const written = [];
    const errors = [];
    for (const f of files) {
      try {
        let buf = readFileSync(f);
        if (ior !== undefined) buf = updateSor(buf, { ior });
        if (pulseNs !== undefined || averagingTimeS !== undefined) {
          buf = rewriteSor(buf, { pulseNs, averagingTimeS });
        }
        const target = join(resolve(outDir), basename(f));
        writeFileSync(target, buf);
        written.push(target);
      } catch (e) {
        errors.push({ file: f, error: e.message });
      }
    }
    return sendJson(res, 200, { written: written.length, target: resolve(outDir), errors });
  }

  if (req.method === "POST" && url.pathname === "/api/setpoint") {
    const body = await readJson(req);
    const file = resolve(String(body.file ?? "").trim());
    if (!file) return sendJson(res, 400, { error: "не указан файл" });
    let buf;
    try {
      buf = readFileSync(file);
    } catch {
      return sendJson(res, 400, { error: `файл не найден: ${file}` });
    }
    let sor;
    try {
      sor = parseSor(buf);
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
    let data;
    try {
      data = readTraceData(buf);
    } catch {
      return sendJson(res, 400, { error: "правка графика поддерживается только для SOR v2 (блок Map)" });
    }
    if (!data) return sendJson(res, 400, { error: "в файле нет данных рефлектограммы" });
    const points = Array.isArray(body.points) ? body.points : [];
    if (!points.length) return sendJson(res, 400, { error: "нет изменённых точек" });

    let ref = sor.fxd.noiseFloorLevel > 0 ? sor.fxd.noiseFloorLevel : 0;
    if (!ref) for (let i = 0; i < data.raw.length; i++) if (data.raw[i] > ref) ref = data.raw[i];
    const countsPerDb = data.countsPerDb || 1000;
    const resolution = sor.fxd.resolutionM;
    const raw = Uint16Array.from(data.raw);
    let changed = 0;
    for (const p of points) {
      const idx = Math.round(Number(p.distanceM) / resolution);
      if (!isFinite(idx) || idx < 0 || idx >= raw.length) continue;
      const level = Math.max(0, Math.min(65, Number(p.levelDb) || 0));
      raw[idx] = Math.max(0, Math.min(65535, Math.round(ref - level * countsPerDb)));
      changed++;
    }
    if (!changed) return sendJson(res, 400, { error: "точки вне диапазона трассы" });

    const out = rewriteSor(buf, { data: { ...data, raw } });
    const outDir = String(body.outDir ?? "").trim() ? resolve(String(body.outDir).trim()) : dirname(file);
    mkdirSync(outDir, { recursive: true });
    const stem = sourceStem(file);
    const target = join(outDir, `${stem}_visual.sor`);
    writeFileSync(target, out);
    return sendJson(res, 200, { out: target, changed });
  }

  if (req.method === "POST" && url.pathname === "/api/browse") {
    const body = await readJson(req);
    const kind = body.kind === "save" ? "save" : body.kind === "open" ? "open" : body.kind === "files" ? "files" : "dir";
    const title = String(body.title ?? (kind === "save" ? "Куда сохранить" : kind === "files" ? "Выберите файлы трасс" : kind === "open" ? "Выберите файл" : "Выберите папку"));
    const initial = String(body.default ?? "");
    if (kind === "files") {
      const filter = "Трассы (*.sor;*.msor;*.csor;*.trc)|*.sor;*.msor;*.csor;*.trc|Все файлы (*.*)|*.*";
      const out = pickOpenFile(title, initial, filter, true);
      return sendJson(res, 200, { paths: out ? out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [] });
    }
    if (kind === "open") {
      const filter = "Трассы (*.sor;*.msor;*.csor;*.trc)|*.sor;*.msor;*.csor;*.trc|Все файлы (*.*)|*.*";
      return sendJson(res, 200, { path: pickOpenFile(title, initial, filter) });
    }
    if (kind === "save") {
      const filter = /\.csv$/i.test(initial)
        ? "CSV (*.csv)|*.csv|Все файлы (*.*)|*.*"
        : /\.html?$/i.test(initial)
          ? "HTML-документ (*.html)|*.html|Все файлы (*.*)|*.*"
          : "Excel (*.xlsx)|*.xlsx|Все файлы (*.*)|*.*";
      return sendJson(res, 200, { path: pickSaveFile(title, initial, filter) });
    }
    return sendJson(res, 200, { path: pickFolder(title, initial) });
  }

  return sendJson(res, 404, { error: "not found" });
}

function openUrl(url) {
  try {
    spawn("cmd.exe", ["/c", "start", "", url], { windowsHide: true, detached: true, stdio: "ignore" }).unref();
  } catch {
    // Browser will not open automatically; the URL is printed anyway.
  }
}

export { openUrl as openBrowserUrl };

export function startGui({ port = 0, openBrowser = true, onQuit } = {}) {
  const server = createServer((req, res) => {
    handle(req, res, { onQuit }).catch((e) => {
      try {
        sendJson(res, 500, { error: e?.message ?? String(e) });
      } catch {
        res.destroy();
      }
    });
  });

  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const actual = server.address().port;
      const url = `http://127.0.0.1:${actual}/`;
      if (openBrowser) openUrl(url);
      resolvePromise({ url, server, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

export { VERSION as GUI_VERSION };
