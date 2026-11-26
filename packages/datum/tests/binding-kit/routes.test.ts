// @vitest-environment node
// The kit's session is offline: a route in the binding's assets file answers a third-party request from the
// package, and a request nothing answers is refused and fails the step, naming the URL. Chromium through
// Playwright; skipped where Playwright has no Chromium (the usual CI case).
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KIT, REPO, load } from "./load.js";

const chromium = ((): string | undefined => {
  try {
    const path = (createRequire(import.meta.url)("playwright") as { chromium: { executablePath(): string } }).chromium.executablePath();
    return existsSync(path) ? path : undefined;
  } catch {
    return undefined;
  }
})();

describe.skipIf(chromium === undefined)("kit session routes and offline mode (Chromium)", () => {
  it("answers a routed URL from the package, refuses an unrouted one naming it, and reports a listed host", async () => {
    const root = mkdtempSync(join(tmpdir(), "kit-routes-"));
    try {
      const dir = join(root, "routed-ds");
      const made = spawnSync(process.execPath, [join(REPO, "scripts", "new-binding.mjs"), "routed-ds", "--design-system", "Routed", "--release", "1.0.0", "--dir", dir], { encoding: "utf8" });
      expect(made.status, made.stderr).toBe(0);
      writeFileSync(join(dir, "fonts.css"), '@font-face { font-family: "X"; src: url("path/to/file/x.woff2"); }');
      const assetsFile = join(dir, "binding-check.json");
      const assets = existsSync(assetsFile) ? (JSON.parse(readFileSync(assetsFile, "utf8")) as Record<string, unknown>) : {};
      writeFileSync(assetsFile, JSON.stringify({
        ...assets,
        routes: [{ match: "https://fonts.example.test/css2", stylesheets: [{ path: "/fonts.css", rebase: { "path/to/file/": "/fonts/" } }] }],
        network: [{ host: "cdn.example.test", reason: "publishes its icon font only on its CDN" }]
      }));
      const { openSession } = await load(join(KIT, "lib", "session.mjs"));
      const { resolveBinding } = await load(join(KIT, "lib", "binding-package.mjs"));
      const session = await openSession(resolveBinding(dir));
      try {
        const opened = await session.newPage();
        const ask = (url: string): Promise<string> => opened.page.evaluate(`fetch(${JSON.stringify(url)}).then((r) => r.text(), (e) => "refused: " + e.message)`);
        const css = await ask("https://fonts.example.test/css2?family=X");
        expect(css).toContain(`url("${session.origin}/fonts/x.woff2")`);
        expect(session.takeOffline().problems).toEqual([]);

        expect(await ask("https://cdn.unlisted.test/icons.woff")).toMatch(/^refused/);
        await ask("https://cdn.example.test/icons.woff");
        const offline = session.takeOffline();
        expect(offline.problems).toHaveLength(1);
        expect(offline.problems[0]).toContain("https://cdn.unlisted.test/icons.woff");
        expect(offline.notes).toEqual(["known network dependency: cdn.example.test (publishes its icon font only on its CDN)"]);
        await opened.close();
      } finally {
        await session.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);
});
