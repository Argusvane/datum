import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

// @ts-expect-error The tester's routing is plain JavaScript with no declaration file.
import { createRouting, readRouting } from "../../binding-check/lib/routes.mjs";

interface Fulfilled { status: number; contentType: string; headers: Record<string, string>; body: string | Buffer }
interface Outcome { kind: "continue" | "abort" | "fulfill"; reason?: string; fulfilled?: Fulfilled }

const ORIGIN = "http://127.0.0.1:5200";

// A package folder the way a binding lays one out: a pinned font package under node_modules/<alias>/, whose
// stylesheet ships its url()s as a placeholder to be replaced.
const root = mkdtempSync(join(tmpdir(), "datum-routes-"));
const put = (path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};
put("node_modules/fonts-1.0.0/fonts/lato/lato.css", '@font-face { font-family: "Lato"; src: url("path/to/file/lato.woff2") format("woff2"), url(data:font/woff2;base64,AAAA); }');
put("node_modules/fonts-1.0.0/fonts/lato/lato.woff2", "FONT-BYTES");
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** The routing attached to a fake context; `ask(url)` is the browser requesting `url` and resolves to what the routing did with it. */
async function attach(options: Record<string, unknown>) {
  const routing = createRouting({ origin: ORIGIN, roots: [root], ...options });
  let handler: (route: unknown) => Promise<void> = async () => undefined;
  await routing.attach({ route: async (_pattern: RegExp, fn: typeof handler) => { handler = fn; } });
  const ask = async (url: string): Promise<Outcome> => {
    const done = vi.fn();
    const route = {
      request: () => ({ url: () => url }),
      continue: () => done({ kind: "continue" }),
      abort: (reason: string) => done({ kind: "abort", reason }),
      fulfill: (fulfilled: Fulfilled) => done({ kind: "fulfill", fulfilled })
    };
    await handler(route);
    return done.mock.calls[0]![0] as Outcome;
  };
  return { routing, ask };
}

const ROUTES = [{ match: "https://fonts.example.test/css2", stylesheets: [{ path: "/node_modules/fonts-1.0.0/fonts/lato/lato.css", rebase: { "path/to/file/": "/node_modules/fonts-1.0.0/fonts/lato/" } }] }];

describe("datum-binding-check: routes answer a third-party request from the binding's pinned package", () => {
  it("answers a URL that starts with the route's match with the stylesheet, its url()s resolved to the tester's server", async () => {
    const { ask, routing } = await attach({ routes: ROUTES, offline: true });
    const outcome = await ask("https://fonts.example.test/css2?family=Lato:wght@700&display=swap");
    expect(outcome.kind).toBe("fulfill");
    expect(outcome.fulfilled?.contentType).toMatch(/^text\/css/);
    expect(String(outcome.fulfilled?.body)).toContain(`url("${ORIGIN}/node_modules/fonts-1.0.0/fonts/lato/lato.woff2")`);
    // A data: URL inside the stylesheet is left alone.
    expect(String(outcome.fulfilled?.body)).toContain("url(data:font/woff2;base64,AAAA)");
    expect(routing.problems()).toEqual([]);
  });

  it("answers a file under a mirrored folder with the pinned package's file", async () => {
    const { ask } = await attach({ routes: [{ match: "https://cdn.example.test/fonts@1.0.0/", files: "/node_modules/fonts-1.0.0/fonts/" }], offline: true });
    const outcome = await ask("https://cdn.example.test/fonts@1.0.0/lato/lato.woff2");
    expect(outcome.kind).toBe("fulfill");
    expect(outcome.fulfilled?.contentType).toBe("font/woff2");
    expect(String(outcome.fulfilled?.body)).toBe("FONT-BYTES");
    const missing = await ask("https://cdn.example.test/fonts@1.0.0/lato/absent.woff2");
    expect(missing.kind).toBe("abort");
  });

  it("names a route's missing package file instead of answering with nothing", async () => {
    const { ask, routing } = await attach({ routes: [{ match: "https://fonts.example.test/css2", stylesheets: [{ path: "/node_modules/fonts-1.0.0/absent.css", rebase: {} }] }], offline: true });
    expect((await ask("https://fonts.example.test/css2?family=x")).kind).toBe("abort");
    expect(routing.problems().join("\n")).toMatch(/absent\.css is not in the binding's pinned packages/);
  });
});

describe("datum-binding-check: offline refuses what nothing answers", () => {
  it("aborts a request to another host and records its URL, once", async () => {
    const { ask, routing } = await attach({ routes: ROUTES, offline: true });
    const outcome = await ask("https://cdn.elsewhere.test/icons.woff");
    expect(outcome).toMatchObject({ kind: "abort" });
    await ask("https://cdn.elsewhere.test/icons.woff");
    const problems = routing.problems() as string[];
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("https://cdn.elsewhere.test/icons.woff");
    expect(problems[0]).toMatch(/"routes"/);
    expect(problems[0]).toMatch(/"network"/);
    expect(routing.take()).toHaveLength(1);
    expect(routing.problems()).toEqual([]);
  });

  it("lets the tester's own server, data:, blob: and about: URLs through", async () => {
    const { ask, routing } = await attach({ offline: true });
    for (const url of [`${ORIGIN}/binding-check.html`, "data:text/css,a{}", "blob:http://127.0.0.1:5200/1", "about:blank"]) expect((await ask(url)).kind).toBe("continue");
    expect(routing.problems()).toEqual([]);
  });

  it("reaches a host the assets file lists in network and reports it as a known dependency", async () => {
    const { ask, routing } = await attach({ network: [{ host: "cdn.listed.test", reason: "publishes its icon font only there" }], offline: true });
    expect((await ask("https://cdn.listed.test/icons.woff")).kind).toBe("continue");
    expect(routing.problems()).toEqual([]);
    expect(routing.notes()).toEqual(["known network dependency: cdn.listed.test (publishes its icon font only there)"]);
  });

  it("is not enforced without offline: the request goes through and nothing is recorded", async () => {
    const { ask, routing } = await attach({});
    expect((await ask("https://cdn.elsewhere.test/icons.woff")).kind).toBe("continue");
    expect(routing.problems()).toEqual([]);
  });
});

describe("datum-binding-check: the routes and network of an assets file", () => {
  it("reads both lists, and an absent list is empty", () => {
    expect(readRouting({})).toEqual({ routes: [], network: [], known: [] });
    const read = readRouting({ routes: [{ match: "https://a.test/x", stylesheets: ["/node_modules/a/a.css"] }], network: [{ host: "cdn.test", reason: " why " }] });
    expect(read.routes[0].stylesheets).toEqual([{ path: "/node_modules/a/a.css", rebase: {} }]);
    expect(read.network).toEqual([{ host: "cdn.test", reason: "why" }]);
  });

  it("names what is wrong", () => {
    const bad = (doc: unknown) => () => readRouting(doc, "x/binding-check.json");
    expect(bad({ routes: [{ match: "fonts.test", stylesheets: ["/a.css"] }] })).toThrow(/x\/binding-check\.json: routes\[0\]\.match/);
    expect(bad({ routes: [{ match: "https://a.test/", stylesheets: [] }] })).toThrow(/routes\[0\]\.stylesheets/);
    expect(bad({ routes: [{ match: "https://a.test/", stylesheets: ["a.css"] }] })).toThrow(/stylesheets\[0\] must be a path/);
    expect(bad({ routes: [{ match: "https://a.test/x", files: "/node_modules/a/" }] })).toThrow(/files must be a folder path/);
    expect(bad({ network: [{ host: "https://cdn.test", reason: "r" }] })).toThrow(/network\[0\] must be/);
    expect(bad({ network: [{ host: "cdn.test" }] })).toThrow(/needs a reason/);
  });

  it("reads the known defects: a case, the reason, the date it was declared", () => {
    const read = readRouting({ known: [{ case: "MV-01", reason: " the design system throws ", since: "2026-11-14" }] });
    expect(read.known).toEqual([{ case: "MV-01", reason: "the design system throws", since: "2026-11-14" }]);
    expect(readRouting({ known: [{ case: "MV-01", reason: "r", since: "2026-11-14" }] }, "x", { cases: ["MV-01", "VAL-01"] }).known).toHaveLength(1);
  });

  it("names a bad known entry, and an id that matches no case of either suite", () => {
    const entry = { case: "MV-01", reason: "r", since: "2026-11-14" };
    const bad = (known: unknown, cases?: string[]) => () => readRouting({ known }, "x/binding-check.json", cases ? { cases } : {});
    expect(bad([{ reason: "r", since: "2026-11-14" }])).toThrow(/x\/binding-check\.json: known\[0\] must be/);
    expect(bad([{ case: "MV-01", since: "2026-11-14" }])).toThrow(/known\[0\] \(MV-01\) needs a reason/);
    expect(bad([{ case: "MV-01", reason: "r" }])).toThrow(/known\[0\] \(MV-01\) needs "since"/);
    expect(bad([{ ...entry, since: "yesterday" }])).toThrow(/needs "since"/);
    expect(bad([entry, entry])).toThrow(/MV-01 is listed twice/);
    expect(bad([entry], ["VAL-01"])).toThrow(/known\[0\]: MV-01 matches no case of the behaviour suite or the conformance suite/);
  });
});
