// Minimal, dependency-free SR-4731 (Bellcore/Telcordia) SOR parser.
// Supports v1.x (no block names) and v2.x (named blocks + Map).
// Units follow what the instrument actually wrote; see notes/05-sor-format.md.

import { cp1251Decode } from "./cp1251.mjs";

const SOL_KM_PER_US = 0.299792458; // speed of light, km per microsecond (round trip handled by /2)

function crc16ccitt(buf) {
  let crc = 0xffff;
  for (const b of buf) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

class Reader {
  constructor(buf, offset = 0) {
    this.buf = buf;
    this.pos = offset;
  }
  seek(p) { this.pos = p; return this; }
  tell() { return this.pos; }
  u8() { const v = this.buf[this.pos]; this.pos += 1; return v; }
  u16() { const v = this.buf.readUInt16LE(this.pos); this.pos += 2; return v; }
  i16() { const v = this.buf.readInt16LE(this.pos); this.pos += 2; return v; }
  u32() { const v = this.buf.readUInt32LE(this.pos); this.pos += 4; return v; }
  i32() { const v = this.buf.readInt32LE(this.pos); this.pos += 4; return v; }
  bytes(n) { const v = this.buf.subarray(this.pos, this.pos + n); this.pos += n; return v; }
  cstr() {
    const start = this.pos;
    while (this.pos < this.buf.length && this.buf[this.pos] !== 0) this.pos++;
    const s = cp1251Decode(this.buf.subarray(start, this.pos));
    if (this.pos < this.buf.length) this.pos++;
    return s;
  }
  remaining() { return this.buf.length - this.pos; }
}

// v2 Map: "Map\0" + u16 version + u16 totalSize + u32 mapBytes + u16 totalBlocks - 1
// then per block: name\0 + u16 version + u32 size. Body follows after the map block.
function readMap(buf) {
  const r = new Reader(buf, 0);
  const name = r.cstr();
  const version = r.u16();
  const totalSize = r.u32();
  if (name !== "Map") return { format: 1 };
  const count = r.u16() - 1;
  const entries = [];
  for (let i = 0; i < count; i++) {
    const bname = r.cstr();
    const bver = r.u16();
    const bsize = r.u32();
    entries.push({ name: bname, version: bver, size: bsize });
  }
  const blocks = {};
  let start = 0;
  // First block starts at totalSize (map block full size).
  start = totalSize;
  for (const e of entries) {
    blocks[e.name] = { ...e, start, dataStart: start + e.name.length + 1 };
    start += e.size;
  }
  return { format: 2, totalSize, entries, blocks };
}

// v1: sequential blocks, each "Name\0" + u16 size? In practice v1 blocks are
// name-terminated by NUL and size is a u16 right after. Structure is detected
// by trying names in order.
function readV1Blocks(buf) {
  const names = ["GenParams", "SupParams", "FxdParams", "KeyEvents", "DataPts", "Cksum"];
  const blocks = {};
  let start = 0;
  const r = new Reader(buf, 0);
  for (const expected of names) {
    r.seek(start);
    const name = r.cstr();
    if (name !== expected) break;
    const version = r.u16();
    const size = r.u16();
    blocks[name] = { name, version, size, start, dataStart: r.tell() };
    start += size;
  }
  return { format: 1, blocks };
}

function parseGenParams(r, block) {
  r.seek(block.dataStart);
  const g = {};
  g.language = r.bytes(2).toString("latin1").replace(/\0/g, "");
  g.cableId = r.cstr();
  g.fiberId = r.cstr();
  g.fiberTypeRaw = r.u16();
  g.wavelengthRaw = r.u16();
  g.locationA = r.cstr();
  g.locationB = r.cstr();
  g.cableCodeFiberType = r.cstr();
  g.buildCondition = r.bytes(2).toString("latin1").replace(/\0/g, "");
  g.userOffset = r.i32();
  g.userOffsetDistance = r.i32();
  g.operator = r.cstr();
  g.comment = r.pos < block.start + block.size ? r.cstr() : "";
  // Instrument writes wavelength in nm here (1310), despite SR-4731 saying 0.1 nm.
  g.wavelengthNm = g.wavelengthRaw >= 8000 ? g.wavelengthRaw / 10 : g.wavelengthRaw;
  return g;
}

function parseSupParams(r, block) {
  r.seek(block.dataStart);
  return {
    supplier: r.cstr(),
    otdr: r.cstr(),
    otdrSerial: r.cstr(),
    module: r.cstr(),
    moduleSerial: r.cstr(),
    software: r.cstr(),
    other: r.cstr(),
  };
}

function parseFxdParams(r, block, format) {
  r.seek(block.dataStart);
  const f = {};
  f.timestamp = r.u32();
  f.date = new Date(f.timestamp * 1000);
  f.unitCode = r.bytes(2).toString("latin1");
  f.wavelengthRaw = r.u16();
  // SR-4731: 0.1 nm. This instrument writes plain nm (1310).
  f.wavelengthNm = f.wavelengthRaw >= 8000 ? f.wavelengthRaw / 10 : f.wavelengthRaw;
  f.acquisitionOffset = r.i32();
  if (format === 2) f.acquisitionOffsetDistance = r.i32();
  const pwCount = r.u16();
  f.pulseWidths = [];
  for (let i = 0; i < pwCount; i++) f.pulseWidths.push(r.u16());
  f.sampleSpacingRaw = r.u32();
  f.sampleSpacingUs = f.sampleSpacingRaw * 1e-8;
  f.numDataPoints = r.u32();
  f.indexOfRefraction = r.u32() * 1e-5;
  f.backscatterRaw = r.u16();
  f.backscatterDb = -f.backscatterRaw * 0.1;
  f.numAverages = r.u32();
  if (format === 2) f.averagingTimeS = r.u16() * 0.1;
  f.rangeRaw = r.u32();
  if (format === 2) f.acquisitionRangeDistance = r.i32();
  f.frontPanelOffset = r.i32();
  f.noiseFloorLevel = r.u16();
  f.noiseFloorScale = r.i16();
  f.powerOffsetFirstPoint = r.u16();
  f.lossThresholdDb = r.u16() * 1e-3;
  f.reflectionThresholdDb = -r.u16() * 1e-3;
  f.endOfTraceThresholdDb = r.u16() * 1e-3;
  if (format === 2) {
    f.traceType = r.bytes(2).toString("latin1");
    f.x1 = r.i32(); f.y1 = r.i32(); f.x2 = r.i32(); f.y2 = r.i32();
  }
  // Two-way propagation: dz = c * dt / (2 * n)
  f.resolutionM = (f.sampleSpacingUs * SOL_KM_PER_US / f.indexOfRefraction) * 1000;
  f.rangeM = f.resolutionM * f.numDataPoints;
  return f;
}

function parseKeyEvents(r, block, fxd, format) {
  r.seek(block.dataStart);
  const n = r.u16();
  const events = [];
  // distance is time-of-flight in 0.1 ns units
  const distFactorKm = 1e-4 * SOL_KM_PER_US / fxd.indexOfRefraction;
  for (let i = 0; i < n; i++) {
    const number = r.u16();
    const distanceRaw = r.u32();
    const slope = r.i16() * 1e-3;
    const spliceLoss = r.i16() * 1e-3;
    const reflectionLoss = r.i32() * 1e-3;
    const typeRaw = r.bytes(8).toString("latin1");
    const ev = {
      number,
      distanceM: distanceRaw * distFactorKm * 1000,
      slopeDbPerKm: slope,
      spliceLossDb: spliceLoss,
      reflectionLossDb: reflectionLoss,
      typeRaw,
      type: decodeEventType(typeRaw),
    };
    if (format === 2) {
      ev.endOfPreviousM = r.u32() * distFactorKm * 1000;
      ev.startOfCurrentM = r.u32() * distFactorKm * 1000;
      ev.endOfCurrentM = r.u32() * distFactorKm * 1000;
      ev.startOfNextM = r.u32() * distFactorKm * 1000;
      ev.peakM = r.u32() * distFactorKm * 1000;
    }
    ev.comment = r.cstr();
    events.push(ev);
  }
  const summary = {};
  try {
    if (r.tell() + 22 <= block.start + block.size) {
      summary.totalLossDb = r.i32() * 1e-3;
      summary.lossStartM = r.i32() * distFactorKm * 1000;
      summary.lossEndM = r.u32() * distFactorKm * 1000;
      summary.orlDb = r.u16() * 1e-3;
      summary.orlStartM = r.i32() * distFactorKm * 1000;
      summary.orlFinishM = r.u32() * distFactorKm * 1000;
    }
  } catch {
    // summary is optional
  }
  return { count: n, events, summary };
}

function decodeEventType(raw) {
  const m = /^(.)(.)([0-9A-Fa-f]{4})L([SE])$/.exec(raw);
  if (!m) return raw;
  const [, subtype, method, code, dir] = m;
  const kind =
    subtype === "0" ? "Потери" :
    subtype === "1" ? "Отражение" :
    subtype === "2" ? "Мульти" : `Тип ${subtype}`;
  const how = method === "A" ? "авто" : method === "M" ? "ручн." : "";
  const sentinel = code.toUpperCase() === "FFFF" ? "" : `, порог ${code}`;
  const details = [how, sentinel.replace(/^, /, ""), dir === "E" ? "конец" : ""].filter(Boolean).join(", ");
  return details ? `${kind} (${details})` : kind;
}

function parseDataPts(r, block, fxd) {
  r.seek(block.dataStart);
  const n = r.u32();
  const numTraces = r.i16();
  const n2 = r.u32();
  const scaleRaw = r.u16();
  // SR-4731: scale factor = counts per dB (1000 => 0.001 dB per count).
  const countsPerDb = scaleRaw > 0 ? scaleRaw : 1000;
  const scale = 1 / countsPerDb;
  const raw = new Uint16Array(n);
  for (let i = 0; i < n; i++) raw[i] = r.u16();
  // Level in dB relative to the noise floor: 0 dB at the far-end noise, higher
  // values where the backscatter is stronger. This matches what OTDR viewers
  // draw (sloping trace with upward reflection peaks).
  let ref = fxd?.noiseFloorLevel > 0 ? fxd.noiseFloorLevel : 0;
  if (!ref) {
    for (let i = 0; i < n; i++) if (raw[i] > ref) ref = raw[i];
  }
  const points = new Float64Array(n);
  for (let i = 0; i < n; i++) points[i] = (ref - raw[i]) * scale;
  return { n, numTraces, n2, scale, countsPerDb, ref, raw, points };
}

export function parseSor(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const map = readMap(buf);
  const blocks = map.format === 2 ? map.blocks : readV1Blocks(buf).blocks;
  const format = map.format;
  if (!blocks.FxdParams) throw new Error("not a SOR file: FxdParams block not found");

  const r = new Reader(buf, 0);
  const gen = blocks.GenParams ? parseGenParams(r, blocks.GenParams) : null;
  const sup = blocks.SupParams ? parseSupParams(r, blocks.SupParams) : null;
  const fxd = parseFxdParams(r, blocks.FxdParams, format);
  const keyEvents = blocks.KeyEvents ? parseKeyEvents(r, blocks.KeyEvents, fxd, format) : { count: 0, events: [], summary: {} };
  const data = blocks.DataPts ? parseDataPts(r, blocks.DataPts, fxd) : null;

  let checksum = null;
  if (blocks.Cksum) {
    const crcPos = blocks.Cksum.dataStart;
    const stored = buf.readUInt16LE(crcPos);
    const calc = crc16ccitt(buf.subarray(0, crcPos));
    checksum = { stored, calculated: calc, match: stored === calc };
  }

  return { format, map, gen, sup, fxd, events: keyEvents, data, checksum, blocks };
}

export function summarize(sor, name = "") {
  const ev = sor.events.events;
  return {
    file: name,
    format: `v${sor.format}`,
    date: sor.fxd.date.toISOString(),
    cable: sor.gen?.cableId ?? "",
    fiber: sor.gen?.fiberId ?? "",
    operator: sor.gen?.operator ?? "",
    wavelengthNm: sor.gen?.wavelengthNm ?? sor.fxd.wavelengthNm,
    pulseNs: sor.fxd.pulseWidths.join("/"),
    points: sor.fxd.numDataPoints,
    rangeM: Math.round(sor.fxd.rangeM),
    resolutionM: Number(sor.fxd.resolutionM.toFixed(3)),
    ior: sor.fxd.indexOfRefraction,
    unit: sor.fxd.unitCode,
    events: ev.length,
    totalLossDb: ev.length ? Number((ev[ev.length - 1].spliceLossDb + ev[ev.length - 1].slopeDbPerKm).toFixed(3)) : null,
    checksum: sor.checksum?.match ?? null,
    eventList: ev.map((e) => ({
      n: e.number,
      distanceM: Number(e.distanceM.toFixed(2)),
      type: e.type,
      spliceLossDb: e.spliceLossDb,
      reflectionLossDb: e.reflectionLossDb,
      slopeDbPerKm: e.slopeDbPerKm,
      comment: e.comment.trim(),
    })),
  };
}


