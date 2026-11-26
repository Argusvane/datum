/**
 * SHA-512 and SHA-384 (FIPS 180-4) in plain TypeScript, for the digests a timestamp token may
 * name: the SignerInfo digest over the TSTInfo, an ESSCertIDv2 hash, an imprint.
 * The sandbox has no `crypto` and no fast 64-bit integers, so each word is a high and a low
 * 32-bit half. One call hashes one buffer; the inputs here are a few kilobytes at most.
 */

/** The 80 round constants, each as its high then its low half. */
const K = new Uint32Array([
  0x428a2f98, 0xd728ae22, 0x71374491, 0x23ef65cd, 0xb5c0fbcf, 0xec4d3b2f, 0xe9b5dba5, 0x8189dbbc,
  0x3956c25b, 0xf348b538, 0x59f111f1, 0xb605d019, 0x923f82a4, 0xaf194f9b, 0xab1c5ed5, 0xda6d8118,
  0xd807aa98, 0xa3030242, 0x12835b01, 0x45706fbe, 0x243185be, 0x4ee4b28c, 0x550c7dc3, 0xd5ffb4e2,
  0x72be5d74, 0xf27b896f, 0x80deb1fe, 0x3b1696b1, 0x9bdc06a7, 0x25c71235, 0xc19bf174, 0xcf692694,
  0xe49b69c1, 0x9ef14ad2, 0xefbe4786, 0x384f25e3, 0x0fc19dc6, 0x8b8cd5b5, 0x240ca1cc, 0x77ac9c65,
  0x2de92c6f, 0x592b0275, 0x4a7484aa, 0x6ea6e483, 0x5cb0a9dc, 0xbd41fbd4, 0x76f988da, 0x831153b5,
  0x983e5152, 0xee66dfab, 0xa831c66d, 0x2db43210, 0xb00327c8, 0x98fb213f, 0xbf597fc7, 0xbeef0ee4,
  0xc6e00bf3, 0x3da88fc2, 0xd5a79147, 0x930aa725, 0x06ca6351, 0xe003826f, 0x14292967, 0x0a0e6e70,
  0x27b70a85, 0x46d22ffc, 0x2e1b2138, 0x5c26c926, 0x4d2c6dfc, 0x5ac42aed, 0x53380d13, 0x9d95b3df,
  0x650a7354, 0x8baf63de, 0x766a0abb, 0x3c77b2a8, 0x81c2c92e, 0x47edaee6, 0x92722c85, 0x1482353b,
  0xa2bfe8a1, 0x4cf10364, 0xa81a664b, 0xbc423001, 0xc24b8b70, 0xd0f89791, 0xc76c51a3, 0x0654be30,
  0xd192e819, 0xd6ef5218, 0xd6990624, 0x5565a910, 0xf40e3585, 0x5771202a, 0x106aa070, 0x32bbd1b8,
  0x19a4c116, 0xb8d2d0c8, 0x1e376c08, 0x5141ab53, 0x2748774c, 0xdf8eeb99, 0x34b0bcb5, 0xe19b48a8,
  0x391c0cb3, 0xc5c95a63, 0x4ed8aa4a, 0xe3418acb, 0x5b9cca4f, 0x7763e373, 0x682e6ff3, 0xd6b2b8a3,
  0x748f82ee, 0x5defb2fc, 0x78a5636f, 0x43172f60, 0x84c87814, 0xa1f0ab72, 0x8cc70208, 0x1a6439ec,
  0x90befffa, 0x23631e28, 0xa4506ceb, 0xde82bde9, 0xbef9a3f7, 0xb2c67915, 0xc67178f2, 0xe372532b,
  0xca273ece, 0xea26619c, 0xd186b8c7, 0x21c0c207, 0xeada7dd6, 0xcde0eb1e, 0xf57d4f7f, 0xee6ed178,
  0x06f067aa, 0x72176fba, 0x0a637dc5, 0xa2c898a6, 0x113f9804, 0xbef90dae, 0x1b710b35, 0x131c471b,
  0x28db77f5, 0x23047d84, 0x32caab7b, 0x40c72493, 0x3c9ebe0a, 0x15c9bebc, 0x431d67c4, 0x9c100d4c,
  0x4cc5d4be, 0xcb3e42b6, 0x597f299c, 0xfc657e2a, 0x5fcb6fab, 0x3ad6faec, 0x6c44198c, 0x4a475817
]);

const SHA512_INIT = [
  0x6a09e667, 0xf3bcc908, 0xbb67ae85, 0x84caa73b, 0x3c6ef372, 0xfe94f82b, 0xa54ff53a, 0x5f1d36f1,
  0x510e527f, 0xade682d1, 0x9b05688c, 0x2b3e6c1f, 0x1f83d9ab, 0xfb41bd6b, 0x5be0cd19, 0x137e2179
];

const SHA384_INIT = [
  0xcbbb9d5d, 0xc1059ed8, 0x629a292a, 0x367cd507, 0x9159015a, 0x3070dd17, 0x152fecd8, 0xf70e5939,
  0x67332667, 0xffc00b31, 0x8eb44a87, 0x68581511, 0xdb0c2e0d, 0x64f98fa7, 0x47b5481d, 0xbefa4fa4
];

const TWO_32 = 0x100000000;

/** The high half of a 64-bit rotation right by `n` (never 32). */
function rotrHi(hi: number, lo: number, n: number): number {
  return n < 32 ? (hi >>> n) | (lo << (32 - n)) : (lo >>> (n - 32)) | (hi << (64 - n));
}

/** The low half of a 64-bit rotation right by `n` (never 32). */
function rotrLo(hi: number, lo: number, n: number): number {
  return n < 32 ? (lo >>> n) | (hi << (32 - n)) : (hi >>> (n - 32)) | (lo << (64 - n));
}

function sha512Family(data: Uint8Array, init: readonly number[], outBytes: number): Uint8Array {
  const h = new Uint32Array(init);
  const w = new Uint32Array(160);
  // The message, a 1 bit, zeros, and the length in bits as a 128-bit big-endian number.
  const total = Math.ceil((data.length + 17) / 128) * 128;
  const block = new Uint8Array(total);
  block.set(data);
  block[data.length] = 0x80;
  const view = new DataView(block.buffer);
  const bits = data.length * 8;
  view.setUint32(total - 8, Math.floor(bits / TWO_32));
  view.setUint32(total - 4, bits >>> 0);
  for (let offset = 0; offset < total; offset += 128) {
    for (let i = 0; i < 32; i += 1) {
      w[i] = view.getUint32(offset + i * 4);
    }
    for (let i = 16; i < 80; i += 1) {
      const xh = w[(i - 15) * 2]!;
      const xl = w[(i - 15) * 2 + 1]!;
      const yh = w[(i - 2) * 2]!;
      const yl = w[(i - 2) * 2 + 1]!;
      // sigma0 = rotr 1 ^ rotr 8 ^ shr 7; sigma1 = rotr 19 ^ rotr 61 ^ shr 6.
      const s0h = rotrHi(xh, xl, 1) ^ rotrHi(xh, xl, 8) ^ (xh >>> 7);
      const s0l = rotrLo(xh, xl, 1) ^ rotrLo(xh, xl, 8) ^ ((xl >>> 7) | (xh << 25));
      const s1h = rotrHi(yh, yl, 19) ^ rotrHi(yh, yl, 61) ^ (yh >>> 6);
      const s1l = rotrLo(yh, yl, 19) ^ rotrLo(yh, yl, 61) ^ ((yl >>> 6) | (yh << 26));
      const lo = (s0l >>> 0) + (s1l >>> 0) + w[(i - 16) * 2 + 1]! + w[(i - 7) * 2 + 1]!;
      w[i * 2] = (s0h >>> 0) + (s1h >>> 0) + w[(i - 16) * 2]! + w[(i - 7) * 2]! + Math.floor(lo / TWO_32);
      w[i * 2 + 1] = lo;
    }
    let aH = h[0]!;
    let aL = h[1]!;
    let bH = h[2]!;
    let bL = h[3]!;
    let cH = h[4]!;
    let cL = h[5]!;
    let dH = h[6]!;
    let dL = h[7]!;
    let eH = h[8]!;
    let eL = h[9]!;
    let fH = h[10]!;
    let fL = h[11]!;
    let gH = h[12]!;
    let gL = h[13]!;
    let hH = h[14]!;
    let hL = h[15]!;
    for (let i = 0; i < 80; i += 1) {
      // Sigma1 = rotr 14 ^ rotr 18 ^ rotr 41; Sigma0 = rotr 28 ^ rotr 34 ^ rotr 39.
      const sigma1H = rotrHi(eH, eL, 14) ^ rotrHi(eH, eL, 18) ^ rotrHi(eH, eL, 41);
      const sigma1L = rotrLo(eH, eL, 14) ^ rotrLo(eH, eL, 18) ^ rotrLo(eH, eL, 41);
      const chooseH = (eH & fH) ^ (~eH & gH);
      const chooseL = (eL & fL) ^ (~eL & gL);
      const t1Sum = hL + (sigma1L >>> 0) + (chooseL >>> 0) + K[i * 2 + 1]! + w[i * 2 + 1]!;
      const t1H = (hH + (sigma1H >>> 0) + (chooseH >>> 0) + K[i * 2]! + w[i * 2]! + Math.floor(t1Sum / TWO_32)) >>> 0;
      const t1L = t1Sum >>> 0;
      const sigma0H = rotrHi(aH, aL, 28) ^ rotrHi(aH, aL, 34) ^ rotrHi(aH, aL, 39);
      const sigma0L = rotrLo(aH, aL, 28) ^ rotrLo(aH, aL, 34) ^ rotrLo(aH, aL, 39);
      const majorityH = (aH & bH) ^ (aH & cH) ^ (bH & cH);
      const majorityL = (aL & bL) ^ (aL & cL) ^ (bL & cL);
      const t2Sum = (sigma0L >>> 0) + (majorityL >>> 0);
      const t2H = ((sigma0H >>> 0) + (majorityH >>> 0) + Math.floor(t2Sum / TWO_32)) >>> 0;
      const t2L = t2Sum >>> 0;
      hH = gH;
      hL = gL;
      gH = fH;
      gL = fL;
      fH = eH;
      fL = eL;
      const eSum = dL + t1L;
      eH = (dH + t1H + Math.floor(eSum / TWO_32)) >>> 0;
      eL = eSum >>> 0;
      dH = cH;
      dL = cL;
      cH = bH;
      cL = bL;
      bH = aH;
      bL = aL;
      const aSum = t1L + t2L;
      aH = (t1H + t2H + Math.floor(aSum / TWO_32)) >>> 0;
      aL = aSum >>> 0;
    }
    const words = [aH, aL, bH, bL, cH, cL, dH, dL, eH, eL, fH, fL, gH, gL, hH, hL];
    for (let j = 0; j < 16; j += 2) {
      const lo = h[j + 1]! + words[j + 1]!;
      h[j] = h[j]! + words[j]! + Math.floor(lo / TWO_32);
      h[j + 1] = lo;
    }
  }
  const out = new Uint8Array(64);
  const outView = new DataView(out.buffer);
  for (let j = 0; j < 16; j += 1) {
    outView.setUint32(j * 4, h[j]!);
  }
  return out.slice(0, outBytes);
}

export function sha512(data: Uint8Array): Uint8Array {
  return sha512Family(data, SHA512_INIT, 64);
}

export function sha384(data: Uint8Array): Uint8Array {
  return sha512Family(data, SHA384_INIT, 48);
}
