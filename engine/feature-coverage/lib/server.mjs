// A small static server for the harness: the host page at `/` and the in-memory bundle files
// at `/<name>`. Bound to 127.0.0.1 on a port of the harness's range (4820-4899 unless
// FEATURES_PORTS=start-end says another, so agents sharing a machine each keep to their own).
import { createServer } from "node:http";

const DEFAULT_PORT_RANGE = [4820, 4899];

/** The range `FEATURES_PORTS` ("4930-4939") names, else the default; an unreadable value is an error, not a silent default. */
export function portRangeOf(value) {
  if (value === undefined || value === "") {
    return DEFAULT_PORT_RANGE;
  }
  const match = /^(\d{1,5})-(\d{1,5})$/.exec(value.trim());
  const range = match ? [Number(match[1]), Number(match[2])] : undefined;
  if (!range || range[0] > range[1] || range[1] > 65535) {
    throw new Error(`FEATURES_PORTS must be "start-end" with start <= end <= 65535 (got "${value}").`);
  }
  return range;
}

export const PORT_RANGE = portRangeOf(process.env.FEATURES_PORTS);

const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Feature coverage host</title>
    <style>body { margin: 0; padding: 16px; font: 16px system-ui, sans-serif; background: #fff; color: #111; }</style>
  </head>
  <body>
    <main id="stage"></main>
    <script type="module" src="/host.js"></script>
  </body>
</html>
`;

/** Starts serving `files` (name → {contents, type}); resolves to `{ url, close() }`. */
export function serve(files, port) {
  if (!Number.isInteger(port) || port < PORT_RANGE[0] || port > PORT_RANGE[1]) {
    throw new Error(`Port ${port} is outside the harness's range ${PORT_RANGE[0]}-${PORT_RANGE[1]}.`);
  }
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
    if (path === "/" || path === "/index.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(PAGE);
      return;
    }
    const file = files.get(path.replace(/^\//, ""));
    if (!file) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
      return;
    }
    response.writeHead(200, { "content-type": `${file.type}; charset=utf-8`, "cache-control": "no-store" });
    response.end(file.contents);
  });
  return new Promise((resolveServe, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolveServe({
        url: `http://127.0.0.1:${port}/`,
        close: () => new Promise((done) => server.close(() => done()))
      });
    });
  });
}
