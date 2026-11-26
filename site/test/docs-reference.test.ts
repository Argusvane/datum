import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const reference = JSON.parse(read("../docs/reference/attributes.json")) as { methods: Record<string, string[]> };

describe("the docs site's element reference", () => {
  it("has tables as the elements' own attribute list gives them", () => {
    // Exits 1 and names the stale partial when docs/_generated is behind attributes.json.
    execFileSync(process.execPath, ["scripts/gen-docs-reference.mjs", "--check"], { cwd: new URL("..", import.meta.url), stdio: "pipe" });
  });

  it("names every method of the form and the builder on its page", () => {
    for (const [element, page] of [["datum-form", "docs/form-element.md"], ["datum-form-builder", "docs/builder-element.md"]] as const) {
      const text = read(page);
      for (const method of reference.methods[element] ?? []) {
        expect(text, `${page}: ${method}`).toContain(`\`${method.replace(/\(\)$/, "")}(`);
      }
    }
  });
});

describe("the docs site's pages", () => {
  const pages = readdirSync(new URL("../docs", import.meta.url)).filter((name) => name.endsWith(".md"));
  const config = read("docs/.vitepress/config.ts");

  it("puts every page in the sidebar, and every sidebar entry on a page", () => {
    const linked = [...config.matchAll(/link: "\/([\w-]+)"/g)].map((match) => match[1]);
    for (const page of pages.filter((name) => name !== "index.md")) {
      expect(linked, page).toContain(page.replace(/\.md$/, ""));
    }
    for (const link of linked) expect(existsSync(new URL(`../docs/${link}.md`, import.meta.url)), link).toBe(true);
  });

  it("links only to pages that exist, and keeps the site's content rules", () => {
    for (const page of pages) {
      const text = read(`docs/${page}`);
      for (const match of text.matchAll(/\]\(\/([\w-]+)(?:#[\w-]+)?\)/g)) {
        expect(existsSync(new URL(`../docs/${match[1]}.md`, import.meta.url)), `${page}: /${match[1]}`).toBe(true);
      }
      expect(text, page).not.toMatch(/QuickJS/i);
      expect(text, page).not.toMatch(/\bADR\b/);
    }
  });

  // The id VitePress gives a heading: its text without marks, lower case, every run of spaces and
  // punctuation one hyphen (so "page's" is "page-s"), and an underscore before a leading digit.
  const slug = (heading: string): string =>
    heading
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/<[^>]+>/g, "")
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[\s~`!@#$%^&*()\-_+=[\]{}|\\;:"'“”‘’<>,.?/]+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/^(\d)/, "_$1")
      .toLowerCase();

  /** A page as VitePress reads it: its included partials in place, its code blocks gone. */
  const prose = (page: string): string =>
    read(`docs/${page}`)
      .replace(/<!--\s*@include:\s*\.\/(\S+?)\s*-->/g, (_, part: string) => read(`docs/${part}`))
      .replace(/^(```|~~~)[\s\S]*?^\1.*$/gm, "");

  const anchorsOf = (page: string): Set<string> => {
    const text = prose(page);
    const anchors = new Set<string>();
    const seen = new Map<string, number>();
    for (const [, heading] of text.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)) {
      const custom = /\s*\{#([\w-]+)\}$/.exec(heading!);
      const id = custom ? custom[1]! : slug(heading!);
      // A second heading of the same words gets a number after it.
      const count = seen.get(id) ?? 0;
      seen.set(id, count + 1);
      anchors.add(count === 0 ? id : `${id}-${count}`);
    }
    for (const [, id] of text.matchAll(/\bid="([^"]+)"/g)) anchors.add(id!);
    return anchors;
  };

  it("links only to headings that exist", () => {
    const anchors = new Map(pages.map((page) => [page.replace(/\.md$/, ""), anchorsOf(page)]));
    const broken: string[] = [];
    for (const page of pages) {
      const name = page.replace(/\.md$/, "");
      for (const [link, target, anchor] of prose(page).matchAll(/\]\((?:\/([\w-]+))?#([^)\s]+)\)/g)) {
        if (!anchors.get(target ?? name)?.has(anchor!)) broken.push(`${page}: ${link}`);
      }
    }
    expect(broken, broken.join("\n")).toEqual([]);
  });
});

describe("what a reader copies from the docs", () => {
  // deliver() posts the document and the attempt's key as { document, submissionKey }, the body the
  // receiving service keeps one record for.
  it("posts { document, submissionKey } from the getting-started walkthrough", () => {
    const page = read("docs/getting-started.md");
    expect(page).toContain("detail.waitUntil(deliver(detail));");
    const start = page.indexOf("async function deliver(detail)");
    expect(start).toBeGreaterThan(-1);
    const body = page.slice(page.indexOf("body: JSON.stringify(", start), page.indexOf("});", start));
    expect(body).toContain("document: detail.signed ?? detail.submission");
    expect(body).toContain("submissionKey: detail.submissionKey");
  });

  it("names the interface versions the programs speak today", () => {
    const constant = (path: string, name: string): string => {
      const match = new RegExp(`export const ${name} = "([0-9.]+)"`).exec(read(`../engine/form-engine/${path}`));
      if (!match) throw new Error(`${name} not found in ${path}`);
      return match[1]!;
    };
    const page = read("docs/server-programs.md");
    expect(page).toContain(`| Sandbox | ${constant("validation/wasm/wasm-validation-host.ts", "WASM_ABI_VERSION")} |`);
    expect(page).toContain(`| PDF | ${constant("render/pdf/pdf-abi.ts", "PDF_ABI_VERSION")} |`);
  });

  // The server examples check the engine file's hash before compiling it, so each carries the
  // release and its SHA-256: the ones the hosts pin, or an example refuses the file its own first
  // lines say to fetch.
  it("pins the engine in the server examples as the hosts pin it", () => {
    const pin = JSON.parse(read("../integrations/fastapi/packages/argusvane-datum-qjs-wasm/src/datum_qjs_wasm/runtime.json")) as { qjsVersion: string; sha256: string };
    const endpoints = ["validate", "pdf", "fill", "sign"].flatMap((folder) => ["main.py", "Program.cs", "main.mjs", "Application.java"].map((file) => `${folder}/${file}`));
    for (const file of endpoints) {
      const releases = [...read(`docs/snippets/server/${file}`).matchAll(/releases\/download\/v([\d.]+)\//g)].map((match) => match[1]);
      expect(releases, file).toEqual([pin.qjsVersion]);
    }
    for (const file of ["shared/qjs.mjs", "shared/pom.xml", ...endpoints.filter((name) => /\.(py|cs)$/.test(name))]) {
      expect(read(`docs/snippets/server/${file}`).match(/\b[0-9a-f]{64}\b/g), file).toEqual([pin.sha256]);
    }
  });
});
