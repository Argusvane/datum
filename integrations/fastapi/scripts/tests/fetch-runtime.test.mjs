// Unit checks for the runtime pin and its verification. Run: node --test integrations/fastapi/scripts/tests
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { OFFICIAL_RELEASE_PREFIX, PIN_PATH, fetchRuntime, loadPin, verifyRuntimeBytes } from "../fetch-runtime.mjs";

// The digest quickjs-ng publishes for v0.16.2's qjs-wasi.wasm; the pin must carry exactly it.
const QJS_SHA256 = "d2939e98c808e8b9f4164cd0d7b0398cbc0121ddf52862bcd92157d923e461cc";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("the pin names the official release and the published digest", () => {
  const pin = loadPin(PIN_PATH);
  assert.equal(pin.sha256, QJS_SHA256);
  assert.equal(pin.size, 1566956);
  assert.ok(pin.url.startsWith(OFFICIAL_RELEASE_PREFIX), pin.url);
  assert.equal(pin.asset, "qjs-wasi.wasm");
});

test("verifyRuntimeBytes accepts the pinned bytes and refuses a wrong size or hash", () => {
  const bytes = Buffer.from("not the real wasm");
  const pin = { sha256: sha(bytes), size: bytes.length };
  assert.doesNotThrow(() => verifyRuntimeBytes(bytes, pin));
  assert.throws(() => verifyRuntimeBytes(Buffer.concat([bytes, Buffer.from("x")]), pin), /size/);
  assert.throws(() => verifyRuntimeBytes(Buffer.from("not the real wasn"), pin), /sha256/);
});

test("a file given by --qjs-wasm-file is held to the pin and never written when it differs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fetch-runtime-"));
  try {
    const bytes = Buffer.from("tampered");
    const source = join(dir, "in.wasm");
    const out = join(dir, "out", "qjs-wasi.wasm");
    writeFileSync(source, bytes);
    await assert.rejects(fetchRuntime({ pin: { ...loadPin(PIN_PATH) }, out, file: source }), /size|sha256/);
    assert.equal(existsSync(out), false);
    const good = { asset: "qjs-wasi.wasm", url: `${OFFICIAL_RELEASE_PREFIX}v0/qjs-wasi.wasm`, sha256: sha(bytes), size: bytes.length };
    await fetchRuntime({ pin: good, out, file: source });
    assert.deepEqual(readFileSync(out), bytes);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a pin that points outside the official quickjs-ng release is refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fetch-runtime-"));
  try {
    const pin = { asset: "qjs-wasi.wasm", url: "https://example.org/qjs-wasi.wasm", sha256: QJS_SHA256, size: 1566956 };
    await assert.rejects(fetchRuntime({ pin, out: join(dir, "x.wasm") }), /official/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a damaged file at out is replaced from the network and a valid one is reused without it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fetch-runtime-"));
  const realFetch = globalThis.fetch;
  try {
    const good = Buffer.from("the pinned bytes");
    const pin = { asset: "qjs-wasi.wasm", url: `${OFFICIAL_RELEASE_PREFIX}v0/qjs-wasi.wasm`, sha256: sha(good), size: good.length };
    const out = join(dir, "qjs-wasi.wasm");
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return { ok: true, status: 200, arrayBuffer: async () => good.buffer.slice(good.byteOffset, good.byteOffset + good.length) };
    };
    writeFileSync(out, Buffer.from("damaged copy!!!!!"));
    await fetchRuntime({ pin, out });
    assert.equal(calls, 1);
    assert.deepEqual(readFileSync(out), good);
    await fetchRuntime({ pin, out });
    assert.equal(calls, 1, "a valid copy at out is reused without the network");
  } finally {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the network fetch carries an abort signal and a stalled download ends with a named timeout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fetch-runtime-"));
  const realFetch = globalThis.fetch;
  let seen;
  // AbortSignal.timeout's timer does not keep the event loop alive, and the stubbed fetch holds no socket,
  // so without this ref'd interval Node 22's test runner cancels the test before the timeout fires.
  const keepAlive = setInterval(() => {}, 1000);
  globalThis.fetch = (_url, init) => {
    seen = init?.signal;
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal.reason));
    });
  };
  try {
    const pin = { asset: "qjs-wasi.wasm", url: `${OFFICIAL_RELEASE_PREFIX}v0/qjs-wasi.wasm`, sha256: sha(Buffer.from("x")), size: 1 };
    await assert.rejects(fetchRuntime({ pin, out: join(dir, "qjs-wasi.wasm"), timeoutMs: 50 }), /timed out after 50 ms/);
    assert.ok(seen instanceof AbortSignal);
    assert.equal(existsSync(join(dir, "qjs-wasi.wasm")), false);
  } finally {
    clearInterval(keepAlive);
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});
