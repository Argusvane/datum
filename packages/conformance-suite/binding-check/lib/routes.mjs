// What the tester's browser may reach beyond its own server. A design system's stylesheet can
// reach for a third party at load time (GC Design System's gcds.css @imports Google Fonts, and
// Google answers that request with one of two stylesheets that name different font files), so a
// check that draws pictures from it would depend on someone else's CDN on the day it runs. A
// binding's assets file (binding-check.json) closes that:
//
//   "routes":  [{ "match": "https://fonts.googleapis.com/css2",
//                 "stylesheets": ["/node_modules/gcds-fonts-1.1.1/fonts/lato/gcds-lato.css", ...] },
//               { "match": "https://cdn.example.org/fonts@1.1.1/",
//                 "files": "/node_modules/gcds-fonts-1.1.1/fonts/" }]
//   "network": [{ "host": "cdn.example.org", "reason": "publishes its icon font only there" }]
//   "known":   [{ "case": "MV-01", "reason": "the design system's own element throws when it is put back", "since": "2026-11-14" }]
//
// `known` is the same honesty for a case: a defect of the design system itself, which a binding never
// patches or works around, is declared here with its reason. Both runners (the conformance suite's and
// the kit's behaviour suite) report such a case as known while it fails, and as a problem once it
// passes, so the list cannot hide a fix. `readRouting` checks the shape; given `cases` (the ids of
// both suites, which only the kit holds together) it also refuses an id that matches no case.
//
// A request whose URL starts with a route's `match` is answered, inside the browser, either with the
// route's `stylesheets` concatenated, or (`files`) with the file of the pinned package that sits under
// the path `files` names where the URL sits under `match` (a CDN folder mirrored by the package). The
// files are the binding's own pinned ones, found the way the server finds them (ds-files.mjs), so
// nothing is copied into the repository; the url()s in a stylesheet are resolved to the tester's
// server, which then serves the font files from the same package.
// A stylesheet may be `{ "path": ..., "rebase": { "path/to/file/": "/node_modules/.../fonts/lato/" } }`
// where the package ships its url()s as a placeholder to be replaced (the GCDS font stylesheets do).
//
// With `offline` a request to any other host is aborted and recorded, and the run fails on the
// record: a host the binding really needs from a CDN is listed in `network` with the reason, and
// the run reports it as a known network dependency instead of failing. Requests to the tester's own
// server and data:, blob: and about: URLs are never touched.
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { PreflightError } from "../build.mjs";
import { resolveDsFile, TYPES } from "./ds-files.mjs";

const isText = (value) => typeof value === "string" && value.trim() !== "";

/**
 * The `routes`, `network` and `known` of an assets file, validated: `{ routes, network, known }` with every
 * stylesheet as `{ path, rebase }`. Throws a PreflightError that names the problem. An empty or absent list
 * is fine. `cases`, when given, is every case id a `known` entry may name (the conformance suite's and the
 * kit's behaviour suite's); an id outside it is an error, so a renamed or removed case cannot leave the list stale.
 */
export function readRouting(doc, where = "binding-check.json", { cases } = {}) {
  const fail = (message) => { throw new PreflightError(`${where}: ${message}`); };
  const routes = [];
  for (const [index, route] of (doc?.routes ?? []).entries()) {
    if (!route || typeof route !== "object") fail(`routes[${index}] must be an object { match, stylesheets }`);
    if (!isText(route.match) || !/^https?:\/\//.test(route.match)) fail(`routes[${index}].match must be the http(s) URL (or the start of the URL) the browser would request`);
    if (route.files !== undefined) {
      if (route.stylesheets !== undefined) fail(`routes[${index}] has both stylesheets and files: a route answers one way`);
      if (!isText(route.files) || !route.files.startsWith("/") || !route.files.endsWith("/") || !route.match.endsWith("/")) fail(`routes[${index}]: files must be a folder path the server serves (starting and ending with /), and match the URL of the folder it mirrors (ending with /)`);
      routes.push({ match: route.match, files: route.files });
      continue;
    }
    if (!Array.isArray(route.stylesheets) || route.stylesheets.length === 0) fail(`routes[${index}].stylesheets must list the package stylesheets that answer ${route.match}, or files must name the package folder that mirrors it`);
    const stylesheets = route.stylesheets.map((sheet, at) => {
      const entry = typeof sheet === "string" ? { path: sheet } : sheet;
      if (!entry || !isText(entry.path) || !entry.path.startsWith("/")) fail(`routes[${index}].stylesheets[${at}] must be a path the server serves, such as /node_modules/<pinned alias>/....css`);
      const rebase = entry.rebase ?? {};
      if (typeof rebase !== "object" || Object.values(rebase).some((to) => !isText(to))) fail(`routes[${index}].stylesheets[${at}].rebase must map a url() prefix to the path that replaces it`);
      return { path: entry.path, rebase };
    });
    routes.push({ match: route.match, stylesheets });
  }
  const network = [];
  for (const [index, entry] of (doc?.network ?? []).entries()) {
    if (!entry || typeof entry !== "object" || !isText(entry.host) || /[/:]/.test(entry.host)) fail(`network[${index}] must be { "host": "cdn.example.org", "reason": "..." } (a host name, no scheme or path)`);
    if (!isText(entry.reason)) fail(`network[${index}] (${entry.host}) needs a reason: say why no pinned package can supply the file`);
    network.push({ host: entry.host, reason: entry.reason.trim() });
  }
  const known = [];
  for (const [index, entry] of (doc?.known ?? []).entries()) {
    if (!entry || typeof entry !== "object" || !isText(entry.case)) fail(`known[${index}] must be { "case": "MV-01", "reason": "...", "since": "2026-11-14" } (a case id of the behaviour suite or the conformance suite)`);
    if (!isText(entry.reason)) fail(`known[${index}] (${entry.case}) needs a reason: say what in the design system causes it`);
    if (!isText(entry.since) || !/^\d{4}-\d{2}-\d{2}$/.test(entry.since)) fail(`known[${index}] (${entry.case}) needs "since": the date it was declared, as YYYY-MM-DD`);
    if (known.some((other) => other.case === entry.case)) fail(`known[${index}]: ${entry.case} is listed twice`);
    if (cases && !cases.includes(entry.case)) fail(`known[${index}]: ${entry.case} matches no case of the behaviour suite or the conformance suite (the list cannot name a case that is gone)`);
    known.push({ case: entry.case, reason: entry.reason.trim(), since: entry.since });
  }
  return { routes, network, known };
}

/** The stylesheet's text with each url() and @import resolved against where the stylesheet is served (after the `rebase` prefixes are replaced). */
function resolveReferences(css, sheetUrl, rebase) {
  const target = (ref) => {
    let at = ref;
    for (const [from, to] of Object.entries(rebase)) {
      if (ref.startsWith(from)) { at = to + ref.slice(from.length); break; }
    }
    return new URL(at, sheetUrl).href;
  };
  const keep = (ref) => /^(?:data:|#)/.test(ref);
  return css
    .replace(/url\(\s*(["']?)([^"')]*?)\1\s*\)/g, (whole, quote, ref) => (keep(ref) ? whole : `url(${quote}${target(ref)}${quote})`))
    .replace(/@import\s+(["'])([^"']+)\1/g, (whole, quote, ref) => (keep(ref) ? whole : `@import ${quote}${target(ref)}${quote}`));
}

/**
 * The routing of one browser: `attach(context)` installs it on a context, and the record of what happened
 * is read back with `problems()` (every unanswered request, once per URL), `take()` (the same, cleared),
 * `notes()` (the known network dependencies the run used) and `answers(url)` (a route or a listed host
 * would let `url` through).
 */
export function createRouting({ origin, roots = [], routes = [], network = [], offline = false } = {}) {
  const local = new URL(origin).host;
  const problems = [];
  const seen = new Set();
  const used = new Map();
  const bodies = new Map();

  const problem = (message, key = message) => {
    if (seen.has(key)) return;
    seen.add(key);
    problems.push(message);
  };

  /** The file of a `files` route that answers `url`, as `{ body, type }`; undefined (and a problem) when the package does not hold it. */
  const fileOf = (route, url) => {
    const path = route.files + decodeURIComponent(new URL(url).pathname).slice(new URL(route.match).pathname.length);
    const file = resolveDsFile(roots, path);
    if (!file) {
      problem(`route ${route.match}: ${path} is not in the binding's pinned packages (the page asked for ${url})`, `file ${url}`);
      return undefined;
    }
    return { body: readFileSync(file), type: TYPES[extname(file)] ?? "application/octet-stream" };
  };

  const bodyOf = (route) => {
    if (bodies.has(route)) return bodies.get(route);
    const parts = [];
    for (const sheet of route.stylesheets) {
      const file = resolveDsFile(roots, sheet.path);
      if (!file) {
        problem(`route ${route.match}: ${sheet.path} is not in the binding's pinned packages (the file does not exist where the server looks; is the devDependency installed?)`);
        return undefined;
      }
      parts.push(resolveReferences(readFileSync(file, "utf8"), `${origin}${sheet.path}`, sheet.rebase));
    }
    const body = parts.join("\n");
    bodies.set(route, body);
    return body;
  };

  const refusal = (url) => `offline: the page asked for ${url}, which nothing answers. Add a route that answers it from a pinned package of the binding ("routes" in binding-check.json), or, for a design system that publishes the file only on a CDN, list the host in "network" with the reason.`;

  async function handle(route) {
    const url = route.request().url();
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return route.continue();
    }
    if (!/^(?:https?|wss?):$/.test(parsed.protocol) || parsed.host === local) return route.continue();
    const matched = routes.find((candidate) => url.startsWith(candidate.match));
    if (matched) {
      const headers = { "access-control-allow-origin": "*", "cache-control": "no-store" };
      if (matched.files !== undefined) {
        const file = fileOf(matched, url);
        if (!file) return route.abort("failed");
        return route.fulfill({ status: 200, contentType: file.type, headers, body: file.body });
      }
      const body = bodyOf(matched);
      if (body === undefined) return route.abort("failed");
      return route.fulfill({ status: 200, contentType: "text/css; charset=utf-8", headers, body });
    }
    const listed = network.find((entry) => entry.host === parsed.hostname || entry.host === parsed.host);
    if (listed) {
      used.set(listed.host, listed.reason);
      return route.continue();
    }
    if (!offline) return route.continue();
    problem(refusal(url), url);
    return route.abort("blockedbyclient");
  }

  return {
    async attach(context) {
      await context.route(/.*/, handle);
    },
    problems: () => [...problems],
    take() {
      const taken = problems.splice(0);
      return taken;
    },
    notes: () => [...used].map(([host, reason]) => `known network dependency: ${host} (${reason})`),
    answers: (url) => routes.some((candidate) => url.startsWith(candidate.match)) || network.some((entry) => entry.host === new URL(url).hostname)
  };
}
