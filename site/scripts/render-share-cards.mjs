// Draws the link-preview cards (public/og/*.png, 1200 x 630) in the site's own look: the
// light theme's tokens, Bebas Neue, Archivo and IBM Plex Mono from the site's own font files, 3px rules,
// the four-stroke mark. Run by hand after changing the copy below, then commit the PNGs:
//
//   node scripts/render-share-cards.mjs
//
// It drives a local headless Chrome over the DevTools protocol (Node's own WebSocket, no
// dependencies). CHROME names the binary when it is not at the macOS default.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.CDP_PORT ?? 9461);
const OUT = process.env.OG_OUT ?? fileURLToPath(new URL("../public/og/", import.meta.url));
const FONTS = fileURLToPath(new URL("../public/fonts/", import.meta.url));
// The cards set their small labels in IBM Plex Mono bold, which the site's pages do not use, so that one file lives beside this script.
const SCRIPT_FONTS = fileURLToPath(new URL("./fonts/", import.meta.url));
const WIDTH = 1200;
const HEIGHT = 630;

const MARK = `<svg width="56" height="56" viewBox="0 0 28 28" aria-hidden="true">
  <path d="M4 6h8M4 11h20" stroke="#141414" stroke-width="2.5" stroke-linecap="square" />
  <path d="M4 17h12" stroke="#141414" stroke-width="2.5" stroke-linecap="square" />
  <path d="M4 22h20" stroke="#d3080c" stroke-width="2.5" stroke-linecap="square" />
</svg>`;

/** The three typefaces as @font-face rules with the files inline (latin only: the cards use no other script), so the page asks nobody for a font. */
const FONT_FACES = [
  ["Bebas Neue", "400", "bebas-neue-latin-400"],
  ["Archivo", "400 700", "archivo-latin-variable"],
  ["IBM Plex Mono", "500", "ibm-plex-mono-latin-500"],
  ["IBM Plex Mono", "700", "ibm-plex-mono-latin-700"]
]
  .map(([family, weight, file]) => {
    const path = join(file.endsWith("-700") ? SCRIPT_FONTS : FONTS, `${file}.woff2`);
    return `@font-face { font-family: "${family}"; font-weight: ${weight}; font-display: block; src: url(data:font/woff2;base64,${readFileSync(path).toString("base64")}) format("woff2"); }`;
  })
  .join("\n");

/** One card's page: eyebrow, headline lines (each ends in the accent full stop), foot line, and ruled rows beside the headline when given. */
function card({ eyebrow, lines, size, foot, rows }) {
  const headline = lines.map((line) => `<span>${line}<span class="dot">.</span></span>`).join("");
  const aside = rows
    ? `<ul class="rows">${rows.map(([label, text]) => `<li><span class="rows__label">${label}</span><span>${text}</span></li>`).join("")}</ul>`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8">
<style>
${FONT_FACES}
  * { box-sizing: border-box; margin: 0; }
  html, body { width: ${WIDTH}px; height: ${HEIGHT}px; background: #fafaf9; color: #141414; }
  body { padding: 56px 64px; display: flex; flex-direction: column; font-family: "Archivo", sans-serif; }
  .brand { display: flex; align-items: center; gap: 18px; font-family: "Bebas Neue", sans-serif; font-size: 48px; letter-spacing: 0.1em; line-height: 1; }
  .main { flex: 1; display: flex; align-items: center; gap: 56px; }
  .words { display: flex; flex-direction: column; gap: 22px; }
  .rows { flex: 1; list-style: none; padding: 0; border-top: 2px solid #2c2d30; border-bottom: 2px solid #2c2d30; }
  .rows li { display: flex; flex-direction: column; gap: 6px; padding: 16px 0; font-size: 24px; line-height: 1.3; }
  .rows li + li { border-top: 1px solid #2c2d30; }
  .rows__label { font-family: "IBM Plex Mono", monospace; font-weight: 700; font-size: 18px; letter-spacing: 0.14em; text-transform: uppercase; }
  .eyebrow { font-family: "IBM Plex Mono", monospace; font-weight: 700; font-size: 22px; letter-spacing: 0.18em; text-transform: uppercase; color: #d3080c; }
  h1 { font-family: "Bebas Neue", sans-serif; font-weight: 400; font-size: ${size}px; line-height: 0.88; letter-spacing: 0.01em; text-transform: uppercase; display: flex; flex-direction: column; }
  .dot { color: #d3080c; }
  .foot { border-top: 2px solid #2c2d30; padding-top: 20px; font-family: "IBM Plex Mono", monospace; font-weight: 500; font-size: 21px; letter-spacing: 0.06em; color: #5a5b5e; }
</style></head><body>
  <div class="brand">${MARK}<span>Datum</span></div>
  <div class="main"><div class="words"><p class="eyebrow">${eyebrow}</p><h1>${headline}</h1></div>${aside}</div>
  <p class="foot">${foot}</p>
</body></html>`;
}

const CARDS = {
  "datum.png": card({
    eyebrow: "Define once. Deliver anywhere. Own it completely.",
    lines: ["Sovereign forms"],
    size: 172,
    foot: "Forms infrastructure &middot; open source (MIT) &middot; run it where you need it"
  }),
  "partners.png": card({
    eyebrow: "Partners",
    lines: ["Run it", "Embed it", "Deliver it"],
    size: 104,
    foot: "Datum &middot; forms infrastructure &middot; open source (MIT)",
    // The home page hero's three rows, in the same words.
    rows: [
      ["Run it", "Your organization's forms, in your own environment."],
      ["Embed it", "A form builder inside your product, without building one."],
      ["Deliver it", "One forms layer for every client project."]
    ]
  })
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function connect() {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const target = await (await fetch(`http://localhost:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
      const ws = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((resolve) => (ws.onopen = resolve));
      let id = 0;
      const pending = new Map();
      ws.onmessage = (message) => {
        const data = JSON.parse(message.data);
        if (data.id && pending.has(data.id)) {
          pending.get(data.id)(data);
          pending.delete(data.id);
        }
      };
      const send = (method, params = {}) =>
        new Promise((resolve, reject) => {
          const current = (id += 1);
          pending.set(current, (data) => (data.error ? reject(new Error(JSON.stringify(data.error))) : resolve(data.result)));
          ws.send(JSON.stringify({ id: current, method, params }));
        });
      return { send, close: () => ws.close() };
    } catch {
      await sleep(200);
    }
  }
  throw new Error(`No Chrome answered on port ${PORT}`);
}

const profile = mkdtempSync(join(tmpdir(), "datum-share-cards-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
try {
  const page = await connect();
  await page.send("Page.enable");
  await page.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
  mkdirSync(OUT, { recursive: true });
  for (const [name, html] of Object.entries(CARDS)) {
    const { frameId } = await page.send("Page.navigate", { url: "about:blank" });
    await page.send("Page.setDocumentContent", { frameId, html });
    // Each face is asked for by name: `fonts.ready` alone can settle before the page has asked for any.
    await page.send("Runtime.evaluate", {
      expression: `Promise.all(["48px 'Bebas Neue'", "700 22px 'IBM Plex Mono'", "500 22px 'IBM Plex Mono'", "16px Archivo"].map((face) => document.fonts.load(face)))
        .then(() => document.fonts.ready)`,
      awaitPromise: true
    });
    await sleep(300);
    const shot = await page.send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT, scale: 1 } });
    writeFileSync(join(OUT, name), Buffer.from(shot.data, "base64"));
    console.log(`render-share-cards: public/og/${name}`);
  }
  page.close();
} finally {
  chrome.kill();
  rmSync(profile, { recursive: true, force: true });
}
