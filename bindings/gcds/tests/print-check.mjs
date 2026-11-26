// The GCDS print theme for real: every print fixture of the engine (overlap, dates, long text, read-only, grid,
// tabs, journey, translated) printed with its answers and blank, under this theme with GC Design System's own
// stylesheet (gcds.css, served here as a host would) and under the basic theme beside it.
// Checks, in headless Chromium in print media: the theme's self-check passes (its tokens are defined), no drawer
// was refused, every word the basic theme prints is printed here too (nothing lost), the fixture's expected text
// is there (and in the blank rendition none of its answers), headings come in order, nothing runs off the page,
// and the page prints to a PDF. Pictures of the first page of each case go to --shots.
//   node tests/print-check.mjs [--port 5304] [--shots dir]            (ports 5300-5319)
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPlaywright } from "../../../packages/conformance-suite/binding-check/api.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const arg = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const port = Number(arg("--port", "5304"));
const shots = arg("--shots", undefined);
const esbuild = createRequire(join(root, "package.json"))("esbuild");
const engineDir = join(root, "..", "..", "engine");
const out = join(process.env.TMPDIR ?? "/tmp", "gcds-print-check");
mkdirSync(out, { recursive: true });
if (shots) mkdirSync(shots, { recursive: true });

await esbuild.build({ entryPoints: [join(here, "print-entry.ts")], outfile: join(out, "entry.mjs"), bundle: true, format: "esm", platform: "node", target: "node22", logLevel: "warning", nodePaths: [join(engineDir, "node_modules")] });
// The theme alone, for the browser: its self-check runs against the print document.
const themeJs = (await esbuild.build({ entryPoints: [join(root, "print", "index.ts")], bundle: true, format: "iife", globalName: "GcdsPrint", platform: "browser", write: false, logLevel: "warning" })).outputFiles[0].text;

const css = readFileSync(join(root, "node_modules", "gcds-components-1.7.0", "dist", "gcds", "gcds.css"));
const { printCases } = await import(pathToFileURL(join(out, "entry.mjs")).href);
const cases = await printCases(`http://127.0.0.1:${port}/gcds.css`);
const pages = new Map(cases.flatMap((c) => [[`/${c.name}.gcds.html`, c.gcds], [`/${c.name}.basic.html`, c.basic]]));
const server = createServer((request, response) => {
  if (request.url === "/gcds.css") return void response.writeHead(200, { "content-type": "text/css", "access-control-allow-origin": "*" }).end(css);
  const html = pages.get(request.url ?? "");
  return void (html ? response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html) : response.writeHead(404).end());
});
await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));

const playwright = await loadPlaywright();
const browser = await playwright.chromium.launch();
const results = [];
const words = (text) => new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 1));
try {
  for (const c of cases) {
    const problems = [];
    const page = await browser.newPage({ viewport: { width: 816, height: 1056 } });
    await page.emulateMedia({ media: "print" });
    const text = {};
    for (const kind of ["gcds", "basic"]) {
      await page.goto(`http://127.0.0.1:${port}/${c.name}.${kind}.html`, { waitUntil: "load" });
      await page.evaluate("document.fonts.ready");
      text[kind] = await page.evaluate("document.body.innerText");
      if (kind === "gcds") {
        await page.evaluate(`${themeJs};window.GcdsPrint = GcdsPrint;`);
        const selfCheck = await page.evaluate("GcdsPrint.gcdsPrintTheme.selfCheck(document)");
        if (selfCheck.length > 0) problems.push(`self-check: ${selfCheck.join("; ")}`);
        const overflow = await page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth");
        if (overflow > 1) problems.push(`runs ${overflow}px off the page`);
        const ownDrawn = await page.evaluate("document.querySelectorAll('[class*=\"gp-\"]').length");
        if (ownDrawn === 0) problems.push("no element of the theme was drawn");
        if (shots) await page.screenshot({ path: join(shots, `${c.name}.png`), fullPage: true });
        const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
        if (pdf.length < 1500 || !Buffer.from(pdf.subarray(0, 5)).toString().startsWith("%PDF")) problems.push("no PDF came out");
      }
    }
    if (c.gcdsTheme !== "gcds-print") problems.push(`printed with ${c.gcdsTheme}${c.fellBack ? ` (${c.fellBack.join("; ")})` : ""}`);
    const have = words(text.gcds);
    const lost = [...words(text.basic)].filter((word) => !have.has(word));
    if (lost.length > 0) problems.push(`words the basic theme prints and this one does not: ${lost.slice(0, 8).join(", ")}`);
    // The page-number line is a page-margin box: it exists in the PDF, not in the document's text.
    for (const needle of (c.rendition === "answers" ? c.expect.text : c.expect.blankText).filter((needle) => !/^Page \d/.test(needle))) if (!text.gcds.includes(needle)) problems.push(`missing "${needle}"`);
    if (c.rendition === "blank") for (const needle of c.expect.answersOnly) if (text.gcds.includes(needle)) problems.push(`the blank form prints the answer "${needle}"`);
    let at = -1;
    for (const heading of c.expect.order ?? []) {
      const next = text.gcds.indexOf(heading, at + 1);
      if (next < 0 || next < at) { problems.push(`heading "${heading}" is not in order`); break; }
      at = next;
    }
    await page.close();
    results.push({ name: c.name, problems });
    console.log(`${problems.length === 0 ? "PASS" : "FAIL"} ${c.name}${problems.map((problem) => `\n       ${problem}`).join("")}`);
  }
} finally {
  await browser.close();
  server.close();
}
const failed = results.filter((r) => r.problems.length > 0).length;
console.log(`\ngcds print: ${results.length - failed} pass, ${failed} fail`);
process.exitCode = failed ? 1 : 0;
