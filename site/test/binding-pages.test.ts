import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error the spec is a plain module shared with the copy script
import { BINDING_ASSETS, NOT_SERVED_FONTS, PACKAGE_NOTICES, REFERENCE_BINDINGS } from "../scripts/binding-assets-spec.mjs";
// @ts-expect-error a plain module shared with the copy scripts
import { scanPublished } from "../scripts/published-scan.mjs";
import facts from "../src/binding-facts.json";
import { AXE_VERSION, datumNumbers, numbersOf, referenceBindings, scriptFile } from "../src/bindings";
import { NON_AFFILIATION, behaviourLine, cardEqualityLine, cardPicturesLine, conformanceLine, equalityLine, knownLines, networkCardLine, networkDetail, pageOf, sizeLine, snippet } from "../src/render-bindings";

// The binding pages: Datum's own theme beside the eight reference bindings. What they print is what
// kit:check measured (src/binding-facts.json), held here to the packages so it cannot drift; what
// they publish of each design system's files is held to the spec (scripts/binding-assets-spec.mjs);
// and what they say keeps the scope: one official theme, no accessibility claim for a design
// system's binding, GDS Transport never served.

const site = fileURLToPath(new URL("..", import.meta.url));
const root = join(site, "..");
const read = (path: string): string => readFileSync(join(site, path), "utf8");
const json = (path: string): any => JSON.parse(readFileSync(path, "utf8"));
const ids: string[] = REFERENCE_BINDINGS;

describe("binding pages", () => {
  it("has a page for every reference binding, Datum's own and the index, all in the build", () => {
    const config = read("vite.config.ts");
    for (const file of ["bindings.html", "binding-datum.html", ...ids.map((id) => `binding-${id}.html`)]) {
      expect(existsSync(join(site, file)), file).toBe(true);
      expect(config, file).toContain(`root + "${file}"`);
    }
    expect(referenceBindings.map((binding) => binding.id)).toEqual(ids);
  });

  it("gives each page the title and description its data states, and a container to fill", () => {
    for (const binding of referenceBindings) {
      const html = read(`binding-${binding.id}.html`);
      expect(html).toContain(`<title>Datum: bindings · ${binding.name}</title>`);
      expect(html).toContain(`data-binding-page="${binding.id}"`);
      const description = /<meta name="description" content="([^"]*)"/.exec(html)?.[1] ?? "";
      expect(description.replaceAll("&#x27;", "'")).toContain(binding.summary.replace(/\.$/, ""));
      expect(description).toContain("not an official Datum theme");
      expect(pageOf(binding.id)).toBe(`./binding-${binding.id}.html`);
    }
    expect(read("bindings.html")).toContain("data-binding-index");
    expect(read("binding-datum.html")).toContain('data-binding-page="datum"');
  });

  it("links every page's nav to the bindings, with the Developers entry standing for all of them", () => {
    for (const file of ["index.html", "features.html", "partners.html", "bindings.html", "binding-datum.html", ...ids.map((id) => `binding-${id}.html`)]) {
      expect(read(file), file).toContain('data-pages="bindings.html binding-*">Examples<');
    }
  });
});

describe("the measured numbers", () => {
  // Green means no failure in either suite. A case the binding declares known (a defect of the design system itself, `known` in
  // its binding-check.json) is counted apart from pass and fail, and is allowed only with its reason, which the page shows.
  it("covers Datum and each binding, from a green run", () => {
    expect(Object.keys(facts).sort()).toEqual(["datum", ...ids].sort());
    for (const id of ids) {
      const numbers = numbersOf(id);
      expect(numbers.equality.fail, id).toBe(0);
      expect(numbers.equality.pass, id).toBe(numbers.equality.tier1 + numbers.equality.tier2);
      expect(numbers.equality.tier1, id).toBeGreaterThan(0);
      expect(numbers.behaviour.fail, id).toBe(0);
      expect(numbers.conformance.fail, id).toBe(0);
      expect(numbers.conformance.pass, id).toBeGreaterThan(50);
      // Every case of the corpus is written (CNV-01 was the last pending one): a run that still reports one is stale.
      expect(numbers.conformance.pending, id).toBe(0);
      expect(numbers.gzipKb, id).toBeLessThanOrEqual(numbers.budgetKb);
      // Known cases: every one has a reason, the reasons are the ones counted, and the page words them.
      const defects = numbers.knownDefects ?? [];
      expect(defects.filter((defect) => defect.suite === "behaviour").length, id).toBe(numbers.behaviour.known ?? 0);
      expect(defects.filter((defect) => defect.suite === "conformance").length, id).toBe(numbers.conformance.known ?? 0);
      for (const defect of defects) expect(defect.reason.trim().length, `${id} ${defect.case}`).toBeGreaterThan(20);
      expect(knownLines(numbers).length, id).toBe(defects.length);
    }
    expect(datumNumbers.conformance.fail).toBe(0);
    expect(datumNumbers.conformance.pass).toBeGreaterThan(50);
    expect(datumNumbers.conformance.pending).toBe(0);
    // The page's note names no pending case, since none is.
    expect(read("src/render-bindings.ts")).not.toMatch(/pending case|not written yet/);
  });

  it("agrees with each package: release and size budget", () => {
    for (const id of ids) {
      const meta = json(join(root, "bindings", id, "package.json")).datumBinding;
      expect(numbersOf(id).release, id).toBe(meta.release);
      expect(numbersOf(id).budgetKb, id).toBe(meta.budgetKb);
    }
  });

  it("words them from the data", () => {
    const gcds = numbersOf("gcds");
    expect(equalityLine(gcds)).toBe(`${gcds.equality.pass} of ${gcds.equality.pass + gcds.equality.fail} cases (${gcds.equality.tier1} against the design system's own markup, ${gcds.equality.tier2} against the binding's own pictures)`);
    expect(sizeLine(gcds)).toBe(`${gcds.gzipKb} KB gzip of a ${gcds.budgetKb} KB budget`);
    const { pass, fail, skip, pending } = gcds.conformance;
    expect(conformanceLine(gcds)).toBe(`${pass} pass, ${fail} fail, ${skip} skipped, ${pending} pending`);
    expect(behaviourLine(gcds)).toBe(`${gcds.behaviour.pass} pass, 0 fail`);
  });

  it("shows a binding's known defects with their reasons beside the numbers, never as a pass", () => {
    const fluent = numbersOf("fluent");
    expect(fluent.behaviour).toEqual({ pass: 6, fail: 0, skip: 1, known: 2 });
    expect(behaviourLine(fluent)).toBe("6 pass, 0 fail, 2 known");
    expect(fluent.knownDefects?.map((defect) => defect.case)).toEqual(["MV-01", "MV-03"]);
    expect(knownLines(fluent)[0]).toMatch(/^MV-01 \(behaviour\): Fluent's own fluent-field throws/);
    expect(knownLines(numbersOf("gcds"))).toEqual([]);
    // The page prints the note and the list under the numbers.
    expect(read("src/render-bindings.ts")).toContain('top.append(el("p", "binding-note", KNOWN_NOTE), list(knownLinesOf))');
  });

  it("puts on the index card only the tier-1 cases as equality, and the tier-2 pictures in their own row", () => {
    for (const binding of referenceBindings) {
      const { tier1, tier1Pass, tier2, pass } = numbersOf(binding.id).equality;
      expect(tier1Pass, binding.id).toBeLessThanOrEqual(tier1);
      expect(tier1Pass, binding.id).toBeLessThanOrEqual(pass);
      expect(cardEqualityLine(binding.name, numbersOf(binding.id))).toBe(`${tier1Pass} of ${tier1} against ${binding.name} markup`);
      expect(cardPicturesLine(numbersOf(binding.id))).toBe(tier2 === 0 ? "None" : `${tier2} against the binding's own pictures`);
    }
    // GCDS has as many tier-2 pictures as tier-1 cases: the card says 12 of 12, not 24 of 24.
    expect(cardEqualityLine("GC Design System", numbersOf("gcds"))).toBe("12 of 12 against GC Design System markup");
    const source = read("src/render-bindings.ts");
    expect(source).not.toContain("${numbers.equality.pass} of ${numbers.equality.pass + numbers.equality.fail}");
  });
});

describe("the code the pages and the docs show", () => {
  it("makes the binding with bindings.fromFactory and names it by the binding property", () => {
    for (const binding of referenceBindings) {
      const code = snippet(binding);
      expect(code, binding.id).toContain("const binding = bindings.fromFactory(createBinding);");
      expect(code, binding.id).toContain("bindings.register(binding, {");
      expect(code, binding.id).toContain(`.binding = "${binding.id}";`);
      // binding is not an observed attribute of <datum-form>; lit and datum are not the host's to name; the package is not published.
      expect(code, binding.id).not.toMatch(/binding="/);
      expect(code, binding.id).not.toMatch(/createBinding\(lit/);
      expect(code, binding.id).not.toContain("@argusvane/datum-binding-");
      expect(code, binding.id).toContain("not published");
    }
    const docs = read("docs/bindings.md");
    expect(docs).toContain("bindings.fromFactory(createBinding)");
    expect(docs).toMatch(/\.binding = "gcds"/);
    expect(docs).not.toMatch(/<datum-form[^>]*\sbinding="/);
    expect(docs).not.toContain("@argusvane/datum-binding-");
    expect(docs).toContain("not published as packages");
  });

  it("loads each live demo's binding with datum-form.js's own fromFactory, never a second lit", () => {
    const source = read("src/render-bindings.ts");
    expect(source).toContain("form.bindings.register(form.bindings.fromFactory(module.createBinding), { assets })");
    expect(source).not.toMatch(/host\.iife|DatumBindingHost|createDatumBinding/);
    expect(read("scripts/copy-binding-assets.mjs")).not.toMatch(/host\.iife|binding-host-entry|esbuild/);
    expect(existsSync(join(site, "scripts", "binding-host-entry.ts"))).toBe(false);
  });
});

describe("the design-system files the pages publish", () => {
  const published = (path: string): string => path.replace(/^\//, "").replace(/^node_modules\//, "");

  it("covers every file a binding's binding-check.json names, and every host file the page lists", () => {
    for (const binding of referenceBindings) {
      const check = json(join(root, "bindings", binding.id, "binding-check.json"));
      const named: string[] = [...(check.stylesheets ?? []), ...(check.scripts ?? [])].map((item: string | { url: string }) => published(typeof item === "string" ? item : item.url));
      const spec = BINDING_ASSETS[binding.id];
      expect(spec, binding.id).toBeDefined();
      const covered = (file: string): boolean => spec.vendor.some((item: { from: string }) => file === published(item.from) || file.startsWith(`${published(item.from)}/`));
      for (const file of named) expect(covered(file), `${binding.id}: ${file}`).toBe(true);
      const names = named.map((file) => file.split("/").pop());
      for (const file of [...binding.host.stylesheets, ...binding.host.scripts.map(scriptFile)]) expect(names, `${binding.id}: ${file}`).toContain(file);
      // A classic script and the attributes its design system reads from its own element reach the snippet as binding-check.json gives them.
      for (const item of check.scripts ?? []) {
        const url = typeof item === "string" ? item : item.url;
        const listed = binding.host.scripts.find((script) => scriptFile(script) === url.split("/").pop());
        const classic = typeof item === "object" && item.classic === true;
        expect(typeof listed === "object" && listed.classic === true, `${binding.id}: ${url} classic`).toBe(classic);
        expect(Object.keys((typeof listed === "object" && listed.attributes) || {}).sort(), `${binding.id}: ${url} attributes`).toEqual(Object.keys((typeof item === "object" && item.attributes) || {}).sort());
        const code = snippet(binding);
        if (classic) expect(code, binding.id).toContain(`{ url: "/design-system/${scriptFile(listed!)}", classic: true`);
        for (const key of Object.keys((typeof item === "object" && item.attributes) || {})) expect(code, `${binding.id}: ${key}`).toContain(`"${key}": "/design-system`);
      }
      expect(binding.host.stylesheets.length + binding.host.scripts.length, binding.id).toBe(named.length);
    }
  });

  it("notices each package a binding page publishes, and no GC Design System font package: no page vendors one", () => {
    expect(PACKAGE_NOTICES["gcds-components-1.7.0"]).toContain("Not published");
    expect(Object.keys(PACKAGE_NOTICES)).not.toContain("gcds-fonts-1.1.1");
    for (const spec of Object.values(BINDING_ASSETS) as Array<{ notices: Record<string, string> }>) expect(Object.keys(spec.notices)).not.toContain("gcds-fonts-1.1.1");
  });

  it("never copies GDS Transport: the GOV.UK entry takes the stylesheet and one script, redacts the faces, and the page says the fallback", () => {
    expect(NOT_SERVED_FONTS.govuk).toBe("GDS Transport");
    const spec = BINDING_ASSETS.govuk;
    expect(spec.vendor.map((item: { from: string }) => item.from)).toEqual(["node_modules/govuk-frontend-6.6.0/dist/govuk/govuk-frontend.min.css", "node_modules/govuk-frontend-6.6.0/dist/govuk/all.bundle.js"]);
    expect(spec.redact.some(([, pattern]: [RegExp, RegExp]) => pattern.source.includes("GDS Transport"))).toBe(true);
    const page = referenceBindings.find((binding) => binding.id === "govuk")!;
    expect(page.notes.map((note) => note.text).join(" ")).toMatch(/GDS Transport[^.]*licensed for GOV\.UK services only[^]*Arial/);
    const css = readFileSync(join(root, "bindings", "govuk", "node_modules", "govuk-frontend-6.6.0", "dist", "govuk", "govuk-frontend.min.css"), "utf8");
    // The redaction patterns match the pinned release's stylesheet the number of times the spec expects.
    for (const [, pattern, , expected] of spec.redact as Array<[RegExp, RegExp, string, number]>) expect(css.match(pattern)?.length, String(pattern)).toBe(expected);
  });

  it("leaves no GDS Transport file, face or crest in what was copied", () => {
    const target = join(site, "public", "demo", "bindings");
    if (!existsSync(target)) return;
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else files.push(full.slice(target.length + 1));
      }
    };
    walk(target);
    expect(files.filter((file) => /gds[-_ ]?transport/i.test(file) || /(^|\/)(light|bold)-[0-9a-f]{10}-v\d\.woff2?$/.test(file))).toEqual([]);
    expect(files.filter((file) => file.startsWith("govuk/") && /\.(woff2?|ttf|otf|eot)$/.test(file))).toEqual([]);
    const css = readFileSync(join(target, "govuk", "files", "govuk-frontend-6.6.0", "dist", "govuk", "govuk-frontend.min.css"), "utf8");
    expect(css).not.toMatch(/GDS Transport["']?\s*[;},]?[^}]*src:/);
    expect(css).not.toContain("@font-face");
    expect(css).not.toContain("govuk-crest");
    // Every government mark the spec leaves out is absent.
    expect(files.filter((file) => /QUEBEC_(blanc|couleur)|ontario-logo|supergraphic|favicon/i.test(file))).toEqual([]);
    // The manifest points at files that exist.
    const manifest = json(join(target, "manifest.json")) as Record<string, { script: string; stylesheets: Array<{ url: string }>; scripts: Array<{ url: string }> }>;
    for (const [id, entry] of Object.entries(manifest)) {
      for (const url of [entry.script, ...entry.stylesheets.map((item) => item.url), ...entry.scripts.map((item) => item.url)]) {
        expect(existsSync(join(target, url)), `${id}: ${url}`).toBe(true);
      }
    }
    // Each package folder carries its notice.
    expect(files.some((file) => file.endsWith("NOTICE.txt") && file.startsWith("govuk/"))).toBe(true);
  });

  it("leaves nothing of the kind anywhere in public/demo/", () => {
    const target = join(site, "public", "demo");
    if (!existsSync(target)) return;
    expect(scanPublished(target)).toEqual([]);
  });

  it("scans for every mark and face the copies leave out, by name and by content", () => {
    const dir = mkdtempSync(join(tmpdir(), "datum-scan-"));
    const put = (path: string, text = ""): void => {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    };
    try {
      put("ds/govuk/govuk-frontend.min.css", "@font-face{font-family:GDS Transport;src:url(/assets/fonts/light-94a07e06a1-v2.woff2)}a{background:url(/assets/images/govuk-crest.svg)}");
      put("ds/govuk/assets/images/govuk-crest.svg");
      put("ds/govuk/assets/fonts/bold-b542beb274-v2.woff2");
      put("ds/quebec/img/QUEBEC_couleur.svg");
      put("ds/ontario-components/assets/ontario-logo--desktop.svg");
      put("ds/ontario-components/assets/footer-default-supergraphic-logo.svg");
      put("ds/uswds/img/favicons/favicon.ico");
      put("ds/gcds/p-1.entry.js", 'h("svg",{}),`<svg viewBox="0 0 1 1" aria-labelledby="signature-en-title">\\n<title id="signature-en-title">Government of Canada</title><path d="M0 0"/></svg>`');
      put("ds/alberta/index.js", "x='data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTE4IiBoZWlnaHQ9IjMyIiB2aWV3Qm94'");
      const found = scanPublished(dir).join("\n");
      for (const what of ["an @font-face rule for GDS Transport", "a reference to the GOV.UK crest", "the GOV.UK crest", "a GDS Transport face", "the Government of Québec signature", "a government's logo, favicon or supergraphic", "the Government of Canada signature or wordmark", "a Government of Alberta header logo"]) {
        expect(found, what).toContain(what);
      }
      // What the copies leave: the title without its artwork, the empty svg, a face that is not GDS Transport.
      rmSync(dir, { recursive: true, force: true });
      put("ds/gcds/p-1.entry.js", '`<svg viewBox="0 0 1 1" aria-labelledby="signature-en-title">\\n<title id="signature-en-title">Government of Canada</title></svg>`');
      put("ds/alberta/index.js", "x='data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4='");
      put("ds/govuk/govuk-frontend.min.css", "body{font-family:arial,sans-serif}");
      put("ds/uswds/fonts/public-sans/PublicSans-Bold.woff2");
      expect(scanPublished(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the words keep the scope", () => {
  const designSystems = /GC Design System|GCDS|GOV\.UK|USWDS|U\.S\. Web Design System|Bootstrap|Nova Scotia|Alberta|Ontario|Qu[eé]bec/i;
  const sentences = (text: string): string[] => text.split(/(?<=[.!?])\s+/);

  it("claims no accessibility for a design system's binding, in the copy, the pages or the docs", () => {
    // The words a visitor reads: string literals of the sources (not addresses), the text of the pages and the docs.
    const literals = (source: string): string[] => [...source.matchAll(/"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)].map((match) => match[1] ?? match[2] ?? "").filter((text) => !/^https?:/.test(text));
    const words = (html: string): string => html.replace(/<[^>]*>/g, " ");
    const sources = [...literals(read("src/pillars.ts")), ...literals(read("src/bindings.ts")), ...literals(read("src/render-bindings.ts")), read("docs/bindings.md"), words(read("features.html")), words(read("index.html"))];
    for (const text of sources) {
      for (const sentence of sentences(text)) {
        if (!designSystems.test(sentence) || !/accessib/i.test(sentence) || !/binding|theme|Datum/i.test(sentence)) continue;
        // The only sentences that name both are the ones that disclaim.
        expect(sentence, sentence).toMatch(/no accessibility claim|nothing about|not claim|authority for its own|keeps its own accessibility|never|no support promise/i);
      }
    }
  });

  it("says Datum ships one official theme and the bindings are references", () => {
    const index = read("src/render-bindings.ts");
    expect(index).toContain("Datum ships one official theme, its own.");
    expect(index).toContain("references, demos and starting points, with no support promise");
    expect(index).toContain("Datum claims nothing about their accessibility");
    const docs = read("docs/bindings.md");
    expect(docs).toContain("Datum ships one official look, its own.");
    expect(docs).toContain("Datum claims nothing about the accessibility of a design-system binding");
    // The pages print Conformance numbers; the docs say what the bindings do not claim, not that there is no conformance.
    expect(docs).not.toContain("no conformance claim");
    expect(docs).toContain("no accessibility claim. They pass Datum's integration checks");
  });

  it("names the features page's customization row for the look", () => {
    const features = read("features.html");
    expect(features).toContain("Customization &middot; look");
  });
});

describe("what a binding fetches, and whose it is", () => {
  const demoBindings = join(site, "public", "demo", "bindings");

  it("lists what each binding's files fetch from a third party, from the binding's own check where it has one", () => {
    for (const binding of referenceBindings) {
      const check = json(join(root, "bindings", binding.id, "binding-check.json"));
      const named: string[] = (check.network ?? []).map((entry: { host: string }) => entry.host);
      for (const host of named) expect(binding.network.map((entry) => entry.host), `${binding.id}: ${host}`).toContain(host);
      for (const entry of binding.network) expect(entry.reason.length, `${binding.id}: ${entry.host}`).toBeGreaterThan(10);
    }
    // The pages word it the same way: the hosts on the card, each with its reason on the page.
    const alberta = referenceBindings.find((binding) => binding.id === "alberta")!;
    expect(networkCardLine(alberta.network)).toContain("use.typekit.net");
    expect(networkCardLine([])).toBe("Nothing");
    expect(typeof networkDetail([])).toBe("string");
  });

  // The published copies are what a page loads: every address its stylesheets and scripts fetch is listed.
  // The folder is built by the copy script, so a checkout that never ran it has nothing to scan.
  (existsSync(demoBindings) ? it : it.skip)("lists every third-party host the published files fetch", () => {
    const walk = (folder: string): string[] => readdirSync(folder, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(folder, entry.name)) : [join(folder, entry.name)]));
    const patterns = [/@import\s*(?:url\()?['"]?(https?:\/\/[^'")\s;]+)/g, /url\(\s*['"]?(https?:\/\/[^'")\s]+)/g, /<script[^>]+src=["'](https?:\/\/[^"']+)/g, /<link[^>]+href=["'](https?:\/\/[^"']+)/g];
    for (const binding of referenceBindings) {
      const folder = join(demoBindings, binding.id);
      if (!existsSync(folder)) continue;
      const found = new Set<string>();
      for (const file of walk(folder).filter((name) => /\.(css|js|mjs|html)$/.test(name))) {
        const text = readFileSync(file, "utf8");
        for (const pattern of patterns) for (const match of text.matchAll(pattern)) found.add(new URL(match[1]!).host);
      }
      for (const host of found) expect(binding.network.map((entry) => entry.host), `${binding.id} fetches ${host}`).toContain(host);
    }
  });

  it("says on every binding page and on the index that Datum is not affiliated with or endorsed by the owners", () => {
    const code = read("src/render-bindings.ts");
    expect(NON_AFFILIATION).toBe("Datum is not affiliated with or endorsed by the owner of any design system named here.");
    expect(code).toContain("${NON_AFFILIATION}");
    expect(code).toContain("Datum is not affiliated with or endorsed by the design system's owner, ${binding.by}.");
    expect(code).toContain('["Design system by", binding.by]');
    expect(code).not.toContain("Published by");
    for (const binding of referenceBindings) {
      const readme = readFileSync(join(root, "bindings", binding.id, "README.md"), "utf8");
      expect(readme, binding.id).toMatch(/Datum is not affiliated with or endorsed by/);
    }
  });

  it("holds the axe version in the accessibility line to the baseline's, and says the checks are automated only", () => {
    const baseline = json(join(root, "packages", "datum", "a11y", "baseline", "browser.json"));
    expect(AXE_VERSION).toBe(baseline.axeVersion);
    const code = read("src/render-bindings.ts");
    expect(code).toContain("No automated findings (axe ${AXE_VERSION})");
    expect(code).toContain("Automated checks only");
  });
});
