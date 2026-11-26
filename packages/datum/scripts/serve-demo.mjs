// A plain static server over the package root, so the demo pages under demo/ can load the
// built bundles under dist/ the way a real page would (`<script src="/dist/datum-form.js">`).
// No dependencies: `npm run demo` after `npm run build`, then open http://localhost:4173/.
// `serveFiles` is the server itself, over one root or several.
import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");

export const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".webp": "image/webp"
};

/** The first root holding `pathname` as a file, as an absolute path; undefined when none does. */
export function resolveFile(roots, pathname) {
  for (const base of roots) {
    const file = normalize(join(base, pathname));
    if (file.startsWith(base + sep) && existsSync(file) && statSync(file).isFile()) return file;
  }
  return undefined;
}

/**
 * Serves `roots` in order on `port`: a request is answered from the first root that holds the
 * file. `generated` maps a path to a body served in place of any file (a module the overlay
 * writes); `/` is `index`.
 */
export function serveFiles({ roots, port, generated = {}, index = "/demo/index.html", banner }) {
  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/") {
      pathname = index;
    }
    if (Object.prototype.hasOwnProperty.call(generated, pathname)) {
      response.writeHead(200, { "content-type": TYPES[extname(pathname)] ?? "application/octet-stream", "cache-control": "no-store" });
      response.end(generated[pathname]);
      return;
    }
    const file = resolveFile(roots, pathname);
    if (!file) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end(`Not found: ${pathname}`);
      return;
    }
    response.writeHead(200, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store"
    });
    createReadStream(file).pipe(response);
  }).listen(port, () => {
    if (banner) console.log(banner(port));
  });
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  serveFiles({ roots: [root], port: Number(process.env.PORT ?? 4173), banner: (port) => `Datum web-components demo: http://localhost:${port}/` });
}
