// Dependency-free PNG chart renderer for embedding reflectograms into Excel.
// Draws the trace, grid, event marks and numeric axis labels into an RGB buffer
// and encodes it as a PNG (zlib + CRC32).
import { deflateSync } from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    pixels.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// 3x5 digit font, magnified by `scale`.
const DIGITS = {
  "0": ["111", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"],
  "3": ["111", "001", "111", "001", "111"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"],
  "7": ["111", "001", "001", "001", "001"],
  "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "111"],
  ".": ["0", "0", "0", "0", "1"],
  "-": ["000", "000", "111", "000", "000"],
  " ": ["000", "000", "000", "000", "000"],
};

const BLACK = [0, 0, 0];
const GRID = [222, 222, 222];
const FRAME = [120, 120, 120];
const TRACE = [0, 0, 0];
const EVENT = [192, 0, 0];

class Canvas {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.px = Buffer.alloc(w * h * 3, 255);
  }
  set(x, y, color) {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 3;
    this.px[i] = color[0];
    this.px[i + 1] = color[1];
    this.px[i + 2] = color[2];
  }
  hline(x1, x2, y, color) {
    if (x2 < x1) [x1, x2] = [x2, x1];
    for (let x = Math.round(x1); x <= Math.round(x2); x++) this.set(x, y, color);
  }
  vline(x, y1, y2, color) {
    if (y2 < y1) [y1, y2] = [y2, y1];
    for (let y = Math.round(y1); y <= Math.round(y2); y++) this.set(x, y, color);
  }
  rect(x, y, w, h, color) {
    this.hline(x, x + w - 1, y, color);
    this.hline(x, x + w - 1, y + h - 1, color);
    this.vline(x, y, y + h - 1, color);
    this.vline(x + w - 1, y, y + h - 1, color);
  }
  line(x1, y1, x2, y2, color) {
    x1 = Math.round(x1);
    y1 = Math.round(y1);
    x2 = Math.round(x2);
    y2 = Math.round(y2);
    const dx = Math.abs(x2 - x1);
    const dy = Math.abs(y2 - y1);
    const sx = x1 < x2 ? 1 : -1;
    const sy = y1 < y2 ? 1 : -1;
    let err = dx - dy;
    for (;;) {
      this.set(x1, y1, color);
      if (x1 === x2 && y1 === y2) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x1 += sx; }
      if (e2 < dx) { err += dx; y1 += sy; }
    }
  }
  text(str, x, y, scale = 2, color = BLACK) {
    let cx = x;
    for (const ch of String(str)) {
      const glyph = DIGITS[ch] || DIGITS[" "];
      for (let gy = 0; gy < glyph.length; gy++) {
        for (let gx = 0; gx < 3; gx++) {
          if (glyph[gy][gx] !== "1") continue;
          for (let sy = 0; sy < scale; sy++) {
            for (let sx = 0; sx < scale; sx++) {
              this.set(cx + gx * scale + sx, y + gy * scale + sy, color);
            }
          }
        }
      }
      cx += 4 * scale;
    }
    return cx;
  }
}

function niceRange(values) {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!isFinite(min)) return { min: 0, max: 1 };
  if (max - min < 0.2) {
    const c = (min + max) / 2;
    min = c - 0.1;
    max = c + 0.1;
  }
  const pad = (max - min) * 0.08;
  return { min: min - pad, max: max + pad };
}

/**
 * Render a reflectogram to PNG.
 * @param {object} model normalized trace model (trace, events, rangeM)
 * @param {{width?:number,height?:number}} opts
 * @returns {Buffer}
 */
export function renderTracePng(model, opts = {}) {
  const width = opts.width || 900;
  const height = opts.height || 320;
  const canvas = new Canvas(width, height);
  const pad = { l: 54, r: 16, t: 14, b: 30 };
  const plotW = width - pad.l - pad.r;
  const plotH = height - pad.t - pad.b;
  const trace = model.trace || [];
  if (trace.length < 2) return encodePng(width, height, canvas.px);

  const { min, max } = niceRange(trace);
  const rangeM = model.rangeM || 1;
  const X = (m) => pad.l + (m / rangeM) * plotW;
  const Y = (v) => pad.t + ((max - v) / (max - min)) * plotH;

  // Grid and frame.
  for (let i = 0; i <= 5; i++) {
    const x = pad.l + (plotW * i) / 5;
    canvas.vline(x, pad.t, pad.t + plotH, GRID);
    const meters = Math.round((rangeM * i) / 5);
    const label = String(meters);
    canvas.text(label, Math.min(x + 3, width - pad.r - label.length * 8), height - 20, 2);
  }
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + (plotH * i) / 4;
    canvas.hline(pad.l, pad.l + plotW, y, GRID);
    const value = max - ((max - min) * i) / 4;
    const label = value.toFixed(2);
    canvas.text(label, 6, y - 5, 2);
  }
  canvas.rect(pad.l, pad.t, plotW, plotH, FRAME);

  // Trace (decimate to about two points per pixel column).
  const step = Math.max(1, Math.floor(trace.length / (plotW * 2)));
  let prev = null;
  for (let i = 0; i < trace.length; i += step) {
    const px = pad.l + (i / (trace.length - 1)) * plotW;
    const py = Y(trace[i]);
    if (prev) canvas.line(prev[0], prev[1], px, py, TRACE);
    prev = [px, py];
  }

  // Event marks.
  for (const ev of model.events || []) {
    if (ev.distanceM < 0 || ev.distanceM > rangeM) continue;
    const x = X(ev.distanceM);
    canvas.vline(x, pad.t + 2, pad.t + 12, EVENT);
    canvas.vline(x, pad.t + plotH - 12, pad.t + plotH - 2, EVENT);
  }

  return encodePng(width, height, canvas.px);
}
