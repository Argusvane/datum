import { describe, expect, it } from "vitest";
import { DEFAULT_EXAMPLE_ID, examples } from "../src/demo-forms";
// The engine's own journey checks, read from its sources. The site has no dependency on the
// engine, but its examples run on it: the journey example is held to what the
// builder would say of it, and to the paths the runtime would take.
import type { ComponentNode, FormDefinition } from "../../engine/form-engine/core/schema/types";
import { readJourneys, type Journey } from "../../engine/form-engine/core/schema/journey";
import { diagnoseJourney, diagnoseJourneys } from "../../engine/form-engine/core/journey/journey-diagnostics";
import { journeyOwnership, journeyPath } from "../../engine/form-engine/core/journey/journey-path";
import { evaluateExpression } from "../../engine/form-engine/rules/evaluator/evaluator";
// And the browser runtime and the server's kernel, so the presentations are held to what a
// person filling them would get: a submission, judged on both sides.
import { SubmissionModeRegistry } from "../../engine/form-engine/core/submission/submission-modes";
import { FormRuntime, compileFormDefinition } from "../../engine/form-engine/runtime/browser/form-runtime";
import { createFieldConstraintsStage } from "../../engine/form-engine/validation/core/field-constraints";
import { ValidationPipeline } from "../../engine/form-engine/validation/core/validation-pipeline";
import { runKernel } from "../../engine/form-engine/validation/wasm/portable-kernel";
import { formulaFunctionSignatures } from "../../engine/form-engine/core/expressions/function-table";
import { journeyFromTree, treeFromJourney } from "../../engine/form-engine/builder/journey-designer/journey-tree";
import { addressOf, isStale, readTranslation, type FormTranslations } from "../../engine/form-engine/core/localization/translations";

type Definition = { id: string; root: ComponentNode; journey?: unknown; translations?: unknown; localization?: { supportedLocales?: Array<{ code: string }> } };

/** Every localized text in a value: the objects with a `default` string. */
function localizedTexts(value: unknown, at = "", out: Array<{ at: string; text: Record<string, unknown> }> = []): Array<{ at: string; text: Record<string, unknown> }> {
  if (Array.isArray(value)) {
    value.forEach((item, index) => localizedTexts(item, `${at}[${index}]`, out));
  } else if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.default === "string") {
      out.push({ at, text: record });
    } else {
      for (const [key, item] of Object.entries(record)) localizedTexts(item, at ? `${at}.${key}` : key, out);
    }
  }
  return out;
}

/** The nodes with a label string, found through the slots (the root's own tree). */
function labelledNodes(node: unknown, out: Array<{ id: string }> = []): Array<{ id: string }> {
  if (node !== null && typeof node === "object") {
    const record = node as Record<string, unknown>;
    const configuration = record.configuration as Record<string, unknown> | undefined;
    if (typeof record.id === "string" && typeof configuration?.label === "string") out.push({ id: record.id });
    const slots = record.children as Record<string, unknown> | undefined;
    for (const list of Object.values(slots ?? {})) {
      if (Array.isArray(list)) list.forEach((child) => labelledNodes(child, out));
    }
  }
  return out;
}

describe("demo forms", () => {
  it("lists every example once, numbered in the picker's order", () => {
    const ids = examples.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(DEFAULT_EXAMPLE_ID);
    examples.forEach((entry, index) => expect(entry.label.startsWith(`${index + 1}. `), entry.label).toBe(true));
    const formIds = examples.map((entry) => (entry.definition as Definition).id);
    expect(new Set(formIds).size).toBe(formIds.length);
  });

  it("words every label in English and in French", () => {
    for (const entry of examples) {
      const definition = entry.definition as Definition;
      expect(definition.localization?.supportedLocales?.map((locale) => locale.code), entry.id).toEqual(["en", "fr-CA"]);
      // The definition's own texts are strings; the French is its translations map.
      const french = (definition.translations as Record<string, Record<string, unknown>> | undefined)?.["fr-CA"];
      const labelled = labelledNodes(definition.root);
      expect(labelled.length, entry.id).toBeGreaterThan(0);
      for (const node of labelled) {
        const components = french?.components as Record<string, Record<string, { text?: unknown }>> | undefined;
        const text = components?.[node.id]?.label?.text;
        expect(typeof text === "string" && text !== "", `${entry.id}: ${node.id}`).toBe(true);
      }
    }
  });

  it("words the journey's error summary heading as the packages/datum journey demo does, in both languages", () => {
    const rebate = examples.find((entry) => entry.id === "rebate");
    expect(rebate?.texts?.summaryHeading).toEqual({ default: "There is a problem", locales: { "fr-CA": "Il y a un problème" } });
    for (const entry of examples) {
      for (const { at, text } of localizedTexts(entry.texts ?? {})) {
        const french = (text.locales as Record<string, unknown> | undefined)?.["fr-CA"];
        expect(typeof french === "string" && french !== "", `${entry.id}: texts.${at}`).toBe(true);
      }
    }
  });

  describe("the two journeys, one of them on a single page", () => {
    const entry = examples.find((example) => (example.definition as Definition).journey !== undefined);
    const definition = entry?.definition as Definition;
    const presentations = readJourneys(definition);
    const journey = presentations.find((candidate) => candidate.id === "eligibility");
    const onePage = presentations.find((candidate) => candidate.id === "quick");
    const envelope = {
      form: { id: "energy-rebate", version: "1.0.0" },
      client: { runtimeVersion: "1.0.0", rendererVersion: "1.0.0", schemaVersion: "1" }
    };

    /** The form in a runtime as the element builds it for a page: field checks in the browser, one submit mode. */
    const runtimeFor = (choice?: string): FormRuntime => {
      const modes = new SubmissionModeRegistry();
      modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
      const form = definition as unknown as FormDefinition;
      return new FormRuntime(form, {
        submissionModes: modes,
        validationPipeline: new ValidationPipeline([createFieldConstraintsStage(form.root)]),
        ...(choice !== undefined ? { journey: choice } : {})
      });
    };
    const ownKeys = (values: Record<string, unknown> | undefined): string[] => Object.keys(values ?? {}).filter((key) => key.startsWith("@"));

    it("is an example: a journey first, so the form opens as it, then one on a single page with its heading hidden, both read whole by the engine", () => {
      expect(entry?.id).toBe("rebate");
      expect(presentations.map((candidate) => [candidate.id, candidate.pages.length, candidate.heading])).toEqual([
        ["eligibility", 6, undefined],
        ["quick", 1, "hidden"]
      ]);
      expect(journey?.pages.map((page) => page.id)).toEqual(["home", "ownership", "landlord", "work", "contact", "ineligible"]);
      expect(onePage?.pages.map((page) => page.id)).toEqual(["everything"]);
    });

    it("words the journeys' and the pages' texts as strings, their French under translations at the journey addresses", () => {
      const translations = definition.translations as FormTranslations;
      expect(journey?.texts).toEqual({ back: "Back", continue: "Continue", pageOf: "Step {{n}} of {{total}}" });
      for (const presentation of presentations) {
        for (const [key, value] of Object.entries(presentation.texts ?? {})) {
          expect(typeof value, `${presentation.id}.texts.${key}`).toBe("string");
          const entry = readTranslation(translations, "fr-CA", { kind: "journeys", owner: presentation.id, path: ["texts", key] });
          expect(entry?.text, `${presentation.id}.texts.${key}`).toBeTruthy();
          expect(isStale(entry!, value), `${presentation.id}.texts.${key} is current`).toBe(false);
        }
        for (const page of presentation.pages) {
          for (const [key, value] of Object.entries(page.texts ?? {})) {
            expect(typeof value, `${presentation.id}.${page.id}.texts.${key}`).toBe("string");
            const entry = readTranslation(translations, "fr-CA", { kind: "journeys", owner: presentation.id, path: ["pages", page.id, "texts", key] });
            expect(entry?.text, `${presentation.id}.${page.id}.texts.${key}`).toBeTruthy();
          }
        }
      }
      expect(readTranslation(translations, "fr-CA", addressOf.journey("eligibility", "name"))?.text).toBe("Vérifier et demander");
    });

    it("has nothing the builder would flag, in either presentation", () => {
      expect(diagnoseJourneys(definition)).toEqual([]);
      for (const presentation of presentations) {
        expect(diagnoseJourney(definition.root, presentation), presentation.id).toEqual([]);
      }
    });

    it("opens in the builder's Journeys mode and is written back exactly as it was", () => {
      const formIds: string[] = [];
      const collect = (node: ComponentNode): void => {
        formIds.push(node.id);
        for (const children of Object.values(node.children ?? {})) children.forEach(collect);
      };
      collect(definition.root);
      for (const presentation of presentations) {
        const options = { formIds, pageIds: new Map<string, string>(), routeLinks: new Map<string, string>(), references: new Map<string, Record<string, unknown>>() };
        const problems: string[][] = [];
        const written = journeyFromTree(treeFromJourney(presentation, options), presentation.id, { ...options, onError: (found) => problems.push(found) });
        expect(problems, presentation.id).toEqual([]);
        expect(written, presentation.id).toEqual(presentation);
      }
    });

    it("asks the cost and the email its own way in the journey: a worked-out value and an alias", () => {
      const ownNodes = (journey?.pages ?? []).flatMap((page) => (page.components ?? []).filter((listed) => typeof listed === "object")) as Array<{ id: string; type: string; configuration: Record<string, unknown> }>;
      expect(ownNodes.map((node) => node.id)).toEqual(["equipment", "installation", "costTotal", "decisionEmail"]);
      expect(ownNodes.find((node) => node.type === "journey-value")?.configuration.to).toBe("cost");
      expect(ownNodes.find((node) => node.id === "decisionEmail")?.configuration.fills).toBe("email");
      // The one-page journey reuses the form's own fields alone.
      expect(onePage?.pages[0]?.components?.every((listed) => typeof listed === "string")).toBe(true);
    });

    it("branches on the answers and stops at the exit page", () => {
      // The path reads the compiled copy: its routes' formulas as trees.
      const compiled = readJourneys(compileFormDefinition(definition as unknown as FormDefinition).definition).find((candidate) => candidate.id === "eligibility");
      if (!compiled) throw new Error("no journey");
      const ownership = journeyOwnership(definition.root, compiled);
      const walk = (values: Record<string, unknown>) =>
        journeyPath(compiled, { values, ownership, evaluate: (expression, view) => evaluateExpression(expression, { values: view }) });

      // Nothing answered yet: an owner's path, four questions pages.
      expect(walk({})).toMatchObject({ pages: ["home", "ownership", "work", "contact"], end: "end" });
      expect(walk({ mainHome: "yes", tenure: "own" })).toMatchObject({ pages: ["home", "ownership", "work", "contact"], end: "end" });
      // Renting adds the landlord's page.
      expect(walk({ mainHome: "yes", tenure: "rent" })).toMatchObject({ pages: ["home", "ownership", "landlord", "work", "contact"], end: "end" });
      // Not the home they live in: the exit page, whatever the later pages still hold.
      expect(walk({ mainHome: "no", tenure: "rent", upgrade: "heatPump" })).toMatchObject({ pages: ["home", "ineligible"], end: "exit" });
    });

    it("submits through the one-page journey, asking a renter for the landlord and an owner not", async () => {
      const runtime = runtimeFor("quick");
      expect(runtime.journeyView()).toMatchObject({ journeyId: "quick", pageId: "everything", final: true });
      for (const [key, value] of Object.entries({ mainHome: "yes", tenure: "rent", upgrade: "heatPump", cost: 8000, fullName: "Ada Lovelace", email: "ada@example.org" })) {
        runtime.setValue(key, value);
      }
      // A renter: the landlord's questions show on the page, and the form requires them.
      const renter = await runtime.submit("submit", envelope);
      expect(renter.accepted).toBe(false);
      expect(renter.errors.map((error) => `${error.componentId}:${error.code}`).sort()).toEqual(["landlordConsent:required", "landlordName:required"]);

      // An owner: the same page without them, and the record sent is the form's.
      runtime.setValue("tenure", "own");
      const owner = await runtime.submit("submit", envelope);
      expect(owner.errors).toEqual([]);
      expect(owner.accepted).toBe(true);
      const submission = owner.canonicalSubmission?.submission;
      expect(submission?.journey).toEqual({ id: "quick" });
      expect(submission?.values).toEqual({ mainHome: "yes", tenure: "own", upgrade: "heatPump", cost: 8000, rebateAmount: 2000, fullName: "Ada Lovelace", email: "ada@example.org" });
    });

    it("submits through the journey: the alias fills the email, the cost is worked out, and its own amounts never leave the browser", async () => {
      const runtime = runtimeFor();
      // The form opens as its journey.
      expect(runtime.journeyView()).toMatchObject({ journeyId: "eligibility", pageId: "home" });
      runtime.setValue("mainHome", "yes");
      expect((await runtime.nextPage()).pageId).toBe("ownership");
      runtime.setValue("tenure", "own");
      expect((await runtime.nextPage()).pageId).toBe("work");

      // The page's own amounts, and the form's cost they add up to; the rebate follows it.
      runtime.setValue("upgrade", "heatPump");
      const equipment = runtime.presentationValuePathOf("equipment") as string;
      const installation = runtime.presentationValuePathOf("installation") as string;
      expect([equipment, installation]).toEqual(["@eligibility.equipment", "@eligibility.installation"]);
      runtime.setValue(equipment, 6000);
      runtime.setValue(installation, 2500);
      expect(runtime.formValues()).toMatchObject({ cost: 8500, rebateAmount: 2125 });
      expect((await runtime.nextPage()).pageId).toBe("contact");

      // The alias's answer is the form's email: no copy of its own.
      runtime.setValue("fullName", "Ada Lovelace");
      expect(runtime.presentationValuePathOf("decisionEmail")).toBe("email");
      runtime.setValue("email", "ada@example.org");

      const result = await runtime.submit("submit", envelope);
      expect(result.errors).toEqual([]);
      expect(result.accepted).toBe(true);
      const submission = result.canonicalSubmission?.submission;
      expect(submission?.journey).toEqual({ id: "eligibility" });
      expect(submission?.values).toEqual({ mainHome: "yes", tenure: "own", upgrade: "heatPump", cost: 8500, rebateAmount: 2125, fullName: "Ada Lovelace", email: "ada@example.org" });
      expect(ownKeys(submission?.values as Record<string, unknown>)).toEqual([]);
      expect(ownKeys(runtime.formValues())).toEqual([]);
      // Kept in the browser, by own id.
      expect(runtime.presentationValues()).toEqual({ equipment: 6000, installation: 2500 });

      // The server judges what was sent the same way, and says which answer the browser worked out.
      const outcome = runKernel(
        { formId: "energy-rebate", values: submission?.values as Record<string, unknown>, locale: "en", form: definition.root, journey: journey as Journey },
        [],
        // A host hands the kernel the built-in signatures (a bare call treats every function as unknown and refuses).
        undefined,
        formulaFunctionSignatures()
      );
      expect(outcome.errors).toEqual([]);
      expect(outcome.values).toEqual(submission?.values);
      expect(outcome.clientDerived).toContain("cost");
    });
  });
});
