#!/usr/bin/env node
// Runs a command while holding a named lock, so builds from several sessions or agents sharing
// one checkout never rewrite the same output at once.
//
//   node scripts/with-lock.mjs <name> [--timeout <minutes>] -- <command> [args...]
//
// The lock is a directory under <repo>/.locks/ (git-ignored, never under /tmp, which macOS
// empties on reboot). mkdir is atomic, so exactly one process wins. The winner writes owner.json
// (pid, host, command, start time). A waiter polls every 2 s, says once who holds the lock, and
// takes it over when the holder's process is gone (a killed build leaves a stale lock). A nested
// call for a lock the parent already holds runs straight through (DATUM_LOCKS_HELD), so wrapping
// `npm run build` never deadlocks on a script that calls the wrapped build again.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
if (sep < 1 || sep === argv.length - 1) {
  console.error("usage: node scripts/with-lock.mjs <name> [--timeout <minutes>] -- <command> [args...]");
  process.exit(2);
}
const opts = argv.slice(0, sep);
const command = argv.slice(sep + 1);
const name = opts[0];
if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) {
  console.error(`with-lock: bad lock name "${name}" (lower case letters, digits, - and _)`);
  process.exit(2);
}
const timeoutAt = opts.indexOf("--timeout");
const timeoutMinutes = timeoutAt > 0 ? Number(opts[timeoutAt + 1]) : 30;
if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
  console.error("with-lock: --timeout takes a positive number of minutes");
  process.exit(2);
}

const lockDir = join(repo, ".locks", `${name}.lock`);
const ownerFile = join(lockDir, "owner.json");
const held = (process.env.DATUM_LOCKS_HELD ?? "").split(",").filter(Boolean);

function run(env) {
  const child = spawn(command[0], command.slice(1), { stdio: "inherit", env, shell: process.platform === "win32" });
  // Forward stop signals and wait: the lock is released only after the command has exited.
  const forward = (signal) => child.kill(signal);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, forward);
  return new Promise((done) => {
    child.on("exit", (code, signal) => done(code ?? (signal ? 1 : 0)));
    child.on("error", (error) => {
      console.error(`with-lock: could not start ${command[0]}: ${error.message}`);
      done(127);
    });
  });
}

if (held.includes(name)) process.exit(await run(process.env));

function readOwner() {
  try {
    return JSON.parse(readFileSync(ownerFile, "utf8"));
  } catch {
    return undefined;
  }
}

function alive(owner) {
  if (!owner || owner.host !== hostname()) return true; // can't see another machine's processes: assume alive
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function tryAcquire() {
  mkdirSync(join(repo, ".locks"), { recursive: true });
  try {
    mkdirSync(lockDir);
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
  const owner = { pid: process.pid, host: hostname(), command: command.join(" "), cwd: process.cwd(), started: new Date().toISOString() };
  writeFileSync(ownerFile, `${JSON.stringify(owner, null, 2)}\n`);
  return true;
}

let released = false;
function release() {
  if (released) return;
  released = true;
  const owner = readOwner();
  if (owner && owner.pid !== process.pid) return; // taken over meanwhile: not ours to remove
  rmSync(lockDir, { recursive: true, force: true });
}

const sleep = (ms) => new Promise((wake) => setTimeout(wake, ms));
const deadline = Date.now() + timeoutMinutes * 60_000;
let announced = false;
let emptySince;
while (!tryAcquire()) {
  const owner = readOwner();
  if (owner && !alive(owner)) {
    console.error(`with-lock: "${name}" was held by pid ${owner.pid}, which is gone; taking it over`);
    rmSync(lockDir, { recursive: true, force: true });
    continue;
  }
  if (!owner) {
    // Created but owner.json not written yet, or left empty by a crash between the two steps.
    emptySince ??= Date.now();
    if (Date.now() - emptySince > 10_000) {
      console.error(`with-lock: "${name}" has no owner record; taking it over`);
      rmSync(lockDir, { recursive: true, force: true });
      emptySince = undefined;
      continue;
    }
  } else emptySince = undefined;
  if (!announced && owner) {
    console.error(`with-lock: waiting for "${name}", held by pid ${owner.pid} since ${owner.started}: ${owner.command}`);
    announced = true;
  }
  if (Date.now() > deadline) {
    console.error(`with-lock: gave up on "${name}" after ${timeoutMinutes} min`);
    process.exit(75);
  }
  await sleep(2000);
}

process.on("exit", release);
const env = { ...process.env, DATUM_LOCKS_HELD: [...held, name].join(",") };
const code = await run(env);
release();
process.exit(code);
