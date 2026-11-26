#!/usr/bin/env node
// Boots a host, waits until it answers, runs a check against it, and always stops the host's whole process group.
//
// The CI host-check steps and a developer's machine run the same command. A detached spawn makes the child a
// process-group leader on Linux and macOS alike (macOS has no setsid), so one signal to the group stops the app and
// everything it started (uv, then uvicorn).
//
//   node host-run.mjs --port 18765 [--path /datum/assets/host.json] [--any-status] [--deadline 180] [--interval 2]
//        [--log file] [--cwd dir] -- <app command...> --check <check command...>
//
// Ready means an HTTP 2xx from the path, or, with --any-status, any HTTP answer. The check runs in the current
// directory with the host's stdio; the exit code is the check's. A host that has not answered by the deadline, or that
// exits first, ends the run with a message and exit code 1.
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

export function parseArgs(argv) {
  const options = { port: 0, path: "/", anyStatus: false, deadline: 180, interval: 2, log: null, cwd: null, app: [], check: [] };
  let i = 0;
  const value = (name) => {
    if (i + 1 >= argv.length) throw new Error(`${name} needs a value`);
    return argv[++i];
  };
  for (; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      const rest = argv.slice(i + 1);
      const at = rest.indexOf("--check");
      if (at < 0) throw new Error("--check <command> is missing");
      options.app = rest.slice(0, at);
      options.check = rest.slice(at + 1);
      break;
    }
    if (arg === "--port") options.port = Number(value(arg));
    else if (arg === "--path") options.path = value(arg);
    else if (arg === "--any-status") options.anyStatus = true;
    else if (arg === "--deadline") options.deadline = Number(value(arg));
    else if (arg === "--interval") options.interval = Number(value(arg));
    else if (arg === "--log") options.log = value(arg);
    else if (arg === "--cwd") options.cwd = value(arg);
    else throw new Error(`unknown option ${arg}`);
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error("--port must be 1-65535");
  if (!(options.deadline > 0) || !(options.interval > 0)) throw new Error("--deadline and --interval must be positive");
  if (options.app.length === 0) throw new Error("the app command after -- is empty");
  if (options.check.length === 0) throw new Error("the check command after --check is empty");
  return options;
}

export function groupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function stopGroup(pid) {
  for (const [signal, waitMs] of [["SIGTERM", 5000], ["SIGKILL", 5000]]) {
    try {
      process.kill(-pid, signal);
    } catch {
      return;
    }
    const until = Date.now() + waitMs;
    while (groupAlive(pid) && Date.now() < until) await sleep(50);
    if (!groupAlive(pid)) return;
  }
}

async function answers(options) {
  try {
    const response = await fetch(`http://127.0.0.1:${options.port}${options.path}`, { signal: AbortSignal.timeout(5000) });
    await response.arrayBuffer();
    return options.anyStatus || response.ok;
  } catch {
    return false;
  }
}

export async function run(options, { stdout = process.stdout, stderr = process.stderr } = {}) {
  let logFd = "ignore";
  if (options.log) {
    mkdirSync(dirname(options.log), { recursive: true });
    logFd = openSync(options.log, "w");
  }
  const app = spawn(options.app[0], options.app.slice(1), {
    cwd: options.cwd ?? undefined,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  if (typeof logFd === "number") closeSync(logFd);
  let exited = null;
  app.on("exit", (code, signal) => (exited = { code, signal }));
  app.on("error", (error) => (exited = { code: null, signal: null, error }));
  try {
    const until = Date.now() + options.deadline * 1000;
    let ready = false;
    while (!ready) {
      if (exited) {
        stderr.write(`host-run: the host exited before it answered on port ${options.port} (${exited.error?.message ?? `code ${exited.code}, signal ${exited.signal}`})\n`);
        return 1;
      }
      if (await answers(options)) ready = true;
      else if (Date.now() >= until) {
        stderr.write(`host-run: the host did not answer on port ${options.port}${options.path} within ${options.deadline} s\n`);
        return 1;
      } else await sleep(options.interval * 1000);
    }
    stdout.write(`host-run: the host answers on port ${options.port}\n`);
    const check = spawn(options.check[0], options.check.slice(1), { stdio: "inherit" });
    return await new Promise((resolve) => {
      check.on("error", (error) => {
        stderr.write(`host-run: the check did not start (${error.message})\n`);
        resolve(1);
      });
      check.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    });
  } finally {
    if (app.pid) await stopGroup(app.pid);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`host-run: ${error.message}\n`);
    process.exit(2);
  }
  process.exit(await run(options));
}
