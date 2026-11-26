import type { ComponentNode } from "../../core/schema/types.js";
import {
  findJourney,
  journeyEndValidation,
  journeyPageKind,
  journeyPageValidation,
  readJourneys,
  resolveJourneySelection
} from "../../core/schema/journey.js";
import type { Journey } from "../../core/schema/journey.js";
import type { JourneyTrace, JourneyView } from "../../core/journey/journey-types.js";
import {
  journeyFrontier,
  journeyOwnership,
  journeyPageOfComponent,
  journeyPath,
  journeyPlacements,
  journeyReachable
} from "../../core/journey/journey-path.js";
import { PRESENTATION_SLOT, buildPresentationIndex } from "../../core/journey/presentation.js";
import {
  classifyValidatorFailure,
  journeyCheckKey,
  journeyReplyOutcome,
  journeyStableJson,
  normalizeValidationReply,
  scopeReplyToPage
} from "../../core/journey/journey-server-check.js";
import type { KernelFoldJourney } from "../../core/state/submittable-fold.js";
import { createFieldConstraintsStage } from "../../validation/core/field-constraints.js";
import type {
  ActiveJourneyPlan,
  JourneyEngine,
  JourneyLanding,
  JourneyRestorePlan,
  JourneyServerCheckKit
} from "./journey-engine.js";
import { JourneyNavigator } from "./journey/journey-navigation.js";
import { JourneyServerChecker } from "./journey/journey-server-checks.js";
import { PresentationOverlayRunner } from "./journey/journey-presentation-overlay.js";

/**
 * The stage the constraints of a presentation's own fields are reported under:
 * browser-only, run after the pipeline, never part of it. `FormRuntime` spells the same id
 * when it drops the errors a presentation leaves behind (it cannot import it from here).
 */
const PRESENTATION_STAGE_ID = "presentation-fields";

/**
 * Where Continue goes from a page a Change link opened (`JourneyState.returnTo`), and Back from
 * one completed before the Change: the first page on the path not yet completed — the page shown
 * left out, as Continue completes it — else the review page. `undefined` when
 * no return holds: none recorded, the page shown is the review page, or the path no longer takes
 * a review page by that id.
 */
function journeyReturning(
  journey: Journey,
  trace: JourneyTrace,
  completed: readonly string[],
  pageId: string,
  returnTo: string | undefined
): JourneyView["returning"] {
  if (returnTo === undefined || returnTo === pageId || !trace.pages.includes(returnTo)) {
    return undefined;
  }
  const review = journey.pages.find((entry) => entry.id === returnTo);
  if (review === undefined || journeyPageKind(review) !== "review") {
    return undefined;
  }
  const nextPageId = trace.pages.find((id) => id !== pageId && !completed.includes(id)) ?? returnTo;
  return { reviewPageId: returnTo, nextPageId };
}

const serverCheck: JourneyServerCheckKit = {
  key: journeyCheckKey,
  stableJson: journeyStableJson,
  classifyFailure: classifyValidatorFailure,
  normalizeReply: normalizeValidationReply,
  scopeToPage: scopeReplyToPage,
  outcomeOf: journeyReplyOutcome
};

/**
 * The eager journey engine: every journey function, delegated to directly.
 * This is the one module besides the runtime that takes the journey modules by value — the
 * path engine, the presentation index and the server-check helpers — so what leaves the form
 * entry when the engine is loaded on its own is exactly what this module reaches.
 *
 * It is exported by the engine package but never registered by importing it: a host that builds
 * runtimes itself passes it as `journeyEngine` or sets it once with `setDefaultJourneyEngine`.
 */
export const EagerJourneyEngine: JourneyEngine = {
  name: "datum-journey-engine-eager",
  kind: "journeys",

  journeys: (configuration) => readJourneys({ journey: configuration }),
  defaultJourney: (configuration) => findJourney({ journey: configuration }),
  selection: (configuration, choice) => resolveJourneySelection({ journey: configuration }, choice),

  activate({ root, journey, definesKey, evaluate, riskyPatterns, formulaErrors }) {
    const ownership = journeyOwnership(root, journey);
    // The fold is handed the path and the placements as input, the same functions
    // the sandbox program splices in. Annotated, never cast: a field the type asks for and the
    // literal lacks is a type error here, not a "walk is not a function" at the first recompute.
    const fold: KernelFoldJourney = {
      journey,
      ownership,
      path: journeyPath,
      place: journeyPlacements,
      evaluate
    };
    const active: ActiveJourneyPlan = { journey, ownership, fold };
    // The journey's own nodes, worked out once beside the ownership.
    const presentation = buildPresentationIndex(root, journey, ownership, definesKey);
    if (presentation !== undefined) {
      active.presentation = presentation;
      active.ownStage = createFieldConstraintsStage(presentation.root, {
        id: PRESENTATION_STAGE_ID,
        pathOf: (componentId) => presentation.keyOf(componentId),
        ...(riskyPatterns !== undefined ? { riskyPatterns } : {}),
        ...(formulaErrors !== undefined ? { formulaErrors } : {})
      });
    }
    return active;
  },

  view({ journey, ownership, pageId, completedPages, trace, returnTo }) {
    const index = trace.pages.indexOf(pageId);
    const page = journey.pages.find((entry) => entry.id === pageId);
    if (index < 0 || !page) {
      return undefined;
    }

    let total = 0;
    let number = 0;
    trace.pages.forEach((onPathId, at) => {
      const onPath = journey.pages.find((entry) => entry.id === onPathId);
      // A review page (Check answers) counts in "Step n of N"; an exit page does not.
      if (onPath && journeyPageKind(onPath) !== "exit") {
        total += 1;
        if (at <= index) {
          number += 1;
        }
      }
    });
    const completed = trace.pages.filter((id) => completedPages.has(id));

    const view: JourneyView = {
      journeyId: journey.id,
      journey,
      pageId,
      page,
      kind: journeyPageKind(page),
      path: [...trace.pages],
      index,
      total,
      number,
      completed,
      frontierPageId: journeyFrontier(trace, completed) ?? pageId,
      final: index === trace.pages.length - 1,
      end: trace.end,
      members: [...(ownership.membersOf[pageId] ?? [])],
      pageOf: journeyPageOfComponent(ownership, trace),
      validation: journeyPageValidation(journey, page)
    };
    if (index > 0) {
      view.backPageId = trace.pages[index - 1] as string;
    }
    const returning = journeyReturning(journey, trace, completed, pageId, returnTo);
    if (returning !== undefined) {
      view.returning = returning;
      // Back goes where Continue would from a page completed before the Change. From a page the
      // changed answers have just put on the path it is the ordinary Back: going on to the
      // review page from there would leave that page behind unvisited.
      if (completedPages.has(pageId)) {
        view.backPageId = returning.nextPageId;
      }
    }
    return view;
  },

  frontier: journeyFrontier,
  reachable: journeyReachable,

  moveHolds({ view, trace, to, direction }) {
    if (!view.path.includes(to)) {
      return false;
    }
    switch (direction) {
      case "forward":
        return (view.returning?.nextPageId ?? view.path[view.index + 1]) === to;
      case "back":
        return view.backPageId === to;
      case "jump":
        return journeyReachable(trace, view.completed, to);
      case "change":
        return view.kind === "review" && to !== view.pageId && (view.completed.includes(to) || journeyReachable(trace, view.completed, to));
    }
  },

  pageComponents(ownership, pageId) {
    const ids = new Set<string>();
    for (const [componentId, pages] of Object.entries(ownership.pagesOf)) {
      if (pages.includes(pageId)) {
        ids.add(componentId);
      }
    }
    return ids;
  },

  pageValidation: journeyPageValidation,
  endValidation: journeyEndValidation,

  renderRoot(root: ComponentNode, presentation) {
    return {
      ...root,
      children: { ...(root.children ?? {}), [PRESENTATION_SLOT]: [presentation.container] }
    };
  },

  restore(saved, journeys, running): JourneyRestorePlan {
    if (saved !== undefined && journeys.some((journey) => journey.id === saved.id)) {
      const written = saved.written;
      return {
        kind: "restore",
        journeyId: saved.id,
        pageId: saved.page,
        completedPages: saved.completed,
        // What its worked-out values had written: read tolerantly, as a draft is.
        written: written !== null && typeof written === "object" && !Array.isArray(written) ? (written as Record<string, unknown>) : undefined,
        returnTo: typeof saved.returnTo === "string" && saved.returnTo !== "" ? saved.returnTo : undefined
      };
    }
    return running ? { kind: "restart" } : { kind: "none" };
  },

  workedOutTargets: (presentation) => new Set((presentation?.workedOut ?? []).map((mapping) => mapping.targetPath)),

  landing(trace, completed, pageId, wanted): JourneyLanding {
    const landing: JourneyLanding = {};
    if (!journeyReachable(trace, completed, pageId)) {
      const frontier = journeyFrontier(trace, completed);
      if (frontier !== undefined) {
        landing.frontier = frontier;
      }
    }
    if (wanted !== undefined && journeyReachable(trace, completed, wanted)) {
      landing.wanted = wanted;
    }
    return landing;
  },

  describe: (active) => (active !== undefined ? { journeyId: active.journey.id } : undefined),
  serverCheck,
  // The moves: a module of their own the engine reaches, so they load with it.
  navigation: (host) => new JourneyNavigator(host),
  checks: (host) => new JourneyServerChecker(host),
  // A running presentation's worked-out values and overlay, beside the orchestrator's fold.
  presentationOverlay: (host) => new PresentationOverlayRunner(host)
};
