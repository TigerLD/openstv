// Minimal Windows-1251 codec (SOR text fields from OTDR tools).
const HIGH =
  "ЂЃ‚ѓ„…†‡€‰Љ‹ЊЌЋЏ" +
  "ђ‘’“”•–—™љ›њќћџ\u0000" +
  "\u00a0ЎўЈ¤Ґ¦§Ё©Є«¬\u00ad®Ї" +
  "°±Ііґµ¶·ё№є»јЅѕї" +
  "АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ" +
  "абвгдежзийклмнопрстуфхцчшщъыьэюя";

const DECODE = new Map();
for (let i = 0; i < HIGH.length; i++) DECODE.set(0x80 + i, HIGH[i]);
const ENCODE = new Map();
for (const [byte, ch] of DECODE) if (ch !== "\u0000") ENCODE.set(ch, byte);

export function cp1251Decode(buf) {
  let s = "";
  for (const b of buf) {
    if (b < 0x80) s += String.fromCharCode(b);
    else s += DECODE.get(b) ?? "\ufffd";
  }
  return s;
}

export function cp1251Encode(str) {
  const out = [];
  for (const ch of str) {
    const code = ch.codePointAt(0);
    if (code < 0x80) out.push(code);
    else {
      const b = ENCODE.get(ch);
      out.push(b ?? 0x3f); // '?'
    }
  }
  return Buffer.from(out);
}
