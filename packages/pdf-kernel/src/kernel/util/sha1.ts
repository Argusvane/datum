/**
 * SHA-1 (FIPS 180-4) in plain TypeScript, for the one place a timestamp token still names it
 *: an RFC 3161 token's `signingCertificate` attribute, whose ESSCertID hashes the
 * TSA's certificate with SHA-1 (RFC 2634). It identifies a certificate the token carries; it
 * is never used to sign anything.
 */
export function sha1(data: Uint8Array): Uint8Array {
  // The message, a 1 bit, zeros, and the length in bits as a 64-bit big-endian number.
  const total = Math.ceil((data.length + 9) / 64) * 64;
  const block = new Uint8Array(total);
  block.set(data);
  block[data.length] = 0x80;
  const view = new DataView(block.buffer);
  const bits = data.length * 8;
  view.setUint32(total - 8, Math.floor(bits / 0x100000000));
  view.setUint32(total - 4, bits >>> 0);
  const h = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]);
  const w = new Uint32Array(80);
  for (let offset = 0; offset < total; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = view.getUint32(offset + i * 4);
    }
    for (let i = 16; i < 80; i += 1) {
      const x = w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!;
      w[i] = (x << 1) | (x >>> 31);
    }
    let a = h[0]!;
    let b = h[1]!;
    let c = h[2]!;
    let d = h[3]!;
    let e = h[4]!;
    for (let i = 0; i < 80; i += 1) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const next = (((a << 5) | (a >>> 27)) + f + e + k + w[i]!) >>> 0;
      e = d;
      d = c;
      c = ((b << 30) | (b >>> 2)) >>> 0;
      b = a;
      a = next;
    }
    h[0] = h[0]! + a;
    h[1] = h[1]! + b;
    h[2] = h[2]! + c;
    h[3] = h[3]! + d;
    h[4] = h[4]! + e;
  }
  const out = new Uint8Array(20);
  const outView = new DataView(out.buffer);
  for (let j = 0; j < 5; j += 1) {
    outView.setUint32(j * 4, h[j]!);
  }
  return out;
}
