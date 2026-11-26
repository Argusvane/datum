// The tester's static server (node:http, 127.0.0.1 only). It answers, first match wins:
//  - the host page at / and /binding-check.html, and the page-side script at /binding-check/page.js;
//  - the files of the build (host module, binding module, chunks) held in memory, at /binding-check/run/<file>;
//  - the asset roots the run names: each root is a folder holding a design system's own files
//    (a binding package with its node_modules), standing in for the host's CDN (ds-files.mjs).
import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDsFile, TYPES } from "./lib/ds-files.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const OWN = { "/": "host.html", "/binding-check.html": "host.html", "/binding-check/page.js": "page.js" };
export const RUN_PREFIX = "/binding-check/run/";

/**
 * Starts the server on `port` (0 asks for a free one). `files` is a Map of served name to
 * `{ contents, type }`, read on every request, so a build can fill it after the start.
 * Resolves to `{ port, files, close() }`.
 */
export function startServer({ port = 0, roots = [], files = new Map() } = {}) {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      response.writeHead(400, { "content-type": "text/plain" });
      response.end("Bad request");
      return;
    }
    const send = (type, body) => {
      response.writeHead(200, { "content-type": type, "cache-control": "no-store" });
      response.end(body);
    };
    if (Object.prototype.hasOwnProperty.call(OWN, pathname)) {
      const file = join(here, OWN[pathname]);
      response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
      createReadStream(file).pipe(response);
      return;
    }
    if (pathname.startsWith(RUN_PREFIX)) {
      const built = files.get(pathname.slice(RUN_PREFIX.length));
      if (built) return send(built.type, built.contents);
    }
    const file = resolveDsFile(roots, pathname);
    if (!file) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end(`Not found: ${pathname}`);
      return;
    }
    response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    createReadStream(file).pipe(response);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve({ port: server.address().port, files, close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(() => done()); }) });
    });
  });
}
