// Synthetic SOR v2 generator (virtual OTDR). Builds a Bellcore 2.0 file from
// scratch: Map + GenParams + SupParams + FxdParams + KeyEvents + DataPts + Cksum.
import { cp1251Encode } from "./cp1251.mjs";

const SOL_KM_PER_US = 0.299792458;

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

const cstr = (s) => Buffer.concat([cp1251Encode(String(s ?? "")), Buffer.from([0])]);
const u16 = (v) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v & 0xffff);
  return b;
};
const i16 = (v) => {
  const b = Buffer.alloc(2);
  b.writeInt16LE((v | 0) & 0xffff);
  return b;
};
const u32 = (v) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0);
  return b;
};
const i32 = (v) => {
  const b = Buffer.alloc(4);
  b.writeInt32LE(v | 0);
  return b;
};

function buildGen(g) {
  return Buffer.concat([
    Buffer.from((g.language || "ru").slice(0, 2).padEnd(2, " "), "latin1"),
    cstr(g.cableId),
    cstr(g.fiberId),
    u16(g.fiberTypeRaw ?? 0),
    u16(g.wavelengthNm),
    cstr(g.locationA),
    cstr(g.locationB),
    cstr(g.cableCodeFiberType),
    Buffer.from((g.buildCondition || "  ").slice(0, 2).padEnd(2, " "), "latin1"),
    i32(g.userOffset ?? 0),
    i32(g.userOffsetDistance ?? 0),
    cstr(g.operator),
    cstr(g.comment),
  ]);
}

function buildSup(s) {
  return Buffer.concat([cstr(s.supplier), cstr(s.otdr), cstr(s.otdrSerial), cstr(s.module), cstr(s.moduleSerial), cstr(s.software), cstr(s.other)]);
}

function buildFxd(f) {
  return Buffer.concat([
    u32(f.timestamp),
    Buffer.from("mt", "latin1"),
    u16(f.wavelengthNm),
    i32(0), // acquisition offset
    i32(0), // acquisition offset distance
    u16(1),
    u16(f.pulseNs),
    u32(f.sampleSpacingRaw),
    u32(f.numDataPoints),
    u32(Math.round(f.ior * 1e5)),
    u16(f.backscatterRaw ?? 794),
    u32(f.numAverages ?? 0),
    u16(Math.round((f.averagingTimeS ?? 10) * 10)),
    u32(f.rangeRaw),
    i32(0),
    i32(0), // front panel offset
    u16(f.noiseFloorLevel ?? 65535),
    i16(1000),
    u16(0),
    u16(1), // loss threshold 0.001 dB
    u16(11000), // reflection threshold -11 dB
    u16(3000), // end of trace 3 dB
    Buffer.from("  ", "latin1"),
    i32(0), i32(0), i32(0), i32(0),
  ]);
}

function buildEvents(events, metersPerRaw) {
  const parts = [u16(events.length)];
  for (const ev of events) {
    const raw = Math.max(0, Math.round(ev.distanceM / metersPerRaw));
    parts.push(u16(ev.number));
    parts.push(u32(raw));
    parts.push(i16(Math.round((ev.slopeDbPerKm ?? 0) * 1000)));
    parts.push(i16(Math.round((ev.spliceLossDb ?? 0) * 1000)));
    parts.push(i32(Math.round((ev.reflectionLossDb ?? 0) * 1000)));
    parts.push(Buffer.from(String(ev.typeRaw || "1FFFFFLS").padEnd(8, "\0").slice(0, 8), "latin1"));
    parts.push(u32(raw), u32(raw), u32(raw), u32(raw), u32(raw));
    parts.push(cstr(ev.comment ?? ""));
  }
  return Buffer.concat(parts);
}

function buildData(raw, scaleRaw) {
  const head = Buffer.concat([u32(raw.length), i16(1), u32(raw.length), u16(scaleRaw)]);
  const body = Buffer.alloc(raw.length * 2);
  for (let i = 0; i < raw.length; i++) body.writeUInt16LE(raw[i] & 0xffff, i * 2);
  return Buffer.concat([head, body]);
}

function buildMap(blocks) {
  const entries = blocks.map((b) => {
    const size = b.name.length + 1 + b.data.length + (b.name === "Cksum" ? 2 : 0);
    return Buffer.concat([cstr(b.name), u16(1), u32(size)]);
  });
  const entriesBuf = Buffer.concat(entries);
  const size = 12 + entriesBuf.length;
  return Buffer.concat([
    Buffer.from("Map\0", "latin1"),
    u16(2),
    u16(size),
    u16(0),
    u16(blocks.length + 1),
    entriesBuf,
  ]);
}

/**
 * Build a synthetic OTDR trace.
 * @param {object} opts
 * @returns {Buffer}
 */
export function createSor(opts = {}) {
  const rangeM = Math.max(50, Number(opts.rangeM) || 2000);
  const points = Math.max(250, Math.min(200000, Math.round(Number(opts.points) || 3000)));
  const ior = Number(opts.ior) || 1.468;
  const wavelengthNm = Number(opts.wavelengthNm) || 1310;
  const pulseNs = Number(opts.pulseNs) || 10;
  const slopeDbPerKm = Number(opts.slopeDbPerKm) || 0.35;
  const noiseDb = Number(opts.noiseDb) || 0.02;
  const resolutionM = rangeM / points;
  const metersPerRaw = 1e-4 * SOL_KM_PER_US / ior * 1000;
  const sampleSpacingRaw = Math.round((resolutionM / 1000) / SOL_KM_PER_US * ior * 1e8);

  const userEvents = Array.isArray(opts.events) ? opts.events.slice() : [];
  userEvents.sort((a, b) => a.distanceM - b.distanceM);

  const REF = 65535;
  const startLevel = 41;
  const raw = new Uint16Array(points);
  let lossAt = 0;
  let stepLoss = 0;
  const toRaw = (levelDb) => Math.max(0, Math.min(65535, Math.round(REF - levelDb * 1000)));

  // Reflection peaks at event positions: width of a few samples.
  const peakAt = new Map();
  for (const ev of userEvents) {
    const idx = Math.round(ev.distanceM / resolutionM);
    if (idx <= 0 || idx >= points) continue;
    const refl = Math.abs(Number(ev.reflectionLossDb) || 0);
    // Reflection loss in dB is an ORL value; the visible peak is much smaller.
    const peakDb = Math.min(14, Math.max(1, refl * 0.35));
    peakAt.set(idx, Math.max(peakAt.get(idx) || 0, peakDb));
  }

  let evIdx = 0;
  for (let i = 0; i < points; i++) {
    const distM = i * resolutionM;
    while (evIdx < userEvents.length && userEvents[evIdx].distanceM <= distM) {
      stepLoss += Number(userEvents[evIdx].spliceLossDb) || 0;
      evIdx++;
    }
    let level = startLevel - (distM / 1000) * slopeDbPerKm - stepLoss;
    // Start connector reflection.
    if (i < 3) level += 6 - i * 2;
    // End of fibre: drop into the noise floor.
    if (distM > rangeM * 0.995) level -= (distM - rangeM * 0.995) * 2;
    // Reflection peaks.
    for (let k = -2; k <= 2; k++) {
      const p = peakAt.get(i + k);
      if (p === undefined) continue;
      const weight = k === 0 ? 1 : 0.45 / Math.abs(k);
      level += p * weight;
    }
    if (i > 3) level += (Math.random() * 2 - 1) * noiseDb;
    raw[i] = toRaw(level);
  }

  const events = userEvents.map((ev, i) => ({
    number: i + 1,
    distanceM: ev.distanceM,
    slopeDbPerKm: ev.slopeDbPerKm ?? slopeDbPerKm,
    spliceLossDb: ev.spliceLossDb ?? 0,
    reflectionLossDb: ev.reflectionLossDb ?? -55,
    typeRaw: (ev.reflectionLossDb ?? -55) < 0 ? "1FFFFFLS" : "0FFFFFLS",
    comment: ev.comment ?? "",
  }));

  const now = opts.date instanceof Date ? opts.date : new Date();
  const blocks = [
    {
      name: "GenParams",
      data: buildGen({
        language: "ru",
        cableId: opts.cableId ?? "Синтетика",
        fiberId: opts.fiberId ?? "1",
        wavelengthNm,
        locationA: opts.locationA ?? "A",
        locationB: opts.locationB ?? "B",
        operator: opts.operator ?? "OpenSTV",
        comment: opts.comment ?? "Смоделированная трасса",
      }),
    },
    {
      name: "SupParams",
      data: buildSup({
        supplier: "OpenSTV",
        otdr: "Virtual OTDR",
        otdrSerial: "0000000000",
        module: "",
        moduleSerial: "",
        software: "1.0",
        other: "",
      }),
    },
    {
      name: "FxdParams",
      data: buildFxd({
        timestamp: Math.floor(now.getTime() / 1000),
        wavelengthNm,
        pulseNs,
        sampleSpacingRaw,
        numDataPoints: points,
        ior,
        rangeRaw: Math.round(rangeM / 1000 * 1e5),
        averagingTimeS: opts.averagingTimeS ?? 10,
      }),
    },
    { name: "KeyEvents", data: buildEvents(events, metersPerRaw) },
    { name: "DataPts", data: buildData(raw, 1000) },
    { name: "Cksum", data: Buffer.alloc(0) },
  ];

  const map = buildMap(blocks);
  const bodies = blocks.flatMap((b) => [cstr(b.name), b.data]);
  let file = Buffer.concat([map, ...bodies]);
  file = Buffer.concat([file, u16(crc16ccitt(file))]);
  return file;
}
