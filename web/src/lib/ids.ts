// UUIDv7 ids, made in the browser: 48 bits of Unix milliseconds, then random
// bits, in the canonical lower-case form. They sort by creation time, so a
// row can be given its id before the server has seen it. A 12-bit counter
// keeps ids made in the same millisecond in order (same as internal/id).

let lastMs = 0;
let lastSeq = 0;

export function newId(now: number = Date.now()): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);

  let ms = now;
  let seq = (((b[6] ?? 0) << 8) | (b[7] ?? 0)) & 0x0fff;
  if (ms <= lastMs) {
    ms = lastMs;
    seq = lastSeq + 1;
    if (seq > 0x0fff) {
      ms += 1;
      seq = 0;
    }
  }
  lastMs = ms;
  lastSeq = seq;

  // 48-bit timestamp, big-endian. Bit operators stop at 32 bits, so divide.
  b[0] = Math.floor(ms / 2 ** 40) & 0xff;
  b[1] = Math.floor(ms / 2 ** 32) & 0xff;
  b[2] = Math.floor(ms / 2 ** 24) & 0xff;
  b[3] = Math.floor(ms / 2 ** 16) & 0xff;
  b[4] = Math.floor(ms / 2 ** 8) & 0xff;
  b[5] = ms & 0xff;
  b[6] = 0x70 | (seq >> 8); // version 7
  b[7] = seq & 0xff;
  b[8] = 0x80 | ((b[8] ?? 0) & 0x3f); // variant 10

  let hex = "";
  for (const byte of b) hex += byte.toString(16).padStart(2, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
