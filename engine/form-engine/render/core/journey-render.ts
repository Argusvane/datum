import type { ComponentNode } from "../../core/schema/types.js";
import type { TranslationCatalog } from "../../core/schema/contracts.js";
import type { FormError } from "../../core/errors/form-error.js";
import { PRESENTATION_REFERENCE_TYPE, type JourneyPageKind } from "../../core/schema/journey.js";
import { PRESENTATION_KEY_PREFIX } from "../../core/journey/presentation.js";
import { workedOutTextOwner } from "../../core/journey/worked-out-text.js";
import type { JourneyView } from "../../core/journey/journey-types.js";
import type { EffectiveNodeState } from "../../core/state/effective-state.js";
import type { FormTextCatalog } from "../../core/localization/form-texts.js";
import { addressOf, resolveText, type FormTranslations, type TextSources } from "../../core/localization/translations.js";
import { BUTTON_COMPONENT_TYPE, readButtonAction } from "../../core/schema/button.js";
import { flattenComponentTree, type RenderComponentModel } from "./component-model.js";

/**
 * A journey page as the render layer draws it. The runtime hands the renderer a
 * {@link JourneyView} — which journey, which page, where it sits on the path — and the render
 * orchestrator turns it into {@link RenderJourneyMeta}: the page's wording resolved for the
 * locale, and what the markup needs to decide its chrome (Back, the heading, Continue or
 * Submit). The page itself is drawn by the form's own markup over
 * {@link journeyPageComponents}: the page's components, each with its subtree, lifted out of
 * wherever the tree holds them. The tree stays the one form; a page is a view of it.
 *
 * The render orchestrator and the form's markup reach this module through a
 * `JourneyRenderKit` (`journey-render-kit.ts`), not by import: the real kit
 * (`journey-render-kit-factory.ts`) is the one value importer, so a build that omits journeys
 * can leave this module out. Only types are imported from here elsewhere.
 */

/** What `RenderOutputMeta.journey` carries: the page being shown, ready to draw. */
export interface RenderJourneyMeta {
  journeyId: string;
  pageId: string;
  kind: JourneyPageKind;
  /**
   * The page's heading, resolved for the locale: its `title`, else the label of its first
   * component that shows (a one-question page headed by its question), else empty: the page id is
   * no wording for a filler, so an untitled page draws no heading (the builder flags it).
   */
  title: string;
  description: string | undefined;
  /** The page's position on the path, 0-based. */
  index: number;
  /** The page's position among the questions and Check answers pages on the path, 1-based: the "n" of "Step n of N". */
  number: number;
  /** Questions and Check answers pages on the path: the "N". */
  total: number;
  /** `"count"` (the journey's default) captions the heading with the `pageOf` text; `"none"` draws no count. */
  progress: "none" | "count";
  /**
   * `"hidden"` draws no page heading: the form's title heads the page and the
   * count is not drawn. The title above still names the page in `datum-page-change`.
   */
  heading: "shown" | "hidden";
  /** Where Back goes; `undefined` on the first page, which draws no Back. */
  backPageId: string | undefined;
  /** The last page on the path: its action submits. */
  final: boolean;
  /**
   * The page holds a `submit` or `download` button of its own (one that shows), so the final
   * page draws no Submit beside it: the form's button keeps its signing and wording.
   */
  hasOwnSubmit: boolean;
  /** A check against the host's server is out for this page (`"page"`) or the whole journey (`"journey"`). */
  pending: "page" | "journey" | undefined;
  /**
   * The journey's texts with the page's over them (`Journey.texts`, `JourneyPage.texts`):
   * authored for this journey, so they sit over the page's and the theme's wording while the
   * page shows. `undefined` when neither words anything.
   */
  texts: FormTextCatalog | undefined;
  /** The component ids the page draws, in order (the view's `members`). */
  members: string[];
}

export interface JourneyMetaContext {
  locale: string;
  /** The definition's own translations: a journey's page texts and a component's label live there. */
  translations?: FormTranslations | undefined;
  translationCatalog?: TranslationCatalog | undefined;
  effectiveStates?: ReadonlyMap<string, EffectiveNodeState> | undefined;
}

function configuredLabel(node: ComponentNode, locale: string, sources: TextSources): string | undefined {
  const configuration = node.configuration;
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) {
    return undefined;
  }
  const raw = (configuration as Record<string, unknown>).label;
  if (typeof raw !== "string") {
    return undefined;
  }
  // A worked-out copy that took its target's label (`inheritsLabel`) words it at the target's
  // address, as the field itself is worded; every other node words its label at its own id.
  const label = resolveText(raw, addressOf.component(workedOutTextOwner(node, "label"), "label"), locale, sources);
  return label !== undefined && label.trim() !== "" ? label : undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== "" ? value : undefined;
}

/** Every node of the tree by id. */
function nodesById(root: ComponentNode): Map<string, ComponentNode> {
  return new Map(flattenComponentTree(root).map((node) => [node.id, node]));
}

/**
 * The form component a node stands for when it is the placeholder of a reference inside a
 * layout a presentation owns: a node of type `journey-field` whose id starts with
 * `@` — `@<presentation id>/ref-<n>`, as the runtime's combined root
 * (`FormRuntime.journeyRenderRoot`) numbers them, which no form component's id can — naming
 * the component in `configuration.componentId`. A page draws that component, with its subtree,
 * where the placeholder stands. `undefined` for every other node.
 */
export function referencedComponentId(node: ComponentNode): string | undefined {
  if (node.type !== PRESENTATION_REFERENCE_TYPE || !node.id.startsWith(PRESENTATION_KEY_PREFIX)) {
    return undefined;
  }
  const configuration = node.configuration;
  const componentId =
    configuration !== null && typeof configuration === "object" && !Array.isArray(configuration)
      ? (configuration as Record<string, unknown>).componentId
      : undefined;
  return typeof componentId === "string" && componentId.length > 0 ? componentId : undefined;
}

/**
 * A member's subtree as its page draws it, depth-first in the tree's order: each reference's
 * placeholder gives way to the form component it names and that component's
 * subtree. The root is never drawn in a placeholder's place, and a node is walked once.
 */
function pageSubtree(member: ComponentNode, byId: ReadonlyMap<string, ComponentNode>, rootId: string, visited: Set<string>, out: ComponentNode[]): void {
  if (visited.has(member.id)) {
    return;
  }
  visited.add(member.id);
  const referenced = referencedComponentId(member);
  if (referenced !== undefined) {
    const target = byId.get(referenced);
    if (target && target.id !== rootId) {
      pageSubtree(target, byId, rootId, visited, out);
    }
    return;
  }
  out.push(member);
  for (const group of Object.values(member.children ?? {})) {
    for (const child of group ?? []) {
      pageSubtree(child, byId, rootId, visited, out);
    }
  }
}

/**
 * The components a page draws: its members and everything under them — a reference inside a
 * layout the presentation owns standing for the form component it names — plus the
 * root, which frames every page. An error on any of these is the page's to show beside its
 * field; an error anywhere else belongs to a page the person is not on (or to no page), and the
 * summary lists it as the form's. The set iterates in the order {@link journeyPageComponents}
 * draws — the root, then each member in the page's order followed by its subtree — which the
 * render orchestrator relies on to put a page's errors, its summary and its first focus in
 * that order. On a Check answers page (`view.kind === "review"`) the answers it lists
 * (`reviewIds`, the Check answers kit's `journeyReviewComponentIds`) follow its own members: it
 * draws them, and their errors, in its rows. With no `reviewIds` (no Check answers kit loaded) the
 * page is its members alone.
 */
export function journeyPageComponentIds(
  root: ComponentNode,
  members: readonly string[],
  view?: Pick<JourneyView, "kind" | "path" | "journey" | "pageOf">,
  reviewIds?: (view: Pick<JourneyView, "path" | "journey" | "pageOf">) => readonly string[]
): Set<string> {
  const byId = nodesById(root);
  const ids = new Set<string>([root.id]);
  for (const memberId of view?.kind === "review" && reviewIds ? [...members, ...reviewIds(view)] : members) {
    const node = byId.get(memberId);
    if (!node) {
      continue;
    }
    const drawn: ComponentNode[] = [];
    pageSubtree(node, byId, root.id, new Set(), drawn);
    for (const descendant of drawn) {
      ids.add(descendant.id);
    }
  }
  return ids;
}

/**
 * A page's errors as it shows them. A form field the page asks through a node of
 * its own — an alias, a worked-out value's copy — is not drawn on it: `hosts`
 * (`JourneyView.hosts`) names the node standing for it, and the field's errors become that
 * node's, drawn under it, counted for it, and the summary's link and the first focus go to it.
 * An error the node already shows — the same code and the same message it carries — is not
 * shown twice (its own Required beside the form field's); two messages under one code both are.
 * Without `hosts` the errors are returned as they are.
 */
export function journeyPageErrors(errors: FormError[], hosts: Readonly<Record<string, string>> | undefined): FormError[] {
  if (!hosts) {
    return errors;
  }
  const hostIds = new Set(Object.values(hosts));
  if (hostIds.size === 0) {
    return errors;
  }
  const shown = new Set<string>();
  const out: FormError[] = [];
  for (const error of errors) {
    const host =
      error.componentId !== undefined && Object.prototype.hasOwnProperty.call(hosts, error.componentId) ? hosts[error.componentId] : undefined;
    const placed = host !== undefined ? { ...error, componentId: host } : error;
    if (placed.componentId !== undefined && hostIds.has(placed.componentId)) {
      const key = `${placed.componentId}\u0000${placed.code}\u0000${placed.message}`;
      if (shown.has(key)) {
        continue;
      }
      shown.add(key);
    }
    out.push(placed);
  }
  return out;
}

/** The page as the markup draws it: its wording resolved, its chrome decided. */
export function buildJourneyMeta(root: ComponentNode, view: JourneyView, context: JourneyMetaContext): RenderJourneyMeta {
  const { locale, translations, translationCatalog, effectiveStates } = context;
  const sources: TextSources = { translations, catalog: translationCatalog };
  // A page's own title and description are strings in the form's default language, worded at
  // `journeys › <journey id> › pages › <page id> › <property>`.
  const pageText = (property: "title" | "description"): string | undefined => {
    const authored = view.page[property];
    return typeof authored === "string"
      ? resolveText(authored, addressOf.journeyPage(view.journeyId, view.pageId, property), locale, sources)
      : undefined;
  };
  const byId = nodesById(root);
  const shows = (id: string): boolean => effectiveStates?.get(id)?.visible !== false;
  const members = view.members.filter((id) => byId.has(id));

  // A one-question page is headed by its question: the first member that shows, else the first.
  const labelledBy = members.find(shows) ?? members[0];
  const title =
    nonEmpty(pageText("title")) ??
    (labelledBy !== undefined ? configuredLabel(byId.get(labelledBy) as ComponentNode, locale, sources) : undefined) ??
    "";

  // A button the page draws: in a member, in a layout of the presentation's own, or in a form
  // component a reference in one of those names.
  let hasOwnSubmit = false;
  for (const memberId of members) {
    const drawn: ComponentNode[] = [];
    pageSubtree(byId.get(memberId) as ComponentNode, byId, root.id, new Set(), drawn);
    for (const node of drawn) {
      if (node.type !== BUTTON_COMPONENT_TYPE || !shows(node.id)) {
        continue;
      }
      const action = readButtonAction(node.configuration);
      if (action === "submit" || action === "download") {
        hasOwnSubmit = true;
      }
    }
  }

  // The journey's and the page's own words for the form's texts (Continue, Back, …): strings in
  // the default language, worded for the locale at `journeys › <id> › texts › <key>` (a page's at
  // `… › pages › <page id> › texts › <key>`).
  const worded = (texts: Record<string, string> | undefined, path: readonly string[]): FormTextCatalog | undefined => {
    if (!texts) {
      return undefined;
    }
    return Object.fromEntries(
      Object.entries(texts).map(([key, value]) => [
        key,
        resolveText(value, { kind: "journeys", owner: view.journeyId, path: [...path, "texts", key] }, locale, sources)
      ])
    ) as FormTextCatalog;
  };
  const journeyTexts = worded(view.journey.texts, []);
  const pageTexts = worded(view.page.texts, ["pages", view.pageId]);
  const texts = journeyTexts || pageTexts ? { ...(journeyTexts ?? {}), ...(pageTexts ?? {}) } : undefined;

  return {
    journeyId: view.journeyId,
    pageId: view.pageId,
    kind: view.kind,
    title,
    description: nonEmpty(pageText("description")),
    index: view.index,
    number: view.number,
    total: view.total,
    progress: view.journey.progress === "none" ? "none" : "count",
    heading: view.journey.heading === "hidden" || title === "" ? "hidden" : "shown",
    backPageId: view.backPageId,
    final: view.final,
    hasOwnSubmit,
    pending: view.pending,
    texts,
    members: [...view.members]
  };
}

/**
 * The models a journey page draws, in the order the live renderer expects them: the root, then
 * each of the page's components in the page's order — re-parented to the root's first slot
 * (the page lists it wherever the tree holds it: in a section, a grid column, a step) — each
 * followed by its own subtree as the tree holds it. A component the page lists twice, or one
 * already drawn as part of an earlier member's subtree, is drawn once. Everything else in the
 * tree is left out, so the form's markup draws the page and nothing but the page.
 *
 * A presentation's own nodes are members like the form's, drawn from the runtime's
 * combined root (`FormRuntime.journeyRenderRoot`). A reference inside a layout of its own is a
 * placeholder there ({@link referencedComponentId}): the page draws the form component it
 * names in its place — in the placeholder's parent and slot, at its depth, inside its layouts —
 * with that component's subtree, once, like any member.
 */
export function journeyPageComponents<M extends RenderComponentModel>(
  models: readonly M[],
  view: Pick<JourneyView, "members">
): M[] {
  const root = models.find((model) => model.parentId === undefined);
  if (!root) {
    return [];
  }
  const byId = new Map(models.map((model) => [model.id, model]));
  const byParent = new Map<string, M[]>();
  for (const model of models) {
    if (model.parentId === undefined) {
      continue;
    }
    const siblings = byParent.get(model.parentId);
    if (siblings) {
      siblings.push(model);
    } else {
      byParent.set(model.parentId, [model]);
    }
  }
  const children = root.node.children;
  const slotId = (children ? Object.keys(children)[0] : undefined) ?? "content";

  const out: M[] = [root];
  const drawn = new Set<string>([root.id]);
  /**
   * Draws `top` with its subtree as a child of `parentId` in `slot`, at `depth`, inside the
   * layouts `layouts`: a member under the root, or the form component a placeholder names.
   */
  const place = (top: M, parentId: string, slot: string | undefined, depth: number, layouts: readonly string[]): void => {
    // The subtree, depth-first in the tree's order, less anything already drawn.
    const subtree: M[] = [];
    const walk = (model: M): void => {
      if (drawn.has(model.id)) {
        return;
      }
      drawn.add(model.id);
      subtree.push(model);
      for (const child of byParent.get(model.id) ?? []) {
        walk(child);
      }
    };
    walk(top);
    // Layout containers above `top` are not drawn, so they leave its path; its depth restarts
    // where it is placed.
    const inside = new Set(subtree.map((model) => model.id));
    const shift = top.depth - depth;
    for (const model of subtree) {
      const containerPath = [...layouts, ...model.containerPath.filter((id) => inside.has(id))];
      const placedDepth = model.depth - shift;
      const referenced = referencedComponentId(model.node);
      if (referenced !== undefined) {
        // A reference in a layout of the presentation's own: the form component it
        // names, where it stands. Never the root, and nothing a page has drawn already.
        const target = byId.get(referenced);
        if (target && target !== root) {
          place(
            target,
            model === top ? parentId : (model.parentId ?? parentId),
            model === top ? slot : model.slotId,
            placedDepth,
            containerPath
          );
        }
        continue;
      }
      out.push(
        model === top
          ? { ...model, parentId, slotId: slot, depth: placedDepth, containerPath }
          : { ...model, depth: placedDepth, containerPath }
      );
    }
  };
  for (const memberId of view.members) {
    const member = byId.get(memberId);
    if (!member || drawn.has(memberId)) {
      continue;
    }
    place(member, root.id, slotId, 1, []);
  }
  return out;
}

/**
 * The wording a journey page is drawn in (the kit's `pageTexts`, read by the presentation fold
 * and the render orchestrator): the journey's texts, with its page's over them
 * (`RenderJourneyMeta.texts`), over what the host page words. Authored for this journey and
 * this page, they win the way a button's own label does.
 */
export function journeyPageTexts(
  pageTexts: FormTextCatalog | undefined,
  journeyTexts: FormTextCatalog | undefined
): FormTextCatalog | undefined {
  if (!journeyTexts) {
    return pageTexts;
  }
  return pageTexts ? { ...pageTexts, ...journeyTexts } : journeyTexts;
}
