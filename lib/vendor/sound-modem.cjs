//---------------------------------------------------------------------
//
// Sound modem — data-over-speaker/microphone FSK for the light/sound
// peer transport. Pure DSP, no dependencies, no I/O: it turns a byte
// stream into Float32 samples and back, so the same file powers the
// browser (WebAudio speaker + analyser/mic) and the Node test suite
// (synthesized buffers echo).
//
// The line idles on a mark tone. A burst is: mark preamble, then the
// binary stream of [magic CAPX | uint16 length | payload | crc32].
// The receiver cameras an unknown mic delay, so it integrates energy
// in 100-sample blocks and slides the 4 possible symbol phases past
// the stream, keeping whichever phase validates the CRC. Symbols that
// copy a 0 look like silence are avoided: each byte is 8 FSK bits
// (mark 18.5 kHz = 1, space 16.5 kHz = 0) emitted LSB-first.
//
// Licensed under the MIT license: http://www.opensource.org/licenses/mit-license.php
//
//---------------------------------------------------------------------

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SoundModem = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SAMPLE_RATE = 48000;
  const F_SPACE = 16500;
  const F_MARK = 18500;
  const SYMBOL_SAMPLES = 400;
  const BLOCK = 100;
  const PREAMBLE_SYMBOLS = 24;
  const MAGIC = [0x43, 0x41, 0x50, 0x58];
  const MAX_PAYLOAD = 2300;

  const L0 = 32;
  const L1 = 96;
  let tableRe = null;
  let tableIm = null;

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function tables() {
    if (tableRe && tableIm) return { tableRe, tableIm };
    const len = Math.max(L0, L1);
    tableRe = new Float64Array(len);
    tableIm = new Float64Array(len);
    for (let k = 0; k < len; k += 1) {
      const p0 = (2 * Math.PI * F_SPACE * k) / SAMPLE_RATE;
      const p1 = (2 * Math.PI * F_MARK * k) / SAMPLE_RATE;
      if (k < L0) {
        tableRe[k] += Math.cos(p0);
        tableIm[k] += -Math.sin(p0);
      }
      if (k < L1) {
        tableRe[k] += Math.cos(p1);
        tableIm[k] += -Math.sin(p1);
      }
    }
    return { tableRe, tableIm };
  }

  function blockEnergies(samples) {
    const { tableRe, tableIm } = tables();
    const nb = Math.floor(samples.length / BLOCK);
    const E0 = new Float64Array(nb);
    const E1 = new Float64Array(nb);
    for (let b = 0; b < nb; b += 1) {
      const base = b * BLOCK;
      let re0 = 0, im0 = 0, re1 = 0, im1 = 0;
      for (let k = 0; k < BLOCK; k += 1) {
        const s = samples[base + k] || 0;
        const i0 = (base + k) % L0;
        const i1 = (base + k) % L1;
        re0 += s * tableRe[i0];
        im0 += s * tableIm[i0];
        re1 += s * tableRe[i1];
        im1 += s * tableIm[i1];
      }
      E0[b] = re0 * re0 + im0 * im0;
      E1[b] = re1 * re1 + im1 * im1;
    }
    return { E0, E1, nb };
  }

  function pack8(bits, ofs) {
    let v = 0;
    for (let b = 0; b < 8; b += 1) if (bits[ofs + b]) v |= 1 << b;
    return v;
  }

  function readPacket(bits, bitOfs, limit) {
    for (let m = 0; m < 4; m += 1) {
      if (pack8(bits, bitOfs + m * 8) !== MAGIC[m]) return null;
    }
    if (bitOfs + 48 > limit) return null;
    const len = pack8(bits, bitOfs + 32) << 8 | pack8(bits, bitOfs + 40);
    if (len < 1 || len > MAX_PAYLOAD) return null;
    const end = bitOfs + 48 + len * 8;
    if (end + 32 > limit) return null;
    const payload = new Uint8Array(len);
    for (let i = 0; i < len; i += 1) payload[i] = pack8(bits, bitOfs + 48 + i * 8);
    let crc = pack8(bits, end);
    for (let i = 1; i < 4; i += 1) crc = (crc << 8) | pack8(bits, end + i * 8);
    if (crc32(payload) !== (crc >>> 0)) return null;
    return { payload, bits: 48 + len * 8 + 32 };
  }

  function scanPhase(bits, totalBits) {
    const out = [];
    let bitOfs = 0;
    while (bitOfs + 48 <= totalBits) {
      const hit = readPacket(bits, bitOfs, totalBits);
      if (!hit) { bitOfs += 1; continue; }
      out.push(hit.payload);
      bitOfs += hit.bits;
    }
    return out;
  }

  function decodeAll(samples, opts) {
    if (!samples || !samples.length) return [];
    opts = opts || {};
    let buf = samples;
    const rate = opts.sampleRate || SAMPLE_RATE;
    if (rate !== SAMPLE_RATE) {
      const step = SAMPLE_RATE / rate;
      const out = new Float32Array(Math.floor(samples.length * step));
      for (let i = 0; i < out.length; i += 1) {
        const f = i / step;
        const lo = Math.floor(f);
        const hi = Math.min(lo + 1, samples.length - 1);
        out[i] = samples[lo] + (samples[hi] - samples[lo]) * (f - lo);
      }
      buf = out;
    }
    const { E0, E1, nb } = blockEnergies(buf);
    const seen = new Set();
    const all = [];
    const maxSym = nb / 4;
    for (let p = 0; p < 4; p += 1) {
      const bits = new Uint8Array(maxSym);
      for (let k = 0; k < maxSym; k += 1) {
        const b = p + k * 4;
        if (b + 3 >= nb) break;
        let s0 = 0;
        let s1 = 0;
        for (let j = 0; j < 4; j += 1) { s0 += E0[b + j]; s1 += E1[b + j]; }
        bits[k] = s1 >= s0 ? 1 : 0;
      }
      for (const payload of scanPhase(bits, bits.length)) {
        const key = crc32(payload) + ':' + payload.length;
        if (seen.has(key)) continue;
        seen.add(key);
        all.push(payload);
      }
    }
    return all;
  }

  function decode(samples, opts) {
    const all = decodeAll(samples, opts);
    return all.length ? all[0] : null;
  }

  function encode(bytes, opts) {
    opts = opts || {};
    const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
    const total = (PREAMBLE_SYMBOLS + 6 + data.length + 4) * 8;
    const out = new Float32Array(total * SYMBOL_SAMPLES);
    const amp = Number(opts.volume) || 0.5;
    let phase = 0;
    let symbol = 0;
    const emit = (value) => {
      const freq = value ? F_MARK : F_SPACE;
      const inc = (2 * Math.PI * freq) / SAMPLE_RATE;
      const start = symbol * SYMBOL_SAMPLES;
      for (let k = 0; k < SYMBOL_SAMPLES; k += 1) {
        out[start + k] = amp * Math.sin(phase);
        phase += inc;
        if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
      }
      symbol += 1;
    };
    for (let p = 0; p < PREAMBLE_SYMBOLS; p += 1) emit(1);
    const crc = crc32(data);
    const head = [MAGIC[0], MAGIC[1], MAGIC[2], MAGIC[3], (data.length >> 8) & 0xff, data.length & 0xff];
    const trailer = [(crc >>> 24) & 0xff, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff];
    for (const byte of [...head, ...data, ...trailer]) {
      for (let b = 0; b < 8; b += 1) emit((byte >> b) & 1);
    }
    return out;
  }

  function decoderText(bytes) {
    try { return new TextDecoder().decode(bytes); } catch (e) {
      return String.fromCharCode.apply(null, bytes);
    }
  }

  return {
    encode,
    decode,
    decodeAll,
    decoderText,
    crc32,
    SAMPLE_RATE,
    F_SPACE,
    F_MARK,
    SYMBOL_SAMPLES,
  };
});