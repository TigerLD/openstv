// SOR writer: edit metadata blocks and rebuild the file with a fresh CRC.
// Only v2 files are rewritten; block names and order are preserved.
import { cp1251Decode, cp1251Encode } from "./cp1251.mjs";
import { SorError } from "./sor.mjs";

const MAX_POINTS = 5_000_000;
const MAX_BLOCKS = 1024;

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

const cstr = (s) => Buffer.concat([cp1251Encode(s ?? ""), Buffer.from([0])]);

function u16(v) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v & 0xffff);
  return b;
}
function i16(v) {
  const b = Buffer.alloc(2);
  b.writeInt16LE(v | 0);
  return b;
}
function u32(v) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0);
  return b;
}
function i32(v) {
  const b = Buffer.alloc(4);
  b.writeInt32LE(v | 0);
  return b;
}

// Split a v2 file into Map metadata and ordered block bodies.
function readBlocks(buf) {
  try {
    let p = 0;
    const readCstr = () => {
      const start = p;
      while (p < buf.length && buf[p] !== 0) p++;
      const s = buf.toString("latin1", start, p);
      p++;
      return s;
    };
    const mapName = readCstr();
    if (mapName !== "Map") throw new SorError("запись поддерживается только для Bellcore 2.0 (блок Map)");
    const mapVersion = buf.readUInt16LE(p); p += 2;
    const mapSize = buf.readUInt16LE(p); p += 2;
    const unknown = buf.readUInt16LE(p); p += 2;
    const count = buf.readUInt16LE(p); p += 2;
    if (mapSize < 12 || mapSize > buf.length) throw new SorError(`Map: некорректный размер ${mapSize}`);
    if (count < 1 || count > MAX_BLOCKS) throw new SorError(`Map: некорректное число блоков ${count}`);
    const entries = [];
    for (let i = 0; i < count - 1; i++) {
      const name = readCstr();
      if (!name) throw new SorError("Map: пустое имя блока");
      const version = buf.readUInt16LE(p); p += 2;
      const size = buf.readUInt32LE(p); p += 4;
      if (size < name.length + 1) throw new SorError(`Map: блок ${name} короче имени`);
      entries.push({ name, version, size });
    }
    const bodies = [];
    let off = mapSize;
    for (const e of entries) {
      if (off + e.size > buf.length) throw new SorError(`Map: блок ${e.name} выходит за конец файла`);
      const body = buf.subarray(off, off + e.size);
      bodies.push({ ...e, body });
      off += e.size;
    }
    return { mapVersion, unknown, entries: bodies };
  } catch (e) {
    if (e instanceof SorError) throw e;
    throw new SorError(`не удалось разобрать Map: ${e.message}`);
  }
}

function buildMap(mapVersion, unknown, blocks) {
  const entries = [];
  for (const b of blocks) {
    const size = b.body.length + (b.name === "Cksum" ? 2 : 0);
    entries.push(Buffer.concat([
      cstr(b.name),
      u16(b.version),
      Buffer.from([size & 0xff, (size >>> 8) & 0xff, (size >>> 16) & 0xff, (size >>> 24) & 0xff]),
    ]));
  }
  const entriesBuf = Buffer.concat(entries);
  const size = 12 + entriesBuf.length;
  if (size > 0xffff) throw new SorError(`Map: таблица блоков слишком большая (${size} байт)`);
  const sizeBuf = Buffer.alloc(2);
  sizeBuf.writeUInt16LE(size);
  return Buffer.concat([
    Buffer.from("Map\0", "latin1"),
    u16(mapVersion),
    sizeBuf,
    u16(unknown),
    u16(blocks.length + 1),
    entriesBuf,
  ]);
}

// Cksum must be unique and last: the CRC covers every byte before it.
function cksumIndex(blocks) {
  const idx = [];
  blocks.forEach((b, i) => {
    if (b.name === "Cksum") idx.push(i);
  });
  if (idx.length > 1) throw new SorError("несколько блоков Cksum не поддерживаются");
  if (idx.length === 1 && idx[0] !== blocks.length - 1) {
    throw new SorError("блок Cksum должен быть последним");
  }
  return idx.length ? idx[0] : -1;
}

function patchFxd(data, { timestamp, ior }) {
  const d = Buffer.from(data);
  if (timestamp !== undefined) d.writeUInt32LE(timestamp >>> 0, 0);
  if (ior !== undefined) {
    const pwCount = d.readUInt16LE(16);
    let off = 18 + pwCount * 2 + 4 + 4; // sample spacing + num points
    d.writeUInt32LE(Math.round(ior * 1e5) >>> 0, off);
  }
  return d;
}

function buildGen(g, original) {
  const parts = [
    Buffer.from((g.language ?? original.language).padEnd(2, " ").slice(0, 2), "latin1"),
    cstr(g.cableId ?? original.cableId),
    cstr(g.fiberId ?? original.fiberId),
    u16(g.fiberTypeRaw ?? original.fiberTypeRaw),
    u16(g.wavelengthRaw ?? original.wavelengthRaw),
    cstr(g.locationA ?? original.locationA),
    cstr(g.locationB ?? original.locationB),
    cstr(g.cableCodeFiberType ?? original.cableCodeFiberType),
    Buffer.from((g.buildCondition ?? original.buildCondition).padEnd(2, " ").slice(0, 2), "latin1"),
    i32(g.userOffset ?? original.userOffset),
    i32(g.userOffsetDistance ?? original.userOffsetDistance),
    cstr(g.operator ?? original.operator),
    cstr(g.comment ?? original.comment),
  ];
  return Buffer.concat(parts);
}

// Read the GenParams values back out of a block body so we can patch fields.
function readGen(data) {
  let p = 0;
  const r = {
    language: data.toString("latin1", 0, 2),
  };
  p = 2;
  const cstrRead = () => {
    const start = p;
    while (p < data.length && data[p] !== 0) p++;
    const s = cp1251Decode(data.subarray(start, p));
    p++;
    return s;
  };
  r.cableId = cstrRead();
  r.fiberId = cstrRead();
  r.fiberTypeRaw = data.readUInt16LE(p); p += 2;
  r.wavelengthRaw = data.readUInt16LE(p); p += 2;
  r.locationA = cstrRead();
  r.locationB = cstrRead();
  r.cableCodeFiberType = cstrRead();
  r.buildCondition = data.toString("latin1", p, p + 2); p += 2;
  r.userOffset = data.readInt32LE(p); p += 4;
  r.userOffsetDistance = data.readInt32LE(p); p += 4;
  r.operator = cstrRead();
  r.comment = cstrRead();
  return r;
}

const BODY_NAME = (buf) => {
  let p = 0;
  while (p < buf.length && buf[p] !== 0) p++;
  return { name: buf.toString("latin1", 0, p), dataStart: p + 1 };
};

/**
 * Apply metadata edits and return a rebuilt SOR v2 buffer.
 * @param {Buffer} buf original file
 * @param {object} edits {timestamp, ior, fiberId, cableId, operator, locationA, locationB, comment}
 */
function updateSorUnsafe(buf, edits = {}) {
  const parsed = readBlocks(buf);
  const blocks = parsed.entries.map((b) => {
    const { name, dataStart } = BODY_NAME(b.body);
    const data = b.body.subarray(dataStart);
    if (name === "GenParams") {
      const gen = readGen(data);
      return { ...b, body: Buffer.concat([b.body.subarray(0, dataStart), buildGen(edits, gen)]) };
    }
    if (name === "FxdParams") {
      const patched = patchFxd(data, edits);
      return { ...b, body: Buffer.concat([b.body.subarray(0, dataStart), patched]) };
    }
    return b;
  });

  // Cksum body is "Cksum\0" + u16 crc; strip the old CRC and append a fresh one.
  let hasCksum = false;
  cksumIndex(blocks);
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].name === "Cksum") {
      const { dataStart } = BODY_NAME(blocks[i].body);
      blocks[i] = { ...blocks[i], body: blocks[i].body.subarray(0, dataStart) };
      hasCksum = true;
    }
  }

  const map = buildMap(parsed.mapVersion, parsed.unknown, blocks);
  let file = Buffer.concat([map, ...blocks.map((b) => b.body)]);
  if (hasCksum) {
    const crc = crc16ccitt(file);
    const crcBuf = Buffer.alloc(2);
    crcBuf.writeUInt16LE(crc);
    file = Buffer.concat([file, crcBuf]);
  }
  return file;
}

export function updateSor(buf, edits = {}) {
  try {
    return updateSorUnsafe(buf, edits);
  } catch (e) {
    if (e instanceof SorError) throw e;
    throw new SorError(`не удалось пересобрать SOR: ${e.message}`);
  }
}

// ---- trace data and events (for cropping, denoising, event editing) ----

export function readTraceData(buf) {
  const parsed = readBlocks(buf);
  const block = parsed.entries.find((b) => b.name === "DataPts");
  if (!block) return null;
  const { dataStart } = BODY_NAME(block.body);
  const data = block.body.subarray(dataStart);
  if (data.length < 12) throw new SorError("DataPts: блок короче заголовка");
  const n = data.readUInt32LE(0);
  const numTraces = data.readInt16LE(4);
  const n2 = data.readUInt32LE(6);
  const scaleRaw = data.readUInt16LE(10);
  if (numTraces !== 1) {
    throw new SorError(`DataPts: ${numTraces} набора точек; запись поддерживает только один`);
  }
  if (n === 0 || n > MAX_POINTS) throw new SorError(`DataPts: некорректное число точек (${n})`);
  if (n2 !== n) throw new SorError(`DataPts: n=${n} не совпадает с n2=${n2}`);
  if (12 + n * 2 > data.length) throw new SorError("DataPts: массив точек выходит за пределы блока");
  const raw = new Uint16Array(n);
  for (let i = 0; i < n; i++) raw[i] = data.readUInt16LE(12 + i * 2);
  return { n, numTraces, n2, scaleRaw, raw, format: 2 };
}

function buildTraceData({ n, numTraces, n2, scaleRaw, raw }) {
  if (!raw || n !== raw.length) throw new SorError("DataPts: n не совпадает с длиной массива");
  if (numTraces !== 1) throw new SorError("DataPts: запись нескольких наборов не поддерживается");
  if (n2 !== n) throw new SorError("DataPts: n2 должен совпадать с n");
  const head = Buffer.alloc(12);
  head.writeUInt32LE(n, 0);
  head.writeInt16LE(numTraces, 4);
  head.writeUInt32LE(n2, 6);
  head.writeUInt16LE(scaleRaw, 10);
  const pts = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) pts.writeUInt16LE(raw[i] & 0xffff, i * 2);
  return Buffer.concat([head, pts]);
}

export function readTraceEvents(buf) {
  const parsed = readBlocks(buf);
  const block = parsed.entries.find((b) => b.name === "KeyEvents");
  if (!block) return null;
  const { dataStart } = BODY_NAME(block.body);
  const data = block.body.subarray(dataStart);
  const format = 2;
  if (data.length < 2) throw new SorError("KeyEvents: блок короче заголовка");
  const count = data.readUInt16LE(0);
  let p = 2;
  const readCstr = () => {
    const start = p;
    while (p < data.length && data[p] !== 0) p++;
    const s = cp1251Decode(data.subarray(start, p));
    p++;
    return s;
  };
  const events = [];
  for (let i = 0; i < count; i++) {
    if (p + 22 > data.length) throw new SorError(`KeyEvents: событие ${i + 1} обрезано`);
    const ev = {
      number: data.readUInt16LE(p),
      distanceRaw: data.readUInt32LE(p + 2),
      slopeDbPerKm: data.readInt16LE(p + 6),
      spliceLossDb: data.readInt16LE(p + 8),
      reflectionLossDb: data.readInt32LE(p + 10),
      typeRaw: data.toString("latin1", p + 14, p + 22),
    };
    p += 22;
    if (format === 2) {
      if (p + 20 > data.length) throw new SorError(`KeyEvents: событие ${i + 1} обрезано (нет полей v2)`);
      ev.endOfPreviousRaw = data.readUInt32LE(p);
      ev.startOfCurrentRaw = data.readUInt32LE(p + 4);
      ev.endOfCurrentRaw = data.readUInt32LE(p + 8);
      ev.startOfNextRaw = data.readUInt32LE(p + 12);
      ev.peakRaw = data.readUInt32LE(p + 16);
      p += 20;
    }
    ev.comment = readCstr();
    events.push(ev);
  }
  let summary = null;
  if (p + 22 <= data.length) {
    summary = {
      totalLossDb: data.readInt32LE(p),
      lossStartRaw: data.readInt32LE(p + 4),
      lossEndRaw: data.readUInt32LE(p + 8),
      orlDb: data.readUInt16LE(p + 12),
      orlStartRaw: data.readInt32LE(p + 14),
      orlFinishRaw: data.readUInt32LE(p + 18),
    };
  }
  return { events, summary, format };
}

function buildTraceEvents({ events, summary }, format) {
  if (!Array.isArray(events)) throw new SorError("KeyEvents: список событий не задан");
  if (events.length > 0xffff) throw new SorError("KeyEvents: слишком много событий");
  const parts = [u16(events.length)];
  for (const ev of events) {
    parts.push(u16(ev.number));
    parts.push(u32(ev.distanceRaw));
    parts.push(i16(ev.slopeDbPerKm));
    parts.push(i16(ev.spliceLossDb));
    parts.push(i32(ev.reflectionLossDb));
    parts.push(Buffer.from(String(ev.typeRaw ?? "").padEnd(8, "\0").slice(0, 8), "latin1"));
    if (format === 2) {
      for (const key of ["endOfPreviousRaw", "startOfCurrentRaw", "endOfCurrentRaw", "startOfNextRaw", "peakRaw"]) {
        parts.push(u32(ev[key] ?? ev.distanceRaw));
      }
    }
    parts.push(cstr(ev.comment ?? ""));
  }
  if (summary) {
    parts.push(i32(summary.totalLossDb ?? 0));
    parts.push(i32(summary.lossStartRaw ?? 0));
    parts.push(u32(summary.lossEndRaw ?? 0));
    parts.push(u16(summary.orlDb ?? 0));
    parts.push(i32(summary.orlStartRaw ?? 0));
    parts.push(u32(summary.orlFinishRaw ?? 0));
  }
  return Buffer.concat(parts);
}

/**
 * Replace DataPts and/or KeyEvents in a v2 file and rebuild Map + CRC.
 * @param {Buffer} buf original file
 * @param {{data?: object, events?: object}} patch
 */
function rewriteSorUnsafe(buf, patch = {}) {
  const parsed = readBlocks(buf);
  const format = 2;
  const blocks = parsed.entries.map((b) => {
    const { name, dataStart } = BODY_NAME(b.body);
    if (name === "DataPts" && patch.data) {
      return { ...b, body: Buffer.concat([b.body.subarray(0, dataStart), buildTraceData(patch.data)]) };
    }
    if (name === "KeyEvents" && patch.events) {
      return { ...b, body: Buffer.concat([b.body.subarray(0, dataStart), buildTraceEvents(patch.events, format)]) };
    }
    if (name === "FxdParams" && patch.numDataPoints !== undefined) {
      const data = Buffer.from(b.body.subarray(dataStart));
      let off = 4 + 2 + 2 + 4; // timestamp + units + wavelength + acquisition offset
      if (format === 2) off += 4; // acquisition offset distance
      const pwCount = data.readUInt16LE(off);
      off += 2 + pwCount * 2 + 4; // pulse widths + sample spacing
      data.writeUInt32LE(patch.numDataPoints >>> 0, off);
      return { ...b, body: Buffer.concat([b.body.subarray(0, dataStart), data]) };
    }
    if (name === "FxdParams" && (patch.pulseNs !== undefined || patch.averagingTimeS !== undefined)) {
      const data = Buffer.from(b.body.subarray(dataStart));
      let off = 4 + 2 + 2 + 4;
      if (format === 2) off += 4;
      const pwCount = data.readUInt16LE(off);
      if (patch.pulseNs !== undefined && pwCount > 0) {
        data.writeUInt16LE(Math.round(patch.pulseNs) & 0xffff, off + 2);
      }
      if (patch.averagingTimeS !== undefined) {
        const avgOff = off + 2 + pwCount * 2 + 4 + 4 + 4 + 2 + 4;
        if (avgOff + 2 <= data.length) {
          data.writeUInt16LE(Math.round(patch.averagingTimeS * 10) & 0xffff, avgOff);
        }
      }
      return { ...b, body: Buffer.concat([b.body.subarray(0, dataStart), data]) };
    }
    return b;
  });

  let hasCksum = false;
  cksumIndex(blocks);
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].name === "Cksum") {
      const { dataStart } = BODY_NAME(blocks[i].body);
      blocks[i] = { ...blocks[i], body: blocks[i].body.subarray(0, dataStart) };
      hasCksum = true;
    }
  }

  const map = buildMap(parsed.mapVersion, parsed.unknown, blocks);
  let file = Buffer.concat([map, ...blocks.map((b) => b.body)]);
  if (hasCksum) {
    const crc = crc16ccitt(file);
    const crcBuf = Buffer.alloc(2);
    crcBuf.writeUInt16LE(crc);
    file = Buffer.concat([file, crcBuf]);
  }
  return file;
}

export function rewriteSor(buf, patch = {}) {
  try {
    return rewriteSorUnsafe(buf, patch);
  } catch (e) {
    if (e instanceof SorError) throw e;
    throw new SorError(`не удалось пересобрать SOR: ${e.message}`);
  }
}

export function readMetadata(buf) {
  const parsed = readBlocks(buf);
  const gen = parsed.entries.find((b) => b.name === "GenParams");
  if (!gen) return null;
  const { dataStart } = BODY_NAME(gen.body);
  const g = readGen(gen.body.subarray(dataStart));
  const fxd = parsed.entries.find((b) => b.name === "FxdParams");
  let timestamp = null;
  if (fxd) {
    const start = BODY_NAME(fxd.body).dataStart;
    if (start + 4 <= fxd.body.length) timestamp = fxd.body.readUInt32LE(start);
  }
  return {
    ...g,
    timestamp,
    wavelengthNm: g.wavelengthRaw >= 8000 ? g.wavelengthRaw / 10 : g.wavelengthRaw,
  };
}
