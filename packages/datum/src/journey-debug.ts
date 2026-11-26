import type { FormDefinition } from "@argusvane/datum-engine";

import { reportError } from "./support.js";

/** The engine's `diagnoseJourneys`, named by type alone: a value import would bundle it. */
export type DiagnoseJourneys = typeof import("@argusvane/datum-engine").diagnoseJourneys;

/** One load of the diagnostics chunk per page, shared by every element and by the page. */
let diagnosticsLoad: Promise<DiagnoseJourneys> | undefined;

/** What the chunk answered, once it has. */
let loaded: DiagnoseJourneys | undefined;

/**
 * `diagnoseJourneys`, loaded on demand: what `<datum-form debug>` runs, and what a
 * page runs over a definition itself. It lives in a chunk of its own beside the bundle
 * (`journey-diagnostics.ts`) rather than in it, since only an author checking a form needs
 * it; the engine's `diagnoseJourneys` is the same function for code that bundles the engine.
 */
export function loadJourneyDiagnostics(): Promise<DiagnoseJourneys> {
  if (!diagnosticsLoad) {
    const load = import("./journey-diagnostics.js").then((module) => {
      loaded = module.diagnoseJourneys;
      return module.diagnoseJourneys;
    });
    // A failed load (the chunk missing from the page's copy of the bundles) is tried again next time.
    load.catch(() => {
      if (diagnosticsLoad === load) {
        diagnosticsLoad = undefined;
      }
    });
    diagnosticsLoad = load;
  }
  return diagnosticsLoad;
}

/** `diagnoseJourneys` when its chunk has already arrived on this page, else `undefined` (never loading, never failing). */
export function journeyDiagnosticsLoaded(): DiagnoseJourneys | undefined {
  return loaded;
}

/** Definitions whose journeys `debug` has diagnosed: once per definition object per page. */
const diagnosedDefinitions = new WeakSet<FormDefinition>();

/**
 * What `diagnoseJourneys` finds about a definition's journeys, logged as
 * errors with `console.error` and warnings with `console.warn`, each line naming the element, the journey and where in it. The definition
 * is marked at once, before the diagnostics have loaded, so a rebuild meanwhile logs nothing twice.
 */
export function reportJourneyDiagnostics(host: HTMLElement, definition: FormDefinition): void {
  if (diagnosedDefinitions.has(definition)) {
    return;
  }
  diagnosedDefinitions.add(definition);
  const tag = host.tagName.toLowerCase();
  loadJourneyDiagnostics().then(
    (diagnoseJourneys) => {
      let findings: ReturnType<DiagnoseJourneys>;
      try {
        findings = diagnoseJourneys(definition);
      } catch (error) {
        // Off the element's own path now, so a throw is reported rather than left unhandled.
        reportError(host, "journey.diagnostics-failed", "The journey diagnostics could not run", error);
        return;
      }
      for (const finding of findings) {
        const where = [
          `journey "${finding.journeyId}"`,
          ...(finding.pageId !== undefined ? [`page "${finding.pageId}"`] : []),
          ...(finding.routeIndex !== undefined ? [`route ${finding.routeIndex + 1}`] : []),
          ...(finding.componentId !== undefined ? [`component "${finding.componentId}"`] : [])
        ].join(", ");
        const line = `[${tag}] ${where} (${finding.code}): ${finding.message}`;
        if (finding.severity === "error") {
          console.error(line);
        } else {
          console.warn(line);
        }
      }
    },
    (error: unknown) => {
      // Not diagnosed after all: a later rebuild under `debug` tries again.
      diagnosedDefinitions.delete(definition);
      reportError(host, "file.unavailable", "The journey diagnostics could not be loaded", error);
    }
  );
}
