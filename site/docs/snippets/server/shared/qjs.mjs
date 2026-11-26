// qjs.mjs — one run of the engine, in a process of its own: qjs-wasi.wasm, QuickJS-ng's own
// WebAssembly build from its release page, on V8, with node:wasi for its system interface — nothing
// to install beside Node 22. The endpoint (main.mjs) starts one of these per request:
//   node --wasm-max-mem-pages=<pages> --disable-warning=ExperimentalWarning qjs.mjs <qjs arguments>
// The request comes in on stdin and the answer goes out on stdout; the directory the process was
// started in is mounted as /app, all the run can reach. The flag is the memory the module may grow
// to, per process. The warning silenced is node:wasi's own, that it is still marked experimental,
// so that stderr is the run's alone.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { WASI } from "node:wasi";

// The file is checked before it is compiled: only the release this server names may run.
const QJS_SHA256 = "d2939e98c808e8b9f4164cd0d7b0398cbc0121ddf52862bcd92157d923e461cc";  // v0.16.2
const wasm = readFileSync(new URL("qjs-wasi.wasm", import.meta.url));
if (createHash("sha256").update(wasm).digest("hex") !== QJS_SHA256) {
  throw new Error("qjs-wasi.wasm is not the release this server names");
}

const wasi = new WASI({
  version: "preview1",
  args: ["qjs", "--std", ...process.argv.slice(2)],  // --std: the std module, which reads stdin
  preopens: { "/app": "." },
  returnOnExit: true  // qjs's exit code comes back from start() below, and becomes this process's
});
const qjs = await WebAssembly.compile(wasm);
const instance = await WebAssembly.instantiate(qjs, wasi.getImportObject());
process.exitCode = wasi.start(instance);
