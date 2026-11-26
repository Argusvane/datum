import type { ComponentNode } from "../../core/schema/types.js";
import type { FormError } from "../../core/errors/form-error.js";
import type { FormTextCatalog } from "../../core/localization/form-texts.js";
import type { JourneyView } from "../../core/journey/journey-types.js";
import type { RenderComponentModel } from "./component-model.js";
import type { JourneyMetaContext, RenderJourneyMeta } from "./journey-render.js";
import type { JourneyPageFeature } from "../live/journey-page.js";

/**
 * The renderer's side of a journey: everything the render layer does only for a
 * journey page, behind one interface, so the code that does it can sit in a chunk a plain
 * form never fetches. The render orchestrator and the live renderer hold a kit, not the
 * modules: `journey-render.ts` (which components a page draws, the page's meta, its errors,
 * its wording) and the live page module `render/live/journey-page.ts` (the heading block, Back,
 * Continue or Submit, focus after a page change, drawn as lit templates) are reached only
 * through `journey-render-kit-eager.ts`, the real kit.
 *
 * This module is types and the Noop alone, with no value import of either module, so the
 * entry can hold it. It mirrors the runtime's `JourneyEngine` / `NoopJourneyEngine`: the
 * Noop answers "no journey chrome", which draws a form as the one page it is. A journey
 * view handed to a Noop kit is therefore ignored (the runtime that produced it was built
 * with the Noop engine too, and says so once), and the plain-form output is byte-identical
 * with either kit: for a form that runs no journey every method of the real kit already
 * returns what the Noop returns here.
 *
 * The kit is synchronous. A host that loads the real kit lazily loads it before
 * the first journey page paints, the way the runtime waits for its engine.
 */
export interface JourneyRenderKit {
  /** Names the kit in diagnostics and guards: `"noop"`, or the sentinel of the real one. */
  readonly id: string;
  /**
   * The ids of the components a page draws, in the order it draws them
   * (`journeyPageComponentIds`); `undefined` when the whole form is drawn. On a Check answers
   * page (`view.kind === "review"`) the answers it lists follow its own members: their errors
   * are drawn in its rows.
   */
  pageComponentIds(root: ComponentNode, members: readonly string[], view?: JourneyView): Set<string> | undefined;
  /**
   * A page's errors as it shows them (`journeyPageErrors`): a form field's errors
   * move to the node of the page's own standing for it. Returned as they are by the Noop.
   */
  pageErrors(errors: FormError[], hosts: Readonly<Record<string, string>> | undefined): FormError[];
  /** The page as the markup draws it (`buildJourneyMeta`); `undefined` when no page is drawn. */
  buildMeta(root: ComponentNode, view: JourneyView, context: JourneyMetaContext): RenderJourneyMeta | undefined;
  /** The models a page draws (`journeyPageComponents`); all of them, as they are, for the Noop. */
  pageComponents<M extends RenderComponentModel>(models: readonly M[], view: Pick<JourneyView, "members">): M[];
  /** The wording a page is drawn in (`journeyPageTexts`): the host's catalog for the Noop. */
  pageTexts(pageTexts: FormTextCatalog | undefined, journeyTexts: FormTextCatalog | undefined): FormTextCatalog | undefined;
  /**
   * The live renderer's journey page module (`render/live/journey-page.ts`): a page's heading,
   * Back and Continue or Submit, and focus after a page change. A new one per mount; the element
   * lists it with the renderer's other modules. Absent from the Noop: a form drawn whole has no
   * page of its own.
   */
  pageFeature?(): JourneyPageFeature;
}

/**
 * No journey chrome: a form drawn whole, whatever view it is handed. Frozen so a host cannot
 * give it behaviour by assignment.
 */
export const NoopJourneyRenderKit: JourneyRenderKit = Object.freeze({
  id: "noop",
  pageComponentIds: () => undefined,
  pageErrors: (errors: FormError[]) => errors,
  buildMeta: () => undefined,
  pageComponents: <M extends RenderComponentModel>(models: readonly M[]): M[] => [...models],
  pageTexts: (pageTexts: FormTextCatalog | undefined) => pageTexts
});
