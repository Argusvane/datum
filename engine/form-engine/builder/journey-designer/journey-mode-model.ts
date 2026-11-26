/**
 * The Journeys mode's state with no DOM in it: the form's journeys as edited, which one
 * is on the page, and what a change to either means for the designer over it — so the logic
 * behind the mode's chrome is testable under Node. It mirrors the PDF mode's
 * (`pdf-designer/pdf-mode-model.ts`), with two differences that follow from how journeys are modelled:
 *
 * - The block is held **as given**, never normalized: until something is edited, what the mode
 *   reports is the seed itself, byte for byte, unknown keys, unreadable journeys and all.
 * - A form with no journeys has none: nothing is derived for it, and the list may empty.
 *
 * Static and free of work at import. It also names the designer's node types, so the mode's
 * chrome (its rules descriptors, its labels) can speak of them without loading the designer.
 */
import type { Journey, JourneyConfiguration } from "../../core/schema/journey.js";
import type { ComponentNode } from "../../core/schema/types.js";
import { effectiveDefaultJourneyId, journeysOf, replaceJourney, unlistedJourneysOf, type UnlistedJourney } from "./journey-catalog.js";
import { renameReferencesInConfiguration } from "./journey-references.js";

/** The designer's tree root: the journey's own settings. Its node id is always {@link JOURNEY_ROOT_ID}. */
export const JOURNEY_ROOT_TYPE = "journey";
/** The root's node id. The journey's id belongs to the catalog entry, not the tree. */
export const JOURNEY_ROOT_ID = "journey";
/** A page. Its id is the `pageId` property; its node id is internal. */
export const JOURNEY_PAGE_TYPE = "journey-page";
/** One of a page's `components`: `{ componentId }`. */
export const JOURNEY_FIELD_TYPE = "journey-field";
/** One of a page's `routes`: `{ to, when?, missingTo? }`, `to` naming a page node, `"$end"`, or nothing yet. */
export const JOURNEY_ROUTE_TYPE = "journey-route";
/** The root's one slot: its pages, in order. */
export const JOURNEY_PAGES_SLOT = "pages";
/** A page's questions, in the order it draws them. */
export const JOURNEY_CONTENT_SLOT = "content";
/** A page's routes, in the order they are tried. */
export const JOURNEY_ROUTES_SLOT = "routes";
/** The palette group the designer's types are listed under. */
export const JOURNEY_PALETTE_GROUP = "Journey";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The id a page node is written under: its `pageId`, else its node id. Here rather than in the
 * designer's chunk so the chunks the designer loads read it from the bundle, as they must read
 * nothing of the designer's chunk itself (see `JourneyPreviewLent`).
 */
export function writtenPageId(node: ComponentNode): string {
  const pageId = isRecord(node.configuration) ? node.configuration.pageId : undefined;
  return typeof pageId === "string" && pageId.trim() !== "" ? pageId : node.id;
}

/**
 * Whether a journey is, while it is being edited, one questions page with no routes
 * (there is no "form variant", only a journey of one page). Two things in the builder
 * follow the shape: the bar's Map button hides (a map of one page shows nothing), and "Add
 * unassigned" fills the one page whatever is selected, rather than adding a page behind the
 * author's back. With the designer's `tree` given, no page of the tree may hold a route node
 * either — a route just added, its target not chosen yet, is not written (`journeyFromTree`
 * drops a route with no `to`), but the Map should come at once. A journey that cannot be
 * written (`undefined`) is not one page.
 */
export function journeyHasOnePage(journey: Journey | undefined, tree?: ComponentNode): boolean {
  const page = journey?.pages.length === 1 ? journey.pages[0] : undefined;
  if (page === undefined || (page.kind ?? "questions") !== "questions" || (page.routes ?? []).length > 0) {
    return false;
  }
  return tree === undefined || !(tree.children?.[JOURNEY_PAGES_SLOT] ?? []).some((page) => (page.children?.[JOURNEY_ROUTES_SLOT] ?? []).length > 0);
}

/**
 * How a journey changed under one id, for the designer over it: not at all, by its name alone
 * (the open tree's root takes the new one), or in anything else (the designer is built again).
 */
export function journeyChange(before: Journey, after: Journey): "none" | "name" | "structure" {
  const sansName = (journey: Journey): string => JSON.stringify({ ...journey, name: undefined });
  if (sansName(before) !== sansName(after)) {
    return "structure";
  }
  return JSON.stringify(before.name ?? null) !== JSON.stringify(after.name ?? null) ? "name" : "none";
}

/** What a configuration change means for the designer over the journey on the page. */
export interface JourneyModeApplyResult {
  before: Journey | undefined;
  after: Journey | undefined;
  /** The designer must be rebuilt: the page moved to another journey, or the one it shows changed underneath it. */
  rebuild: boolean;
  /** Only the name changed, under the same id: the open tree's root takes the new one. */
  renamed: boolean;
}

export class JourneyModeModel {
  private configurationValue: JourneyConfiguration | undefined;
  private journeyIdValue: string | undefined;

  /** `configuration` is the definition's `journey` value as it stands; anything but an object reads as none. */
  constructor(configuration?: unknown, journeyId?: string) {
    this.configurationValue = isRecord(configuration) ? (configuration as JourneyConfiguration) : undefined;
    this.journeyIdValue = journeyId;
  }

  /**
   * Starts over on another definition's block, kept as given; returns the declared journeys it
   * keeps without listing (unreadable, or a later one with an id already taken).
   */
  public reseed(configuration: unknown): UnlistedJourney[] {
    this.configurationValue = isRecord(configuration) ? (configuration as JourneyConfiguration) : undefined;
    return unlistedJourneysOf(this.configurationValue);
  }

  /** The block as edited: the seed object itself until the first edit; `undefined` when there was none. */
  public get configuration(): JourneyConfiguration | undefined {
    return this.configurationValue;
  }

  /** The listed journeys: usable ones, the first with each id. */
  public get journeys(): Journey[] {
    return journeysOf(this.configurationValue);
  }

  /** The declared journeys kept but not listed, for the mode to say so. */
  public get unlisted(): UnlistedJourney[] {
    return unlistedJourneysOf(this.configurationValue);
  }

  public get defaultId(): string | undefined {
    return effectiveDefaultJourneyId(this.configurationValue);
  }

  /** The chosen journey's id; the page falls back to the default, then the first, when it names none. */
  public get journeyId(): string | undefined {
    return this.journeyIdValue;
  }

  public set journeyId(value: string | undefined) {
    this.journeyIdValue = value;
  }

  /** The journey on the page: the chosen one, else the default, else the first; `undefined` with none. */
  public selected(): Journey | undefined {
    const journeys = this.journeys;
    const defaultId = this.defaultId;
    return (
      journeys.find((journey) => journey.id === this.journeyIdValue) ??
      journeys.find((journey) => journey.id === defaultId) ??
      journeys[0]
    );
  }

  public require(id: string): Journey {
    const found = this.journeys.find((journey) => journey.id === id);
    if (!found) {
      throw new Error(`No journey has the id "${id}"`);
    }
    return found;
  }

  /** Commits `next`, moving the page to `select` when given, and says what the designer must do about it. */
  public apply(next: JourneyConfiguration | undefined, select?: string): JourneyModeApplyResult {
    const before = this.selected();
    this.configurationValue = next;
    if (select !== undefined) {
      this.journeyIdValue = select;
    }
    const after = this.selected();
    const moved = after?.id !== before?.id;
    // The same journey: anything but its name changing underneath the designer rebuilds it;
    // the name alone is pushed into the open tree instead.
    const change = before !== undefined && after !== undefined && !moved ? journeyChange(before, after) : "none";
    return { before, after, rebuild: moved || change === "structure", renamed: change === "name" };
  }

  /** The journey with this id replaced by what the designer holds — its own edit, not a change of page. */
  public replaceQuietly(id: string, journey: Journey): void {
    this.configurationValue = replaceJourney(this.configurationValue, id, journey);
  }

  /**
   * Follows the form's rename of component `from` to `to` into every journey
   * (`renameReferencesInConfiguration`); whether anything changed. The designers already built
   * are the mode's to rewrite in place (`journeyTreeRenames`), never rebuilt, so their history
   * survives.
   */
  public renameComponent(from: string, to: string): boolean {
    const next = renameReferencesInConfiguration(this.configurationValue, from, to);
    if (next === this.configurationValue) {
      return false;
    }
    this.configurationValue = next;
    return true;
  }
}
