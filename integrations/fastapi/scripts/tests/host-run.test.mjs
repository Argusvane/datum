import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { groupAlive, parseArgs, run } from "../host-run.mjs";

const node = process.execPath;
const server = (port) =>
  `require("http").createServer((q,s)=>s.end("ok")).listen(${port},"127.0.0.1");require("fs").writeFileSync(process.env.PIDFILE,String(process.pid))`;
const sink = { write() {} };

function freePort() {
  return 20000 + Math.floor(Math.random() * 20000);
}

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "host-run-"));
  return { dir, pidfile: join(dir, "pid") };
}

test("parseArgs: splits the app and check commands and validates", () => {
  const o = parseArgs(["--port", "18765", "--path", "/x", "--any-status", "--deadline", "9", "--", "a", "b", "--check", "c", "d"]);
  assert.deepEqual([o.port, o.path, o.anyStatus, o.deadline, o.app, o.check], [18765, "/x", true, 9, ["a", "b"], ["c", "d"]]);
  assert.throws(() => parseArgs(["--port", "1", "--", "a"]), /--check/);
  assert.throws(() => parseArgs(["--port", "0", "--", "a", "--check", "b"]), /--port/);
  assert.throws(() => parseArgs(["--port", "1", "--", "--check", "b"]), /app command/);
  assert.throws(() => parseArgs(["--bogus"]), /unknown option/);
});

for (const [name, code] of [["passing", 0], ["failing", 3]]) {
  test(`run: ${name} check returns its exit code and the host's process group is gone`, async () => {
    const { pidfile, dir } = scratch();
    process.env.PIDFILE = pidfile;
    const port = freePort();
    const options = parseArgs(["--port", String(port), "--interval", "0.1", "--deadline", "20", "--log", join(dir, "app.log"), "--", node, "-e", server(port), "--check", node, "-e", `process.exit(${code})`]);
    assert.equal(await run(options, { stdout: sink, stderr: sink }), code);
    const pid = Number(readFileSync(pidfile, "utf8"));
    assert.equal(groupAlive(pid), false);
  });
}

test("run: a host that never listens ends at the deadline with a message and exit 1", async () => {
  const errors = [];
  const options = parseArgs(["--port", String(freePort()), "--interval", "0.1", "--deadline", "1", "--", node, "-e", "setInterval(()=>{},1000)", "--check", node, "-e", "process.exit(0)"]);
  assert.equal(await run(options, { stdout: sink, stderr: { write: (s) => errors.push(s) } }), 1);
  assert.match(errors.join(""), /did not answer on port \d+.* within 1 s/);
});

test("run: a host that exits early is reported", async () => {
  const errors = [];
  const options = parseArgs(["--port", String(freePort()), "--interval", "0.1", "--deadline", "20", "--", node, "-e", "process.exit(4)", "--check", node, "-e", "process.exit(0)"]);
  assert.equal(await run(options, { stdout: sink, stderr: { write: (s) => errors.push(s) } }), 1);
  assert.match(errors.join(""), /exited before it answered/);
});
