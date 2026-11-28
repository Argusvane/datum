/**
 * The steps container: a `steps` container whose children are `step` containers,
 * shown one at a time with an indicator, a progress line and Back and Continue. A
 * {@link LiveFeature} (`stepsFeature()`) the host lists in `features`; the adapter only draws.
 *
 * What the renderer owns here, whatever binding draws:
 * - which step shows. A runtime that navigates (`FormRuntime.navigate`) is the truth: its hooks
 *   and gating rules may refuse, and its `NAVIGATION_COMPLETED` draws the new step. A runtime
 *   that cannot (the builder's preview) switches in place; the choice is kept across draws, and
 *   a step the edit removed is simply gone. On the builder canvas every control only shows the
 *   step it names;
 * - Continue: checks the step on show, that step alone, and goes to its first error instead of
 *   advancing; clean, it records the step as completed and opens the next. Back opens the
 *   previous one with no check. Both pass over a step a rule hides, which the indicator lists
 *   holding nothing and does not open. An indicator entry opens a step already reached; an
 *   upcoming one is not a way to skip ahead;
 * - a steps container in a collection's row: each row's is its own, keyed by its instance key,
 *   and switches in place (the runtime has one current step for the form); its Continue is held
 *   by its own row's errors alone;
 * - focus: the new step's heading takes it (the page a multi-step form moves to), unless the
 *   caller has somewhere better in mind (an error);
 * - an error or a focus request on a field in a step that is not shown opens that step
 *   (`reveal`), through the runtime when it navigates;
 * - a review or a print (`FormDrawState.printing`) draws every step headed, in order, with no
 *   indicator or buttons (`StepsState.flat`).
 *
 * `defaultStepsAdapter` is Datum's own steps container (`datum/steps.ts`), the look drawn when neither
 * the binding nor the Datum binding has a steps adapter.
 */
import type { StepsNavigationState } from "../../core/schema/steps.js";
import type { ComponentPath } from "../../core/schema/types.js";
import { stringifyComponentPath } from "../../core/tree/component-path.js";
import { stepStatus } from "../../core/schema/steps.js";
import type { PresentationReveal, PresentationStep, PresentationSteps } from "../core/presentation-tree.js";
import { usedContainerCapabilities, type StepsAdapter, type StepsState, type StepState } from "./contract.js";
import { componentTextOf } from "./component-text.js";
import { datumStepsAdapter } from "./datum/steps.js";
import { html, nothing, repeat, type TemplateResult } from "./lit.js";
import type { DrawContext, LiveContext, LiveFeature } from "./mount.js";

const OWNER = "steps";

/** The look Datum draws a steps container with when neither the binding nor the Datum binding has a steps adapter (`datum/steps.ts`). */
export const defaultStepsAdapter: StepsAdapter = datumStepsAdapter;

/** What the renderer needs of the runtime beyond `LiveRuntime`: navigation and a scoped check. */
interface StepsRuntime {
  /** Moves a multi-step form to `stepId`; `ok: false` when its hooks or rules refuse. */
  navigate?(stepId: string): Promise<{ ok: boolean }>;
  markStepCompleted?(stepId: string): void;
  validate?(options?: { scope?: string }): Promise<unknown>;
}

/** What the feature keeps for the life of the mount, by steps container instance (`node.key`). */
interface StepsMemory {
  /** The step the renderer opened: the shown step where the container does not navigate, or a move still in flight. */
  shown: Map<string, string>;
  /** Steps reached and passed without the runtime recording it (where the container does not navigate). */
  visited: Map<string, Set<string>>;
  completed: Map<string, Set<string>>;
  /** The step each container showed in the last draw. */
  active: Map<string, string | undefined>;
  /** Each step's heading id, by container instance and step id. */
  headings: Map<string, string>;
  /** The containers drawn in a collection's row: they switch in place, each row its own. */
  inRows: Set<string>;
  /** Which container instance each reveal entry of a step's components names (a row's own, where the id is shared). */
  owners: WeakMap<PresentationReveal, string>;
  /** The last draw showed every step. */
  flat: boolean;
  /** A move is in flight: a second Continue or Back waits. */
  moving: boolean;
}

function memoryOf(live: LiveContext): StepsMemory {
  return live.memory<StepsMemory>(OWNER, () => ({
    shown: new Map(),
    visited: new Map(),
    completed: new Map(),
    active: new Map(),
    headings: new Map(),
    inRows: new Set(),
    owners: new WeakMap(),
    flat: false,
    moving: false
  }));
}

function setOf(map: Map<string, Set<string>>, id: string): Set<string> {
  let set = map.get(id);
  if (!set) {
    set = new Set();
    map.set(id, set);
  }
  return set;
}

const headingKey = (containerKey: string, stepId: string): string => `${containerKey}\u0000${stepId}`;

/**
 * Whether the runtime moves the container between steps; the builder canvas, which only shows
 * them, never does. Nor does a container in a collection's row: the runtime has one current
 * step for the form, and each row's container is its own.
 */
function navigates(live: LiveContext, containerKey: string): boolean {
  return typeof (live.runtime as StepsRuntime).navigate === "function" && live.options.canvasHooks === undefined && !memoryOf(live).inRows.has(containerKey);
}

/** A steps container drawn in a collection's row: where its row's answers are (`items[1]`). */
interface RowOf {
  entryPath: string;
}

// ── Moving ─────────────────────────────────────────────────────────────────────────────────

/** Moves the heading's focus to a step's heading, scrolled into view. */
function focusHeading(live: LiveContext, containerKey: string, stepId: string): void {
  const id = memoryOf(live).headings.get(headingKey(containerKey, stepId));
  const heading = id !== undefined ? live.root.getElementById(id) : null;
  if (heading instanceof HTMLElement) {
    live.focusElement(heading);
    if (typeof heading.scrollIntoView === "function") {
      heading.scrollIntoView({ block: "start", behavior: "smooth" });
    }
  }
}

/**
 * Opens a step: through the runtime when it navigates (its hooks and gating rules may refuse),
 * else by remembering the choice and drawing it. Focus then moves to the step's heading unless
 * `focus` is off. `false` when the move did not happen.
 */
async function showStep(live: LiveContext, containerKey: string, stepId: string, focus: boolean): Promise<boolean> {
  const memory = memoryOf(live);
  if (navigates(live, containerKey)) {
    const result = await (live.runtime as StepsRuntime).navigate?.(stepId);
    if (result?.ok !== true || !live.mounted()) {
      return false;
    }
    await live.updated();
  } else {
    memory.shown.set(containerKey, stepId);
    setOf(memory.visited, containerKey).add(stepId);
    live.redraw();
  }
  if (focus && live.mounted()) {
    focusHeading(live, containerKey, stepId);
  }
  return true;
}

/** Runs one move at a time, with the form marked busy while it works (the buttons draw `aria-disabled`). */
async function moving(live: LiveContext, move: () => Promise<void>): Promise<void> {
  const memory = memoryOf(live);
  if (memory.moving || !live.mounted()) {
    return;
  }
  memory.moving = true;
  live.setBusy("navigating", true);
  try {
    await move();
  } catch (thrown) {
    live.error({ hook: "steps", message: thrown instanceof Error ? thrown.message : String(thrown) });
  } finally {
    memory.moving = false;
    live.setBusy("navigating", false);
  }
}

/** Whether `path` is an answer of the row at `entryPath` (`items[1]`, not `items[10]`). */
function inRow(path: string, entryPath: string): boolean {
  return path === entryPath || path.startsWith(`${entryPath}.`) || path.startsWith(`${entryPath}[`);
}

/** Continue: checks the step on show, and either goes to its first error or opens `next`. */
function proceed(live: LiveContext, containerKey: string, current: string, next: string, row: RowOf | undefined): Promise<void> {
  return moving(live, async () => {
    const authoring = live.options.canvasHooks !== undefined;
    const runtime = live.runtime as StepsRuntime;
    if (!authoring && typeof runtime.validate === "function") {
      const errors = await runtime.validate({ scope: current });
      // In a row, the step's components are every row's: this row's errors are the ones that hold it.
      const ofRow = (error: unknown): boolean => {
        const path = (error as { path?: ComponentPath } | undefined)?.path;
        return row === undefined || (path !== undefined && inRow(stringifyComponentPath(path), row.entryPath));
      };
      const blocking = Array.isArray(errors) && errors.some((error) => ((error as { severity?: string } | undefined)?.severity ?? "error") === "error" && ofRow(error));
      if (blocking) {
        await live.updated();
        const first = row === undefined ? undefined : live.fields().find((field) => field.state.invalid && inRow(field.state.valuePath, row.entryPath));
        if (first !== undefined) {
          live.focusField(first.key);
        } else {
          live.focusErrors();
        }
        return;
      }
      if (row === undefined && typeof runtime.markStepCompleted === "function") {
        runtime.markStepCompleted(current);
      } else {
        setOf(memoryOf(live).completed, containerKey).add(current);
      }
    }
    await showStep(live, containerKey, next, true);
  });
}

function goTo(live: LiveContext, containerKey: string, stepId: string): Promise<void> {
  return moving(live, async () => {
    await showStep(live, containerKey, stepId, true);
  });
}

// ── Drawing ────────────────────────────────────────────────────────────────────────────────

/** One step's components in a wrapper that holds the DOM contract: `data-container-id` is the step's id. */
function stepContent(step: PresentationStep, draw: DrawContext): TemplateResult {
  const hooks = draw.live.options.canvasHooks;
  const empty = hooks?.emptySlot;
  const slots = step.slots.map((slot) => ({
    slotId: slot.slotId,
    content:
      slot.children.length === 0 && empty
        ? html`${draw.live.call("emptySlot", step.id, () => empty({ containerId: step.id, slotId: slot.slotId })) ?? nothing}`
        : draw.nodes(slot.children)
  }));
  let inner: TemplateResult = html`${slots.map((slot) => slot.content)}`;
  const canvas = hooks?.renderContainer;
  if (canvas) {
    const drawn = inner;
    inner = draw.live.call("renderContainer", step.id, () => canvas({ model: step.model, kind: "group", label: step.label, slots: new Map(slots.map((slot) => [slot.slotId, slot.content])) }, drawn)) ?? drawn;
  }
  return html`<div class="datum-live-container" data-container-id=${step.id} data-kind="step">${inner}</div>`;
}

function drawSteps(node: PresentationSteps, draw: DrawContext) {
  const live = draw.live;
  const memory = memoryOf(live);
  const authoring = live.options.canvasHooks !== undefined;
  // Kept by the instance: the same steps container drawn in each row of a grid is one per row.
  const own = node.key;
  const rowScope = node.model.row;
  const row: RowOf | undefined = rowScope !== undefined ? { entryPath: `${rowScope.collectionPath}[${rowScope.index}]` } : undefined;
  if (row !== undefined) {
    memory.inRows.add(own);
  }
  const moves = navigates(live, own);
  const flat = draw.tree.mode !== "interactive" || draw.form.printing;
  const ids = node.steps.map((step) => step.id);
  const navigation: StepsNavigationState = draw.output.meta.navigation;
  // The step the runtime shows, unless the renderer opened another: for good where nothing
  // navigates, until the runtime catches up (or refuses) where it does.
  let active = node.activeStepId;
  const opened = memory.shown.get(own);
  if (opened !== undefined) {
    if (!ids.includes(opened) || (moves && opened === node.activeStepId)) {
      memory.shown.delete(own);
    } else {
      active = opened;
    }
  }
  memory.active.set(own, active);
  memory.flat = flat;
  if (active !== undefined && !moves) {
    setOf(memory.visited, own).add(active);
  }

  const total = node.steps.length;
  const activeIndex = Math.max(0, ids.indexOf(active ?? ""));
  const words = draw.words;
  const visited = memory.visited.get(own);
  const completed = memory.completed.get(own);

  const steps: StepState[] = node.steps.map((step): StepState => {
    // A row's container keeps its own record: the runtime's is the form's one sequence.
    let status = stepStatus(step.id, active, row === undefined ? navigation : undefined);
    if (!moves && status !== "active") {
      status = completed?.has(step.id) ? "completed" : visited?.has(step.id) ? "visited" : status;
    }
    const headingId = step.model.accessibility.labelId;
    // Each of the step's components names this instance when it asks for the step to open.
    for (const entry of step.children[0]?.reveal ?? []) {
      if (entry.kind === "step" && entry.stepsId === node.id && entry.stepId === step.id) {
        memory.owners.set(entry, own);
      }
    }
    memory.headings.set(headingKey(own, step.id), headingId);
    const reached = status === "completed" || status === "visited";
    // A step a rule hides is listed, holding nothing: it is not a place to go.
    const select = !flat && step.id !== active && (authoring || (reached && step.visible)) ? () => void goTo(live, own, step.id) : undefined;
    return {
      id: step.id,
      label: step.label,
      status,
      statusText: status === "completed" ? words("stepCompleted") : status === "active" ? "" : words("stepNotCompleted"),
      tag: step.tag,
      shown: flat || step.id === active,
      hideLabel: step.hideLabel,
      classNames: step.classNames,
      headingId,
      content: stepContent(step, draw),
      ...(select ? { select } : {})
    };
  });

  // Back and Continue pass over a step a rule hides (the builder canvas, which shows every step, does not).
  const open = (step: PresentationStep): boolean => authoring || step.visible;
  const previous = flat ? undefined : node.steps.slice(0, activeIndex).reverse().find(open);
  const following = flat ? undefined : node.steps.slice(activeIndex + 1).find(open);
  const state: StepsState = {
    id: node.id,
    key: node.key,
    type: node.type,
    base: "steps",
    level: node.level,
    classNames: node.classNames,
    locale: draw.form.locale,
    dir: draw.form.dir,
    words,
    text: componentTextOf(node.model.node, draw.form.locale, draw.words.words),
    steps,
    eachStep: (drawStep) => html`${repeat(steps, (step) => step.id, (step) => drawStep(step))}`,
    flat,
    activeStepId: active,
    progress: total > 0 ? words("stepOf", { n: activeIndex + 1, total }) : "",
    others: draw.nodes(node.others),
    ...(previous ? { back: { label: words("back"), go: () => void goTo(live, own, previous.id) } } : {}),
    ...(following && active !== undefined ? { next: { label: words("continue"), go: () => void proceed(live, own, active, following.id, row) } } : {}),
    busy: live.busy() !== undefined
  };

  const resolved = live.resolve<StepsAdapter>("steps", node.type, "steps", state);
  let adapter: StepsAdapter = resolved?.adapter ?? defaultStepsAdapter;
  let from: "binding" | "binding-base" | "datum" | "datum-base" | "renderer" = resolved?.from ?? "renderer";
  let via = resolved?.via ?? node.type;
  if (resolved === undefined || resolved.from === "datum" || resolved.from === "datum-base") {
    live.report(`${node.id}: component "${node.type}"`);
  }
  let drawn = live.call("template", node.key, () => adapter.template(state));
  if (drawn === undefined && adapter !== defaultStepsAdapter) {
    // The binding's template threw: Datum's draws the container, never nothing.
    adapter = defaultStepsAdapter;
    from = "renderer";
    via = node.type;
    drawn = live.call("template", node.key, () => adapter.template(state));
  }
  live.recordAdapter(node.id, { from, via, ...(adapter.name !== undefined ? { name: adapter.name } : {}) });
  live.reportCapabilities(node.id, adapter, usedContainerCapabilities("group", state));

  let inner: TemplateResult = drawn ?? html`${steps.map((step) => (step.shown ? step.content : nothing))}${state.others}`;
  const canvas = live.options.canvasHooks?.renderContainer;
  if (canvas) {
    const base = inner;
    inner = live.call("renderContainer", node.key, () => canvas({ model: node.model, kind: "steps", label: undefined, slots: new Map(steps.map((step) => [step.id, step.content])) }, base)) ?? base;
  }
  // Datum's look (its adapter, or the renderer's own default, which is Datum's) inside another binding is tinted by its tokens.
  return draw.container(node, "steps", inner, undefined, from !== "binding" && from !== "binding-base");
}

// ── The feature ────────────────────────────────────────────────────────────────────────────

/** The steps container as a renderer module. */
export function stepsFeature(): LiveFeature {
  return {
    id: "steps",
    drawNode: (node, draw) => (node.kind === "steps" ? drawSteps(node, draw) : undefined),
    reveal: (reveals: readonly PresentationReveal[], live: LiveContext): boolean => {
      const memory = memoryOf(live);
      if (memory.flat) {
        return false;
      }
      let changed = false;
      for (const reveal of reveals) {
        if (reveal.kind !== "step") {
          continue;
        }
        const own = memory.owners.get(reveal) ?? reveal.stepsId;
        if (memory.active.get(own) === reveal.stepId) {
          continue;
        }
        // Shown now; the runtime follows (and may refuse, which puts the step back).
        memory.shown.set(own, reveal.stepId);
        memory.active.set(own, reveal.stepId);
        if (navigates(live, own)) {
          const undo = (): void => {
            if (memory.shown.get(own) === reveal.stepId) {
              memory.shown.delete(own);
              live.redraw();
            }
          };
          const move = (live.runtime as StepsRuntime).navigate?.(reveal.stepId);
          move?.then((result) => (result.ok ? undefined : undo()), undo);
        } else {
          setOf(memory.visited, own).add(reveal.stepId);
        }
        changed = true;
      }
      return changed;
    }
  };
}
