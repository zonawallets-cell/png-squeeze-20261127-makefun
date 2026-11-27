// PNG squeeze: lossless screenshot compressor for make.fun png-squeeze-01.
// Front end: colour-type reduction (palette / grey / grey+alpha / RGB / RGBA,
// tRNS key), per-row adaptive filter choice (minimum-sum + brute force weighed
// by real deflate cost). Back end: my own optimal-parsing DEFLATE encoder
// (hash-chain LZ77 + shortest-path parse + dynamic Huffman, iterated) — the
// step past zlib-9 that the leaderboard's scale-level cluster does not have.
// Pure Node stdlib only. Deterministic: fixed effort limits, no clock, no env,
// no reads outside /input and /bot. One wall budget is spent by fixed work,
// never by the clock.
import { inflateSync, deflateSync, constants } from 'node:zlib';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const W = 1280;
const H = 720;
const N = W * H;

// ---------------------------------------------------------------- CRC-32
const CRC_TAB = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(b, s, e) {
  let c = -1;
  for (let i = s; i < e; i++) c = CRC_TAB[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  out[4] = type.charCodeAt(0); out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2); out[7] = type.charCodeAt(3);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}
function pngOf(chunks) {
  let size = 8;
  for (const c of chunks) size += c.length;
  const out = new Uint8Array(size);
  out.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  let at = 8;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}
function ihdr(ct) {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, W); v.setUint32(4, H);
  d[8] = 8; d[9] = ct;
  return d;
}

// ---------------------------------------------------------------- PNG decode
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}
// Decode any accepted PNG (bit depth 8, colour types 0/2/3/4/6) to RGBA.
function decodePng(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let ct = -1; let w = 0; let h = 0;
  let palette = null; let trns = null;
  const idat = [];
  while (at + 12 <= bytes.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      w = dv.getUint32(0); h = dv.getUint32(4); ct = data[9];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  const bpp = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ct];
  const stride = w * bpp;
  const raw = inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat));
  const samples = new Uint8Array(h * stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const o = y * stride; const p = o - stride;
    if (ft === 0) samples.set(raw.subarray(src, src + stride), o);
    else if (ft === 1) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
    } else {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? samples[o + i - bpp] : 0;
        const b = y > 0 ? samples[p + i] : 0;
        const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
        samples[o + i] = raw[src + i] + paeth(a, b, c);
      }
    }
  }
  const rgba = new Uint8Array(w * h * 4);
  if (ct === 6) rgba.set(samples);
  else if (ct === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < w * h; i++, s += 3, d += 4) {
      rgba[d] = samples[s]; rgba[d + 1] = samples[s + 1]; rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (ct === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < w * h; i++, d += 4) {
      const g = samples[i];
      rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (ct === 4) {
    for (let i = 0, s = 0, d = 0; i < w * h; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    for (let i = 0, d = 0; i < w * h; i++, d += 4) {
      const e = samples[i] * 3;
      rgba[d] = palette[e]; rgba[d + 1] = palette[e + 1]; rgba[d + 2] = palette[e + 2];
      rgba[d + 3] = trns !== null && samples[i] < trns.length ? trns[samples[i]] : 255;
    }
  }
  return rgba;
}

// ---------------------------------------------------------------- PNG filters
function filterRow(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) { out.set(cur); return; }
  if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    if (prev === null) { out.set(cur); return; }
    for (let i = 0; i < n; i++) out[i] = cur[i] - prev[i];
  } else if (type === 3) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paeth(a, b, c);
    }
  }
}
function signedSum(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) { const v = row[i]; s += v < 128 ? v : 256 - v; }
  return s;
}

// ---------------------------------------------------------------- analysis
// One pass over the RGBA: opaque?, grey?, distinct colours (up to 257),
// the single transparent-key value (if every non-opaque pixel is alpha 0 of
// one RGB value and no opaque pixel shares it).
function analyse(rgba) {
  const u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, N);
  let opaque = true;
  let grey = true;
  const counts = new Map();
  let many = false;
  for (let i = 0; i < N; i++) {
    const d = i * 4;
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const c = u32[i];
      const k = counts.get(c);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(c, 1);
      } else counts.set(c, k + 1);
    }
  }
  let colours = null;
  if (!many) {
    colours = [...counts.entries()].map(([word, count]) => ({
      r: word & 0xff, g: (word >> 8) & 0xff, b: (word >> 16) & 0xff, a: (word >>> 24) & 0xff,
      word, count,
    }));
  }
  // Transparent key: one RGB value, alpha 0 everywhere it appears, never opaque.
  let key = -1; let keyOk = true;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) { keyOk = false; break; }
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) { keyOk = false; break; }
  }
  if (keyOk && key !== -1) {
    for (let d = 0; d < rgba.length; d += 4) {
      if (rgba[d + 3] !== 255) continue;
      const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
      if (v === key) { keyOk = false; break; }
    }
  }
  return { opaque, grey, colours, tkey: keyOk && key !== -1 ? key : -1 };
}

// Palette orderings. Transparent entries first (short tRNS), then:
// 'count' — most frequent first; 'lum' — by luminance; 'nn' — greedy
// nearest-neighbour walk through RGB space from the most frequent colour, so
// neighbouring pixels tend to get neighbouring indices (filters love that).
function paletteOrder(colours, order) {
  const lum = (c) => 299 * c.r + 587 * c.g + 114 * c.b;
  const base = [...colours].sort((x, y) => {
    const ta = x.a === 255 ? 1 : 0, tb = y.a === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.a !== y.a) return x.a - y.a;
    return 0;
  });
  // Stable split: transparent first, opaque after; order each group.
  const trans = base.filter((c) => c.a !== 255);
  const opaq = base.filter((c) => c.a === 255);
  const sortGroup = (g) => {
    if (order === 'lum') return g.sort((x, y) => lum(x) - lum(y) || x.word - y.word);
    if (order === 'nn') {
      if (g.length <= 1) return g;
      const rest = [...g].sort((x, y) => y.count - x.count || x.word - y.word);
      const out = [rest.shift()];
      const used = new Set([out[0].word]);
      let cur = out[0];
      while (rest.length > 0) {
        let bi = 0; let bd = Infinity;
        for (let i = 0; i < rest.length; i++) {
          const c = rest[i];
          const dr = c.r - cur.r, dg = c.g - cur.g, db = c.b - cur.b;
          const dd = dr * dr + dg * dg + db * db - c.count * 0.0001;
          if (dd < bd) { bd = dd; bi = i; }
        }
        cur = rest.splice(bi, 1)[0];
        used.add(cur.word);
        out.push(cur);
      }
      return out;
    }
    return g.sort((x, y) => y.count - x.count || x.word - y.word);
  };
  return [...sortGroup(trans), ...sortGroup(opaq)];
}

function paletteForm(rgba, colours, order) {
  const entries = paletteOrder(colours, order);
  const index = new Map();
  entries.forEach((c, i) => index.set(c.word, i));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.r; plte[i * 3 + 1] = c.g; plte[i * 3 + 2] = c.b;
    if (c.a !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.a);
  const u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, N);
  const indices = new Uint8Array(N);
  for (let i = 0; i < N; i++) indices[i] = index.get(u32[i]);
  return { colourType: 3, bpp: 1, samples: indices, plte, trns, name: 'pal-' + order };
}

function channelSamples(rgba, ct) {
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : ct === 2 ? 3 : 4;
  if (ct === 6) return rgba;
  const out = new Uint8Array(N * ch);
  for (let i = 0, d = 0, s = 0; i < N; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) { out[s] = rgba[d]; out[s + 1] = rgba[d + 3]; }
    else { out[s] = rgba[d]; out[s + 1] = rgba[d + 1]; out[s + 2] = rgba[d + 2]; }
  }
  return out;
}

// All candidate forms for an image, cheapest-first by construction.
function formsOf(rgba, an) {
  const forms = [];
  if (an.colours !== null) {
    for (const o of ['count', 'lum', 'nn']) forms.push(paletteForm(rgba, an.colours, o));
    if (!an.grey) return forms; // palette dominates RGB for non-grey flat images
  }
  const key = an.opaque ? -1 : an.tkey;
  if (an.grey) {
    if (key !== -1) {
      forms.push({ colourType: 0, bpp: 1, samples: channelSamples(rgba, 0), plte: null, trns: Uint8Array.of(0, key), name: 'grey-key' });
    } else if (an.opaque) {
      forms.push({ colourType: 0, bpp: 1, samples: channelSamples(rgba, 0), plte: null, trns: null, name: 'grey' });
    } else {
      forms.push({ colourType: 4, bpp: 2, samples: channelSamples(rgba, 4), plte: null, trns: null, name: 'grey-alpha' });
    }
  } else {
    if (key !== -1) {
      forms.push({ colourType: 2, bpp: 3, samples: channelSamples(rgba, 2), plte: null, trns: Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff), name: 'rgb-key' });
    } else if (an.opaque) {
      forms.push({ colourType: 2, bpp: 3, samples: channelSamples(rgba, 2), plte: null, trns: null, name: 'rgb' });
    } else {
      forms.push({ colourType: 6, bpp: 4, samples: rgba, plte: null, trns: null, name: 'rgba' });
    }
  }
  return forms;
}

// ---------------------------------------------------------------- filters
// Filter a whole image by one strategy into `raw` (filter byte + row bytes).
// Strategies: fixed type 0..4, 'minsum' (least signed-sum per row), 'brute'
// (per row, the filter whose deflate of the row, with the previous 32 KiB of
// filtered data as dictionary, is smallest — the real cost, greedily).
function filterImage(samples, bpp, choice, raw) {
  const stride = W * bpp;
  const trial = [0, 1, 2, 3, 4].map(() => new Uint8Array(stride));
  for (let y = 0; y < H; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    let type = 0; let best = Infinity;
    if (choice === 'minsum') {
      for (let t = 0; t < 5; t++) {
        filterRow(t, cur, prev, bpp, trial[t]);
        const s = signedSum(trial[t]);
        if (s < best) { best = s; type = t; }
      }
    } else { // brute
      const before = raw.subarray(Math.max(0, at - 32768), at);
      const rowBuf = new Uint8Array(stride + 1);
      for (let t = 0; t < 5; t++) {
        filterRow(t, cur, prev, bpp, trial[t]);
        rowBuf[0] = t;
        rowBuf.set(trial[t], 1);
        const opts = before.length === 0
          ? { level: 4, memLevel: 9 }
          : { level: 4, memLevel: 9, dictionary: before };
        const cost = deflateSync(rowBuf, opts).length;
        if (cost < best) { best = cost; type = t; }
      }
    }
    raw[at] = type;
    raw.set(trial[type], at + 1);
  }
  return raw;
}
function chunkOverhead(form) {
  return (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);
}

// ---------------------------------------------------------------- DEFLATE
// My own encoder: optimal-parsing LZ77 (hash chains + shortest-path DP) with
// dynamic Huffman blocks, iterated so the Huffman lengths match the parse.
// Tables are the DEFLATE standard ones.
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const LEN_SYM = (() => {
  const t = new Uint8Array(259);
  for (let s = 0; s < 29; s++) {
    const end = s === 28 ? 258 : LEN_BASE[s + 1] - 1;
    for (let l = LEN_BASE[s]; l <= end; l++) t[l] = s;
  }
  return t;
})();
const LEN_SYM_EXTRA = (() => {
  const t = new Uint8Array(259);
  for (let s = 0; s < 29; s++) {
    const end = s === 28 ? 258 : LEN_BASE[s + 1] - 1;
    for (let l = LEN_BASE[s]; l <= end; l++) t[l] = LEN_EXTRA[s];
  }
  return t;
})();
const DIST_SYM = (() => {
  const t = new Uint8Array(32769);
  for (let s = 0; s < 30; s++) {
    const end = s === 29 ? 32768 : DIST_BASE[s + 1] - 1;
    for (let d = DIST_BASE[s]; d <= end; d++) t[d] = s;
  }
  return t;
})();
const DIST_SYM_EXTRA = (() => {
  const t = new Uint8Array(32769);
  for (let s = 0; s < 30; s++) {
    const end = s === 29 ? 32768 : DIST_BASE[s + 1] - 1;
    for (let d = DIST_BASE[s]; d <= end; d++) t[d] = DIST_EXTRA[s];
  }
  return t;
})();
const FIXED_LIT_LEN = (() => {
  const t = new Uint8Array(288);
  for (let i = 0; i < 144; i++) t[i] = 8;
  for (let i = 144; i < 256; i++) t[i] = 9;
  for (let i = 256; i < 280; i++) t[i] = 7;
  for (let i = 280; i < 288; i++) t[i] = 8;
  return t;
})();

// Huffman code lengths from frequencies, capped at maxBits (zlib-style
// overflow redistribution, deterministic: ties by symbol).
function huffmanLengths(freq, maxBits) {
  const n = freq.length;
  const len = new Uint8Array(n);
  const syms = [];
  for (let i = 0; i < n; i++) if (freq[i] > 0) syms.push(i);
  if (syms.length === 0) return len;
  if (syms.length === 1) {
    len[syms[0]] = 1;
    len[syms[0] === 0 ? 1 : 0] = 1;
    return len;
  }
  // Min-heap of tree nodes: [freq, id]; ties broken by id for determinism.
  const nf = []; const ns = []; const nl = []; const nr = [];
  const heap = [];
  const push = (id) => {
    heap.push(id);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (nf[heap[p]] < nf[heap[i]] || (nf[heap[p]] === nf[heap[i]] && heap[p] < heap[i])) break;
      const t = heap[p]; heap[p] = heap[i]; heap[i] = t; i = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < heap.length && (nf[heap[l]] < nf[heap[m]] || (nf[heap[l]] === nf[heap[m]] && heap[l] < heap[m]))) m = l;
        if (r < heap.length && (nf[heap[r]] < nf[heap[m]] || (nf[heap[r]] === nf[heap[m]] && heap[r] < heap[m]))) m = r;
        if (m === i) break;
        const t = heap[m]; heap[m] = heap[i]; heap[i] = t; i = m;
      }
    }
    return top;
  };
  for (const s of syms) { nf.push(freq[s]); ns.push(s); nl.push(-1); nr.push(-1); push(nf.length - 1); }
  while (heap.length > 1) {
    const a = pop(), b = pop();
    nf.push(nf[a] + nf[b]); ns.push(-1); nl.push(a); nr.push(b);
    push(nf.length - 1);
  }
  const root = heap[0];
  const depth = new Int16Array(nf.length);
  const stack = [root];
  depth[root] = 0;
  let maxDepth = 0;
  while (stack.length > 0) {
    const id = stack.pop();
    const d = depth[id];
    if (ns[id] >= 0) { len[ns[id]] = d; if (d > maxDepth) maxDepth = d; continue; }
    depth[nl[id]] = d + 1; depth[nr[id]] = d + 1;
    stack.push(nl[id]); stack.push(nr[id]);
  }
  if (maxDepth <= maxBits) return len;
  // Limit: count lengths, clamp the overflow down (zlib gen_bitlen method).
  const blCount = new Int32Array(maxBits + 1);
  let overflow = 0;
  for (const s of syms) {
    const d = len[s];
    if (d > maxBits) { blCount[maxBits]++; overflow++; }
    else blCount[d]++;
  }
  do {
    let m = maxBits - 1;
    while (blCount[m] === 0) m--;
    blCount[m]--; blCount[m + 1] += 2; blCount[maxBits]--; overflow -= 2;
  } while (overflow > 0);
  const ordered = [...syms].sort((a, b) => freq[b] - freq[a] || a - b);
  let k = 0;
  for (let d = 1; d <= maxBits; d++) {
    for (let j = 0; j < blCount[d]; j++) len[ordered[k++]] = d;
  }
  return len;
}
// Canonical Huffman codes from lengths: returns {codes, lens} with codes
// bit-reversed for LSB-first output.
function canonicalCodes(len) {
  const n = len.length;
  const blCount = new Int32Array(16);
  for (let i = 0; i < n; i++) blCount[len[i]]++;
  blCount[0] = 0;
  const next = new Int32Array(16);
  let code = 0;
  for (let b = 1; b < 16; b++) { code = (code + blCount[b - 1]) << 1; next[b] = code; }
  const codes = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const l = len[i];
    if (l === 0) continue;
    let c = next[l]++;
    // Reverse l bits.
    let r = 0;
    for (let k = 0; k < l; k++) { r = (r << 1) | (c & 1); c >>= 1; }
    codes[i] = r;
  }
  return codes;
}

class BitWriter {
  constructor(cap) { this.buf = new Uint8Array(cap); this.pos = 0; this.acc = 0; this.cnt = 0; }
  grow() {
    const nb = new Uint8Array(this.buf.length * 2);
    nb.set(this.buf.subarray(0, this.pos));
    this.buf = nb;
  }
  write(bits, n) {
    this.acc |= (bits & ((1 << n) - 1)) << this.cnt;
    this.cnt += n;
    while (this.cnt >= 8) {
      if (this.pos >= this.buf.length) this.grow();
      this.buf[this.pos++] = this.acc & 0xff;
      this.acc >>>= 8; this.cnt -= 8;
    }
  }
  // Write a Huffman code (already bit-reversed) of length n.
  code(c, n) { this.write(c, n); }
  align() {
    if (this.cnt > 0) {
      if (this.pos >= this.buf.length) this.grow();
      this.buf[this.pos++] = this.acc & 0xff;
      this.acc = 0; this.cnt = 0;
    }
  }
  bytes() { return this.buf.subarray(0, this.pos); }
}

function adler32(data) {
  let a = 1, b = 0;
  for (let i = 0; i < data.length;) {
    const end = Math.min(data.length, i + 5552);
    for (; i < end; i++) { a += data[i]; b += a; }
    a %= 65521; b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// --- LZ77 match finding (hash chains over the whole raw buffer) ---
// The match index is the 3-byte value itself (24 bits, 16.7M buckets): every
// chain entry is then a true 3-byte match, not a hash collision, so a walk
// spends its time on real candidates and finds the longest match quickly.
const HASH_BITS = 24;
const HASH_SIZE = 1 << HASH_BITS;
function hashAt(d, i) { return (d[i] << 16) | (d[i + 1] << 8) | d[i + 2]; }
function insertPos(d, i, head, prev) {
  if (i + 2 >= d.length) return;
  const h = hashAt(d, i);
  prev[i] = head[h];
  head[h] = i;
}
function matchLenAt(d, cand, i, from, maxLen) {
  let l = from;
  while (l < maxLen && d[cand + l] === d[i + l]) l++;
  return l;
}
// Walk the chain at i. Fills the scratch candidate lists (length >= 3) and
// returns the longest length found. Scratch arrays are reused: this runs
// once per input position, so it must not allocate.
const SCR_LENS = new Int32Array(128);
const SCR_DISTS = new Int32Array(128);
function findMatches(d, i, e, head, prev, chainCap) {
  let nc = 0;
  let best = 0;
  const maxLen = Math.min(258, e - i);
  let cand = head[hashAt(d, i)];
  let count = 0;
  while (cand !== -1 && count < chainCap) {
    const dist = i - cand;
    if (dist > 32768) break;
    count++;
    let len = 0;
    // Quick check: the first byte must match (the chain is by hash, so
    // collisions exist), and to beat the current best the byte at `best`
    // must match too. The length itself is then measured from 0 — the
    // prefix is only known to match once it has been compared.
    if (d[cand] === d[i]) {
      if (best === 0) {
        len = matchLenAt(d, cand, i, 0, maxLen);
      } else if (i + best < e && d[cand + best] === d[i + best]) {
        len = matchLenAt(d, cand, i, 0, maxLen);
      }
    }
    if (len >= 3) {
      if (nc < 128) { SCR_LENS[nc] = len; SCR_DISTS[nc] = dist; nc++; }
      if (len > best) best = len;
    }
    if (best >= 258) break;
    if (best >= 64 && count >= 8) break;
    if (best >= 32 && count >= 32) break;
    cand = prev[cand];
  }
  return { best, n: nc };
}

// One shortest-path parse of block [s, e) under the given per-symbol costs.
// Returns tokens (Int32Array: 0..255 literal, else 256+(len-3)*32768+(dist-1)),
// frequencies, and the data-bit estimate under those costs.
function parseOnce(d, s, e, litCost, lenCost, distCost, head, prev, chainCap) {
  const bl = e - s;
  const cost = new Float64Array(bl + 1);
  cost.fill(Infinity);
  cost[0] = 0;
  const pPrev = new Int32Array(bl + 1);
  const pLen = new Uint16Array(bl + 1);
  const pDist = new Int32Array(bl + 1);
  for (let i = s; i < e; i++) {
    const bi = i - s;
    const ci = cost[bi];
    if (ci !== Infinity) {
      const litC = ci + litCost[d[i]];
      if (litC < cost[bi + 1]) { cost[bi + 1] = litC; pPrev[bi + 1] = bi; pLen[bi + 1] = 1; }
      if (i + 3 <= e) {
        const m = findMatches(d, i, e, head, prev, chainCap);
        if (m.best >= 3) {
          // For each length-code boundary <= best, the cheapest distance
          // among candidates reaching that length; plus the longest length
          // itself when it is not a boundary (a run ending mid-symbol).
          let lastB = 0;
          for (let b = 0; b < LEN_BASE.length; b++) {
            const L = LEN_BASE[b];
            if (L > m.best) break;
            lastB = L;
            let bd = Infinity; let bdist = 0;
            for (let k = 0; k < m.n; k++) {
              if (SCR_LENS[k] >= L) {
                const dc = distCost[SCR_DISTS[k]];
                if (dc < bd) { bd = dc; bdist = SCR_DISTS[k]; }
              }
            }
            if (bd === Infinity) continue;
            const nc = ci + lenCost[L] + bd;
            if (nc < cost[bi + L]) { cost[bi + L] = nc; pPrev[bi + L] = bi; pLen[bi + L] = L; pDist[bi + L] = bdist; }
          }
          if (lastB !== m.best) {
            const L = m.best;
            let bd = Infinity; let bdist = 0;
            for (let k = 0; k < m.n; k++) {
              if (SCR_LENS[k] >= L) {
                const dc = distCost[SCR_DISTS[k]];
                if (dc < bd) { bd = dc; bdist = SCR_DISTS[k]; }
              }
            }
            if (bd !== Infinity) {
              const nc = ci + lenCost[L] + bd;
              if (nc < cost[bi + L]) { cost[bi + L] = nc; pPrev[bi + L] = bi; pLen[bi + L] = L; pDist[bi + L] = bdist; }
            }
          }
        }
      }
    }
    insertPos(d, i, head, prev);
  }
  // Backtrack.
  const toks = new Int32Array(bl);
  let nt = 0;
  const litFreq = new Uint32Array(288);
  const distFreq = new Uint32Array(30);
  let bi = bl;
  const rev = [];
  while (bi > 0) {
    const L = pLen[bi];
    const pv = pPrev[bi];
    if (L === 1) {
      const byte = d[s + pv];
      rev.push(byte);
      litFreq[byte]++;
    } else {
      const dist = pDist[bi];
      rev.push(256 + (L - 3) * 32768 + (dist - 1));
      litFreq[257 + LEN_SYM[L]]++;
      distFreq[DIST_SYM[dist]]++;
    }
    bi = pv;
  }
  for (let k = rev.length - 1; k >= 0; k--) toks[nt++] = rev[k];
  litFreq[256]++;
  return { toks: toks.subarray(0, nt), litFreq, distFreq, estBits: cost[bl] };
}

function costsFromLengths(litLen, distLen) {
  const litCost = new Float64Array(256);
  for (let i = 0; i < 256; i++) litCost[i] = litLen[i];
  const lenCost = new Float64Array(259);
  for (let L = 3; L <= 258; L++) lenCost[L] = litLen[257 + LEN_SYM[L]] + LEN_SYM_EXTRA[L];
  const distCost = new Float64Array(32769);
  for (let dd = 1; dd <= 32768; dd++) distCost[dd] = distLen[DIST_SYM[dd]] + DIST_SYM_EXTRA[dd];
  return { litCost, lenCost, distCost };
}
function fixedCosts() {
  const litCost = new Float64Array(256);
  for (let i = 0; i < 256; i++) litCost[i] = FIXED_LIT_LEN[i];
  const lenCost = new Float64Array(259);
  for (let L = 3; L <= 258; L++) lenCost[L] = FIXED_LIT_LEN[257 + LEN_SYM[L]] + LEN_SYM_EXTRA[L];
  const distCost = new Float64Array(32769);
  for (let dd = 1; dd <= 32768; dd++) distCost[dd] = 5 + DIST_SYM_EXTRA[dd];
  return { litCost, lenCost, distCost };
}

// Exact dynamic-header bit count for given lit/dist lengths (RLE over the
// combined lengths, code-length Huffman capped at 7 bits).
function dynamicHeaderBits(litLen, distLen) {
  let hlit = 286;
  while (hlit > 257 && litLen[hlit - 1] === 0) hlit--;
  let hdist = 30;
  while (hdist > 1 && distLen[hdist - 1] === 0) hdist--;
  const total = hlit + hdist;
  const lens = new Uint8Array(total);
  lens.set(litLen.subarray(0, hlit), 0);
  lens.set(distLen.subarray(0, hdist), hlit);
  const clFreq = new Uint32Array(19);
  // RLE, counting code-length symbols.
  let i = 0;
  while (i < total) {
    const v = lens[i];
    let run = 1;
    while (i + run < total && lens[i + run] === v) run++;
    if (v === 0) {
      let r = run;
      while (r >= 11) { const n = Math.min(r, 138); clFreq[18]++; r -= n; }
      if (r >= 3) { clFreq[17]++; r = 0; }
      while (r > 0) { clFreq[0]++; r--; }
    } else {
      clFreq[v]++;
      let r = run - 1;
      while (r >= 3) { const n = Math.min(r, 6); clFreq[16]++; r -= n; }
      while (r > 0) { clFreq[v]++; r--; }
    }
    i += run;
  }
  const clLen = huffmanLengths(clFreq, 7);
  const order = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
  let hclen = 19;
  while (hclen > 4 && clLen[order[hclen - 1]] === 0) hclen--;
  let bits = 5 + 5 + 4 + hclen * 3;
  for (let k = 0; k < hclen; k++) bits += 0; // lengths themselves are 3 bits each (counted above)
  // Data: the RLE symbols' code bits + extra bits.
  i = 0;
  while (i < total) {
    const v = lens[i];
    let run = 1;
    while (i + run < total && lens[i + run] === v) run++;
    if (v === 0) {
      let r = run;
      while (r >= 11) { const n = Math.min(r, 138); bits += clLen[18] + 7; r -= n; }
      if (r >= 3) { bits += clLen[17] + 3; r = 0; }
      bits += r * clLen[0];
    } else {
      bits += clLen[v];
      let r = run - 1;
      while (r >= 3) { const n = Math.min(r, 6); bits += clLen[16] + 2; r -= n; }
      bits += r * clLen[v];
    }
    i += run;
  }
  return { bits, hlit, hdist, hclen, clLen };
}

// ---------------------------------------------------------------- block write
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
function combinedLengths(litLen, distLen, hlit, hdist) {
  const total = hlit + hdist;
  const lens = new Uint8Array(total);
  lens.set(litLen.subarray(0, hlit), 0);
  lens.set(distLen.subarray(0, hdist), hlit);
  return lens;
}
function writeTokens(bw, toks, litCodes, litLen, distCodes, distLen) {
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t < 256) {
      bw.code(litCodes[t], litLen[t]);
    } else {
      const L = 3 + Math.floor((t - 256) / 32768);
      const dist = 1 + ((t - 256) % 32768);
      const ls = LEN_SYM[L];
      bw.code(litCodes[257 + ls], litLen[257 + ls]);
      if (LEN_EXTRA[ls] > 0) bw.write(L - LEN_BASE[ls], LEN_EXTRA[ls]);
      const ds = DIST_SYM[dist];
      bw.code(distCodes[ds], distLen[ds]);
      if (DIST_EXTRA[ds] > 0) bw.write(dist - DIST_BASE[ds], DIST_EXTRA[ds]);
    }
  }
  bw.code(litCodes[256], litLen[256]);
}
function writeBlock(bw, best, isLast) {
  bw.write(isLast ? 1 : 0, 1);
  if (best.useFixed) {
    bw.write(1, 2);
    const distLen = new Uint8Array(30).fill(5);
    writeTokens(bw, best.toks, canonicalCodes(FIXED_LIT_LEN), FIXED_LIT_LEN, canonicalCodes(distLen), distLen);
    return;
  }
  bw.write(2, 2);
  const { litLen, distLen, hdr } = best;
  const { hlit, hdist, hclen, clLen } = hdr;
  bw.write(hlit - 257, 5);
  bw.write(hdist - 1, 5);
  bw.write(hclen - 4, 4);
  for (let k = 0; k < hclen; k++) bw.write(clLen[CL_ORDER[k]], 3);
  const clCodes = canonicalCodes(clLen);
  const lens = combinedLengths(litLen, distLen, hlit, hdist);
  const total = lens.length;
  let i = 0;
  while (i < total) {
    const v = lens[i];
    let run = 1;
    while (i + run < total && lens[i + run] === v) run++;
    if (v === 0) {
      let r = run;
      while (r >= 11) { const n = Math.min(r, 138); bw.code(clCodes[18], clLen[18]); bw.write(n - 11, 7); r -= n; }
      if (r >= 3) { bw.code(clCodes[17], clLen[17]); bw.write(r - 3, 3); r = 0; }
      while (r > 0) { bw.code(clCodes[0], clLen[0]); r--; }
    } else {
      bw.code(clCodes[v], clLen[v]);
      let r = run - 1;
      while (r >= 3) { const n = Math.min(r, 6); bw.code(clCodes[16], clLen[16]); bw.write(n - 3, 2); r -= n; }
      while (r > 0) { bw.code(clCodes[v], clLen[v]); r--; }
    }
    i += run;
  }
  writeTokens(bw, best.toks, canonicalCodes(litLen), litLen, canonicalCodes(distLen), distLen);
}

// Score one parsed block under its rebuilt Huffman lengths: dynamic total
// (3 block bits + header + data) versus fixed-Huffman total; keep the
// smaller encoding.
function evaluateBlock(res, litLen, distLen) {
  let dataBits = litLen[256];
  for (let k = 0; k < res.toks.length; k++) {
    const t = res.toks[k];
    if (t < 256) dataBits += litLen[t];
    else {
      const L = 3 + Math.floor((t - 256) / 32768);
      const dist = 1 + ((t - 256) % 32768);
      dataBits += litLen[257 + LEN_SYM[L]] + LEN_SYM_EXTRA[L] + distLen[DIST_SYM[dist]] + DIST_SYM_EXTRA[dist];
    }
  }
  const hdr = dynamicHeaderBits(litLen, distLen);
  const dynTotal = 3 + hdr.bits + dataBits;
  let fixedBits = 3 + 7;
  for (let k = 0; k < res.toks.length; k++) {
    const t = res.toks[k];
    if (t < 256) fixedBits += FIXED_LIT_LEN[t];
    else {
      const L = 3 + Math.floor((t - 256) / 32768);
      const dist = 1 + ((t - 256) % 32768);
      fixedBits += FIXED_LIT_LEN[257 + LEN_SYM[L]] + LEN_SYM_EXTRA[L] + 5 + DIST_SYM_EXTRA[dist];
    }
  }
  return { toks: res.toks, litLen, distLen, hdr, total: Math.min(dynTotal, fixedBits), useFixed: fixedBits <= dynTotal };
}

const BLOCK_BYTES = 262144;
const CHAIN_CAP = 128;
const PARSE_PASSES = 2;

// Full zlib stream of `data` with the optimal-parsing encoder. The cost
// model is iterated whole-image at a time: each pass re-parses every block
// in order, so the match index evolves identically in every pass (positions
// are inserted in the same order) and no per-block snapshot is needed.
function deflateOptimal(data) {
  const n = data.length;
  const head = new Int32Array(HASH_SIZE).fill(-1);
  const prev = new Int32Array(n);
  const bounds = [];
  for (let s = 0; s < n; s += BLOCK_BYTES) bounds.push([s, Math.min(n, s + BLOCK_BYTES)]);
  const nb = bounds.length;
  const states = new Array(nb).fill(null);
  const fixed = fixedCosts();
  for (let p = 0; p < PARSE_PASSES; p++) {
    head.fill(-1);
    for (let b = 0; b < nb; b++) {
      const [s, e] = bounds[b];
      const costs = p === 0 ? fixed : costsFromLengths(states[b].litLen, states[b].distLen);
      const res = parseOnce(data, s, e, costs.litCost, costs.lenCost, costs.distCost, head, prev, CHAIN_CAP);
      const litLen = huffmanLengths(res.litFreq, 15);
      const distLen = huffmanLengths(res.distFreq, 15);
      const cand = evaluateBlock(res, litLen, distLen);
      if (states[b] === null || cand.total < states[b].total) states[b] = cand;
    }
  }
  const bw = new BitWriter(n + 65536);
  bw.write(0x78, 8);
  bw.write(0x9c, 8);
  for (let b = 0; b < nb; b++) writeBlock(bw, states[b], b === nb - 1);
  bw.align();
  const out = bw.bytes();
  const ad = adler32(data);
  const res = new Uint8Array(out.length + 4);
  res.set(out, 0);
  res[out.length] = (ad >>> 24) & 0xff;
  res[out.length + 1] = (ad >>> 16) & 0xff;
  res[out.length + 2] = (ad >>> 8) & 0xff;
  res[out.length + 3] = ad & 0xff;
  return res;
}

// ---------------------------------------------------------------- screening
const Z6 = { level: 6, memLevel: 8 };
const Z9 = { level: 9, memLevel: 9 };
function pngOfForm(form, idat) {
  const chunks = [['IHDR', ihdr(form.colourType)]];
  if (form.plte !== null) chunks.push(['PLTE', form.plte]);
  if (form.trns !== null) chunks.push(['tRNS', form.trns]);
  chunks.push(['IDAT', idat]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks.map(([t, d]) => chunk(t, d)));
}

function compressImage(rgba) {
  const an = analyse(rgba);
  const forms = formsOf(rgba, an);
  const screened = [];
  for (const form of forms) {
    const size = H * (W * form.bpp + 1);
    const raw = new Uint8Array(size);
    filterImage(form.samples, form.bpp, 'minsum', raw);
    screened.push({ form, strategy: 'minsum', raw, z: deflateSync(raw, Z6).length + chunkOverhead(form) });
  }
  screened.sort((a, b) => a.z - b.z);
  const best = screened[0];
  // Refine the winning form: brute-force per-row filters + fixed filters
  // (Avg and Up never won; they are skipped to save wall budget).
  const refined = [best];
  const size = H * (W * best.form.bpp + 1);
  for (const strat of ['brute', 0, 4, 1]) {
    const raw = new Uint8Array(size);
    filterImage(best.form.samples, best.form.bpp, strat, raw);
    refined.push({ form: best.form, strategy: String(strat), raw, z: deflateSync(raw, Z6).length + chunkOverhead(best.form) });
  }
  // If a second form is close, brute-force it too.
  if (screened.length > 1 && screened[1].z < best.z * 1.08) {
    const f2 = screened[1];
    const size2 = H * (W * f2.form.bpp + 1);
    const raw2 = new Uint8Array(size2);
    filterImage(f2.form.samples, f2.form.bpp, 'brute', raw2);
    refined.push({ form: f2.form, strategy: 'brute', raw: raw2, z: deflateSync(raw2, Z6).length + chunkOverhead(f2.form) });
  }
  refined.sort((a, b) => a.z - b.z);
  // Finalists: the best by zlib-6, plus the unfiltered and brute-force
  // variants (zlib-9 ranks them differently from zlib-6 — unfiltered wins
  // outright on several images — so they each get a zlib-9 shot, unless
  // their zlib-6 size is hopeless). The best candidate is also encoded
  // with my optimal-parsing deflate; the smaller stream wins.
  const top = refined[0];
  const finalists = new Map();
  finalists.set(top.form.name + '/' + top.strategy, top);
  for (const strat of ['0', 'brute']) {
    const r = refined.find((x) => x.strategy === strat && x.form === top.form);
    if (r && r.z < top.z * 1.25) finalists.set(r.form.name + '/' + r.strategy, r);
  }
  let bestOut = null;
  for (const r of finalists.values()) {
    const z9 = deflateSync(r.raw, Z9);
    const zb = z9.length + chunkOverhead(r.form) + 57;
    if (bestOut === null || zb < bestOut.bytes) {
      bestOut = { png: pngOfForm(r.form, z9), bytes: zb, form: r.form.name, strategy: r.strategy, encoder: 'zlib9' };
    }
    if (r === top) {
      const mine = deflateOptimal(r.raw);
      const mb = mine.length + chunkOverhead(r.form) + 57;
      if (mb < bestOut.bytes) {
        bestOut = { png: pngOfForm(r.form, mine), bytes: mb, form: r.form.name, strategy: r.strategy, encoder: 'optimal' };
      }
    }
  }
  return bestOut;
}

// ---------------------------------------------------------------- driver
const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(I).sort()) {
  const rgba = decodePng(new Uint8Array(readFileSync(join(I, id, 'image.png'))));
  const out = compressImage(rgba);
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'image.png'), out.png);
}
