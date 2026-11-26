// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * `datum-engine.js` (src/engine.ts): the runtime with no element. The entry is built here with the
 * package's own build settings (vite.config.ts, `--mode engine`) into a temp folder, then imported
 * by a plain `node` child with no jsdom and no DOM globals at all: what a server or a worker does.
 * The test runner's own environment is never the one judged, since vitest rewrites imports.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let out: string;

beforeAll(() => {
  out = mkdtempSync(join(tmpdir(), "datum-engine-entry-"));
  execFileSync(process.execPath, [join(root, "node_modules", "vite", "bin", "vite.js"), "build", "--mode", "engine", "--outDir", out, "--emptyOutDir", "--logLevel", "error"], {
    cwd: root,
    env: { ...process.env, DATUM_BUNDLE_FORMAT: "es" },
    stdio: "pipe"
  });
}, 120_000);

afterAll(() => {
  rmSync(out, { recursive: true, force: true });
});

/** Runs `script` as an ES module in a plain node process with the built entry's URL as `ENGINE`. */
function runInNode(script: string): string {
  const engine = pathToFileURL(join(out, "datum-engine.js")).href;
  return execFileSync(process.execPath, ["--input-type=module", "-e", `const ENGINE = ${JSON.stringify(engine)};\n${script}`], { encoding: "utf8", stdio: "pipe" });
}

describe("datum-engine.js", () => {
  it("is one file with no chunk, and names no DOM global", () => {
    // The server validator's refusal names the envelope ("No document to post to"), prose and
    // not a read of the global: the guard reads the file without it too (guards/17-engine-entry.mjs).
    const text = readFileSync(join(out, "datum-engine.js"), "utf8").split("No document to post to").join("");
    expect(text).not.toMatch(/\bimport\s*\(/);
    expect(text).not.toMatch(/^\s*import\s/m);
    for (const global of ["document", "window", "customElements", "HTMLElement"]) {
      expect(text, global).not.toMatch(new RegExp(`(?<![A-Za-z0-9_$."'])${global}(?![A-Za-z0-9_$"':])`));
    }
  });

  it("imports in plain Node and runs a form: answer, validate, submit, the envelope, the event names", () => {
    const output = runInNode(`
      for (const name of ["window", "document", "customElements", "HTMLElement"]) {
        if (name in globalThis) throw new Error(name + " is defined in this node");
      }
      const engine = await import(ENGINE);
      const { createFormRuntime, versionContextFor, EMBED_SUBMISSION_MODE, FormEventType, serializeDraftFile, parseDraftFile, plainHostContext } = engine;
      const definition = {
        id: "visit-request", version: "1.0.0", schemaVersion: "1",
        root: { id: "root", type: "form", configuration: {}, children: { content: [
          { id: "fullName", type: "text", configuration: { label: "Full name", required: true } },
          { id: "badge", type: "text", configuration: { required: true }, rules: { visibleWhen: 'host.role = "staff"' } }
        ] } }
      };
      let saved;
      const draftStore = { save: async (draft) => { saved = draft; }, load: async () => saved, list: async () => [], delete: async () => {} };
      const runtime = createFormRuntime(definition, { hostContext: plainHostContext({ role: "visitor" }).context, draftStore });
      const changed = [];
      runtime.events().subscribe(FormEventType.COMPONENT_CHANGED, (event) => changed.push(event.data.value));
      const strings = [];
      runtime.events().subscribe("COMPONENT_CHANGED", (event) => strings.push(event.data.value));
      const badgeHidden = runtime.effectiveState("badge").visible === false;
      const before = (await runtime.validate()).map((error) => error.componentId + ":" + error.code);
      runtime.setValue("fullName", "Ada Lovelace");
      const after = (await runtime.validate()).length;
      const result = await runtime.submit(EMBED_SUBMISSION_MODE, versionContextFor(definition));
      await runtime.saveDraft();
      const draft = parseDraftFile(serializeDraftFile(saved));
      console.log(JSON.stringify({
        exports: ["mountLive", "DatumFormElement", "defineDatumFormElement", "bindings", "renderPdf"].filter((name) => name in engine),
        eventName: FormEventType.COMPONENT_CHANGED,
        badgeHidden, before, after, changed, strings,
        accepted: result.accepted,
        submission: result.canonicalSubmission.submission,
        key: typeof result.submissionKey,
        draft: draft.values
      }));
    `);
    const report = JSON.parse(output.trim().split("\n").pop()!) as Record<string, unknown>;
    expect(report).toMatchObject({
      exports: [],
      eventName: "COMPONENT_CHANGED",
      badgeHidden: true,
      before: ["fullName:required"],
      after: 0,
      changed: ["Ada Lovelace"],
      strings: ["Ada Lovelace"],
      accepted: true,
      submission: { locale: "en", values: { fullName: "Ada Lovelace" } },
      key: "string",
      draft: { fullName: "Ada Lovelace" }
    });
  });

  // The journeys runtime is in the file: no chunk to load, and no console notice that
  // a journey form runs as one page. Every setting the walk depends on is written out, the page
  // validation included, since the journey's own default is not this test's subject.
  it("walks a journey in plain Node: pages, a blocked and an accepted Continue, a route, a skipped page, Back, the end check, submit", () => {
    const output = runInNode(`
      const warnings = [];
      const warn = console.warn;
      console.warn = (...args) => warnings.push(args.map(String).join(" "));
      const engine = await import(ENGINE);
      const { createFormRuntime, versionContextFor, EMBED_SUBMISSION_MODE, FormEventType, JOURNEY_END, EagerJourneyEngine, createFetchJourneyValidator, JourneyValidationHttpError } = engine;
      const definition = {
        id: "benefit-check", version: "2.0.0", schemaVersion: "1",
        root: { id: "root", type: "form", configuration: { title: "Benefit check" }, children: { content: [
          { id: "fullName", type: "text", configuration: { label: "Full name", required: true } },
          { id: "children", type: "number", configuration: { label: "Children at home", required: true, min: 0 } },
          { id: "childNames", type: "text", configuration: { label: "Their names", required: true } },
          { id: "email", type: "text", configuration: { label: "Email", required: true } }
        ] } },
        journey: { defaultJourneyId: "apply", journeys: [{
          id: "apply",
          validation: { continue: "page", end: "client", onUnavailable: "block" },
          pages: [
            { id: "you", title: "About you", components: ["fullName", "children"], validation: { continue: "page", server: true },
              routes: [{ when: "children > 0", to: "kids" }, { to: "contact" }] },
            { id: "kids", title: "Your children", components: ["childNames"], validation: { continue: "page" } },
            { id: "contact", title: "Contact", components: ["email"], validation: { continue: "page" }, routes: [{ to: JOURNEY_END }] }
          ]
        }] }
      };
      const calls = [];
      const journeyServerValidator = async (request, options) => {
        calls.push({ scope: request.scope, pageId: request.pageId, journeyId: request.journeyId, formId: request.formId, values: request.values,
          document: options && options.document ? { formId: options.document.versionContext.form.id, journey: options.document.submission.journey, values: options.document.submission.values } : null,
          signal: options !== undefined && options.signal !== undefined });
        return { errors: [] };
      };
      const runtime = createFormRuntime(definition, { journeyServerValidator });
      const moves = [];
      runtime.events().subscribe(FormEventType.PAGE_CHANGED, (event) => moves.push(event.data.direction + ":" + event.data.toPageId));
      const page = () => runtime.journeyView()?.pageId;
      const first = { pageId: page(), state: runtime.state().journey?.pageId, path: runtime.journeyView()?.path, final: runtime.journeyView()?.final };

      const blocked = await runtime.nextPage();
      const blockedErrors = runtime.errors().map((error) => error.componentId + ":" + error.code).sort();
      const callsAfterBlocked = calls.length;

      runtime.setValue("fullName", "Ada Lovelace");
      runtime.setValue("children", 0);
      const skipping = await runtime.nextPage();
      const skippedPath = runtime.journeyTrace()?.pages;

      const back = await runtime.previousPage();
      const backAt = page();
      runtime.setValue("children", 2);
      const routed = await runtime.nextPage();
      const routedPath = runtime.journeyTrace()?.pages;
      runtime.setValue("childNames", "Ann, Ben");
      const toContact = await runtime.nextPage();
      const final = runtime.journeyView()?.final;
      const atEnd = await runtime.nextPage();

      const refused = await runtime.submit(EMBED_SUBMISSION_MODE, versionContextFor(definition));
      const refusedErrors = refused.accepted ? [] : (refused.errors ?? runtime.errors()).map((error) => error.componentId + ":" + error.code);
      runtime.setValue("email", "ada@example.org");
      const result = await runtime.submit(EMBED_SUBMISSION_MODE, versionContextFor(definition));

      console.warn = warn;
      console.log(JSON.stringify({
        engineName: EagerJourneyEngine.name,
        fetchValidator: typeof createFetchJourneyValidator, httpError: typeof JourneyValidationHttpError,
        journeys: runtime.journeys().map((journey) => journey.id),
        first,
        blocked, blockedErrors, callsAfterBlocked,
        skipping, skippedPath,
        back, backAt,
        routed, routedPath,
        toContact, final, atEnd,
        refusedAccepted: refused.accepted, refusedErrors,
        accepted: result.accepted,
        submission: result.canonicalSubmission && result.canonicalSubmission.submission,
        moves, calls, warnings
      }));
    `);
    const report = JSON.parse(output.trim().split("\n").pop()!) as Record<string, unknown>;
    expect(report).toMatchObject({
      engineName: "datum-journey-engine-eager",
      fetchValidator: "function",
      httpError: "function",
      journeys: ["apply"],
      first: { pageId: "you", state: "you", final: false },
      blocked: { ok: false, pageId: "you", reason: "validation" },
      blockedErrors: ["children:required", "fullName:required"],
      callsAfterBlocked: 0,
      // children = 0: the second route, past the children's page.
      skipping: { ok: true, pageId: "contact" },
      skippedPath: ["you", "contact"],
      back: { ok: true, pageId: "you" },
      backAt: "you",
      // children > 0: the first route.
      routed: { ok: true, pageId: "kids" },
      routedPath: ["you", "kids", "contact"],
      toContact: { ok: true, pageId: "contact" },
      final: true,
      atEnd: { ok: false, reason: "at-end" },
      refusedAccepted: false,
      refusedErrors: ["email:required"],
      accepted: true,
      submission: {
        journey: { id: "apply" },
        values: { fullName: "Ada Lovelace", children: 2, childNames: "Ann, Ben", email: "ada@example.org" }
      },
      moves: ["forward:contact", "back:you", "forward:kids", "forward:contact"],
      warnings: []
    });
    // The page's server check ran on each Continue from "you" that passed the page's own checks,
    // with the page request and the envelope over the same answers.
    expect(report.calls).toEqual([
      {
        scope: "page",
        pageId: "you",
        journeyId: "apply",
        formId: "benefit-check",
        values: { fullName: "Ada Lovelace", children: 0 },
        document: { formId: "benefit-check", journey: { id: "apply" }, values: { fullName: "Ada Lovelace", children: 0 } },
        signal: true
      },
      {
        scope: "page",
        pageId: "you",
        journeyId: "apply",
        formId: "benefit-check",
        values: { fullName: "Ada Lovelace", children: 2 },
        document: { formId: "benefit-check", journey: { id: "apply" }, values: { fullName: "Ada Lovelace", children: 2 } },
        signal: true
      }
    ]);
  });
});
