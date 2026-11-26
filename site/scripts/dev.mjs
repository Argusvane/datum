// One dev server for the marketing pages and the docs: VitePress on DOCS_DEV_PORT (5174) first,
// on a fixed port so the marketing server's /docs proxy (vite.config.ts) finds it, then Vite on
// its usual 5173. Both share this terminal; closing it, or Ctrl-C, stops both.
import { spawn } from "node:child_process";

const docsPort = process.env.DOCS_DEV_PORT ?? "5174";
const run = (args) => spawn(process.execPath, args, { stdio: "inherit", env: { ...process.env, DOCS_DEV_PORT: docsPort } });

const docs = run(["node_modules/vitepress/bin/vitepress.js", "dev", "docs", "--port", docsPort, "--strictPort"]);
// Extra arguments go to the marketing server: `npm run dev -- --port 5183`.
const site = run(["node_modules/vite/bin/vite.js", ...process.argv.slice(2)]);

const stop = () => {
  for (const child of [docs, site]) if (child.exitCode === null) child.kill("SIGTERM");
};
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => { stop(); process.exit(0); });
for (const child of [docs, site]) child.on("exit", (code) => { stop(); process.exit(code ?? 0); });
