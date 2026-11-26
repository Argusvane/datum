#!/usr/bin/env node
// Generates the ECMAScript number-formatting oracle every server host's canonical-JSON writer is tested against
// (RFC 8785 section 3.2.2.3). Node's own JSON.stringify is the oracle: V8 implements Number::toString exactly,
// so the fixture is a list of [bits as 16 hex digits, expected text] that a host's formatter must reproduce. The generator
// is deterministic (a fixed xorshift seed), so a re-run yields the same file; the output is a shared test fixture.
//
// Usage: node integrations/shared/scripts/number-oracle.mjs [--random=N] [--out=<path>]
//   default --out: integrations/shared/fixtures/number-oracle.json.gz
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const outArg = process.argv.find((a) => a.startsWith('--out='));
const out = outArg ? resolve(process.cwd(), outArg.slice(6)) : resolve(here, '../fixtures/number-oracle.json.gz');
const randomArg = process.argv.find((a) => a.startsWith('--random='));
const RANDOM = randomArg ? Number(randomArg.slice(9)) : 160000;

const view = new DataView(new ArrayBuffer(8));
const bitsOf = (d) => { view.setFloat64(0, d); return view.getBigUint64(0); };
const fromBits = (b) => { view.setBigUint64(0, b); return view.getFloat64(0); };

const seen = new Map();
function add(d) {
  if (!Number.isFinite(d)) return;
  const bits = bitsOf(d);
  if (seen.has(bits)) return;
  // JSON.stringify writes -0 as 0, which is the contract here (a host maps both zeros to "0").
  seen.set(bits, JSON.stringify(d));
}
function around(d) {
  add(d);
  const b = bitsOf(d);
  for (const delta of [1n, 2n, -1n, -2n]) {
    const n = b + delta;
    if (n >= 0n && n < 0x7ff0000000000000n) { add(fromBits(n)); add(-fromBits(n)); }
  }
  add(-d);
}

// Every power of two with its neighbours, then every power of ten (the layout thresholds live there).
for (let e = -1074; e <= 1023; e++) around(2 ** e === 0 ? Number.MIN_VALUE : Math.pow(2, e));
around(Number.MIN_VALUE);
for (let e = -324; e <= 308; e++) around(Number(`1e${e}`));
// Subnormals and the edges of the normal range.
for (let i = 1n; i <= 2000n; i++) add(fromBits(i));
for (let i = 0n; i < 2000n; i++) { add(fromBits(0x000fffffffffffffn - i)); add(fromBits(0x0010000000000000n + i)); }
around(Number.MAX_VALUE);
// Integers up to 2^53 and just above.
for (let i = 0; i <= 3000; i++) { add(i); add(-i); add(2 ** 53 - i); add(2 ** 53 + i * 2); add(2 ** 31 + i); add(2 ** 32 - i); }
for (let e = 0; e <= 70; e++) { around(10 ** e); around(3 * 10 ** e); around(99 * 10 ** e / 100); }
// Decimal-looking values and the layout thresholds.
for (const t of ['0.1', '0.2', '0.3', '0.7', '1e21', '1e-7', '1e-6', '9.999999999999999e20', '9.999999999999998e20', '999999999999999900000',
  '123456789012345680000', '5e-324', '1.7976931348623157e308', '4.9406564584124654e-324', '0.000001', '0.0000001', '1e22', '1e23',
  '9.5367431640625e-7', '5.960464477539063e-8', '2.2250738585072014e-308', '2.225073858507201e-308', '1.2345678901234567e-5',
  '8.41e21', '2.5e-5', '100', '1e100', '12345.6789', '0.30000000000000004', '9007199254740993', '18014398509481985']) {
  around(Number(t));
}
for (let i = 1; i <= 2000; i++) { add(i / 10); add(i / 100); add(i / 1000); add(i * 0.1); add(i / 7); add(1 / i); add(Math.sqrt(i)); add(i * 1e-7); add(i * 1e19); }
// The values in the engine's JCS vectors (the RFC 8785 appendix B list is among them).
const vectors = JSON.parse(readFileSync(resolve(repo, 'engine/tests/fixtures/jcs-vectors.json'), 'utf8'));
const walk = (v) => { if (typeof v === 'number') around(v); else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
for (const c of vectors) { try { walk(JSON.parse(c.input)); } catch { /* not every input is a number list */ } }
// Random bit patterns across every exponent (NaN and Infinity skipped), from a fixed xorshift64 seed.
let s = 0x9e3779b97f4a7c15n;
const next = () => { s ^= (s << 13n) & 0xffffffffffffffffn; s ^= s >> 7n; s ^= (s << 17n) & 0xffffffffffffffffn; return s; };
for (let i = 0; i < RANDOM; i++) add(fromBits(next()));
// Random doubles in friendly ranges: the shortest digits are short there, which is where rounding ties live.
for (let i = 0; i < RANDOM / 4; i++) { add(Number((Number(next() % 100000000n) / 1e4).toFixed(4))); add(Number(next() % 10000000n) / 1e9); add(Number(next() % 100000n) * 1e17); }

const rows = [...seen].map(([bits, text]) => [bits.toString(16).padStart(16, '0'), text]);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, gzipSync(Buffer.from(JSON.stringify(rows)), { level: 9 }));
console.log(`${rows.length} cases -> ${out}`);
