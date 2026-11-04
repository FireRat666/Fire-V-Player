/**
 * @fileoverview A small QR code maker for short links: alphanumeric mode only (0-9, A-Z, space and
 * $%*+-./:), so the text has to be in capitals, and versions 1 to 3 (21 to 29 squares). That keeps
 * the squares big and easy to scan. Based on the QR spec and Nayuki's QR Code generator (MIT).
 *
 * FireQR.make('HTTPS://EXAMPLE.COM/P/ABC234') -> ['1111111010...', ...] (1 = dark), or null when
 * the text doesn't fit or has other characters.
 */
var FireQR = (() => {
  const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
  // [data codewords, error correction codewords] for versions 1-3 (one block each).
  const LEVELS = [
    { name: 'M', bits: 0, sizes: [[16, 10], [28, 16], [44, 26]] },
    { name: 'L', bits: 1, sizes: [[19, 7], [34, 10], [55, 15]] }
  ];

  const gfMul = (x, y) => {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11d);
      z ^= ((y >>> i) & 1) * x;
    }
    return z;
  };

  const errorCodewords = (data, degree) => {
    const divisor = new Array(degree).fill(0);
    divisor[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < degree; j++) {
        divisor[j] = gfMul(divisor[j], root);
        if (j + 1 < degree) divisor[j] ^= divisor[j + 1];
      }
      root = gfMul(root, 2);
    }
    const result = new Array(degree).fill(0);
    for (const b of data) {
      const factor = b ^ result.shift();
      result.push(0);
      for (let i = 0; i < degree; i++) result[i] ^= gfMul(divisor[i], factor);
    }
    return result;
  };

  // The text as data codewords, padded to the version's size.
  const dataCodewords = (text, count) => {
    const bits = [];
    const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    put(2, 4); // alphanumeric mode
    put(text.length, 9);
    for (let i = 0; i + 1 < text.length; i += 2) put(CHARS.indexOf(text[i]) * 45 + CHARS.indexOf(text[i + 1]), 11);
    if (text.length % 2) put(CHARS.indexOf(text[text.length - 1]), 6);
    const capacity = count * 8;
    put(0, Math.min(4, capacity - bits.length));
    while (bits.length % 8) bits.push(0);
    const bytes = [];
    for (let i = 0; i < bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8).join(''), 2));
    for (let pad = 0xec; bytes.length < count; pad ^= 0xec ^ 0x11) bytes.push(pad);
    return bytes;
  };

  const MASKS = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x, y) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => (x * y) % 2 + (x * y) % 3 === 0,
    (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0,
    (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0
  ];

  // Builds the squares for one version, level and mask.
  const build = (version, level, codewords, mask) => {
    const size = version * 4 + 17;
    const dark = [], fixed = [];
    for (let y = 0; y < size; y++) { dark.push(new Array(size).fill(false)); fixed.push(new Array(size).fill(false)); }
    const set = (x, y, on) => { dark[y][x] = on; fixed[y][x] = true; };

    for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); } // timing
    for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) { // finders and their borders
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const x = cx + dx, y = cy + dy;
          if (x < 0 || y < 0 || x >= size || y >= size) continue;
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          set(x, y, d !== 2 && d !== 4);
        }
      }
    }
    if (version > 1) { // one alignment pattern
      const c = size - 7;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(c + dx, c + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }

    // Format information: level and mask, with its own error correction, in two copies.
    const info = (level.bits << 3) | mask;
    let rem = info;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const format = ((info << 10) | rem) ^ 0x5412;
    const bit = i => ((format >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6));
    set(8, 8, bit(7));
    set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);

    // The data, in the zigzag order, masked.
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      const upward = ((right + 1) & 2) === 0;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j, y = upward ? size - 1 - vert : vert;
          if (fixed[y][x]) continue;
          let on = false;
          if (i < codewords.length * 8) { on = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1; i++; }
          dark[y][x] = on !== MASKS[mask](x, y);
        }
      }
    }
    return dark;
  };

  // How hard a pattern is to scan (the spec's penalty rules); the lowest wins.
  const penalty = dark => {
    const size = dark.length;
    let score = 0, count = 0;
    const lines = [];
    for (let k = 0; k < size; k++) { lines.push(dark[k]); lines.push(dark.map(r => r[k])); }
    for (const line of lines) {
      let run = 1;
      for (let k = 1; k <= size; k++) {
        if (k < size && line[k] === line[k - 1]) { run++; continue; }
        if (run >= 5) score += run - 2;
        run = 1;
      }
      const s = line.map(v => (v ? '1' : '0')).join('');
      for (let k = s.indexOf('1011101'); k !== -1; k = s.indexOf('1011101', k + 1)) {
        if (s.slice(Math.max(0, k - 4), k) === '0000' || s.slice(k + 7, k + 11) === '0000') score += 40;
      }
    }
    for (let y = 0; y + 1 < size; y++) {
      for (let x = 0; x + 1 < size; x++) {
        const v = dark[y][x];
        if (v === dark[y][x + 1] && v === dark[y + 1][x] && v === dark[y + 1][x + 1]) score += 3;
      }
    }
    for (const r of dark) for (const v of r) if (v) count++;
    score += Math.floor(Math.abs(count * 20 - size * size * 10) / (size * size)) * 10;
    return score;
  };

  const make = text => {
    text = String(text || '');
    if (!text || [...text].some(c => CHARS.indexOf(c) === -1)) return null;
    const needBits = 13 + Math.floor(text.length / 2) * 11 + (text.length % 2) * 6;
    for (let v = 1; v <= 3; v++) {
      for (const level of LEVELS) {
        const [dataCount, ecCount] = level.sizes[v - 1];
        if (needBits > dataCount * 8) continue;
        const data = dataCodewords(text, dataCount);
        const codewords = data.concat(errorCodewords(data, ecCount));
        let best = null, bestScore = Infinity;
        for (let mask = 0; mask < 8; mask++) {
          const dark = build(v, level, codewords, mask);
          const score = penalty(dark);
          if (score < bestScore) { best = dark; bestScore = score; }
        }
        return best.map(r => r.map(on => (on ? '1' : '0')).join(''));
      }
    }
    return null;
  };

  return { make };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = FireQR;
