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
 *   previous one with no check. An indicator entry opens a step already reached; an upcoming one
 *   is not a way to skip ahead;
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

/** What the feature keeps for the life of the mount. */
interface StepsMemory {
  /** The step the renderer opened, by steps container id: the shown step on a runtime that cannot navigate, or a move still in flight. */
  shown: Map<string, string>;
  /** Steps reached and passed without the runtime recording it (a runtime that cannot navigate), by container id. */
  visited: Map<string, Set<string>>;
  completed: Map<string, Set<string>>;
  /** The step each container showed in the last draw. */
  active: Map<string, string | undefined>;
  /** Each step's heading id, by step id. */
  headings: Map<string, string>;
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

/** Whether the runtime moves between steps; the builder canvas, which only shows them, never does. */
function navigates(live: LiveContext): boolean {
  return typeof (live.runtime as StepsRuntime).navigate === "function" && live.options.canvasHooks === undefined;
}

// ── Moving ─────────────────────────────────────────────────────────────────────────────────

/** Moves the heading's focus to a step's heading, scrolled into view. */
function focusHeading(live: LiveContext, stepId: string): void {
  const id = memoryOf(live).headings.get(stepId);
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
async function showStep(live: LiveContext, containerId: string, stepId: string, focus: boolean): Promise<boolean> {
  const memory = memoryOf(live);
  if (navigates(live)) {
    const result = await (live.runtime as StepsRuntime).navigate?.(stepId);
    if (result?.ok !== true || !live.mounted()) {
      return false;
    }
    await live.updated();
  } else {
    memory.shown.set(containerId, stepId);
    setOf(memory.visited, containerId).add(stepId);
    live.redraw();
  }
  if (focus && live.mounted()) {
    focusHeading(live, stepId);
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

/** Continue: checks the step on show, and either goes to its first error or opens `next`. */
function proceed(live: LiveContext, containerId: string, current: string, next: string): Promise<void> {
  return moving(live, async () => {
    const authoring = live.options.canvasHooks !== undefined;
    const runtime = live.runtime as StepsRuntime;
    if (!authoring && typeof runtime.validate === "function") {
      const errors = await runtime.validate({ scope: current });
      const blocking = Array.isArray(errors) && errors.some((error) => ((error as { severity?: string } | undefined)?.severity ?? "error") === "error");
      if (blocking) {
        await live.updated();
        live.focusErrors();
        return;
      }
      if (typeof runtime.markStepCompleted === "function") {
        runtime.markStepCompleted(current);
      } else {
        setOf(memoryOf(live).completed, containerId).add(current);
      }
    }
    await showStep(live, containerId, next, true);
  });
}

function goTo(live: LiveContext, containerId: string, stepId: string): Promise<void> {
  return moving(live, async () => {
    await showStep(live, containerId, stepId, true);
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
  const moves = navigates(live);
  const flat = draw.tree.mode !== "interactive" || draw.form.printing;
  const ids = node.steps.map((step) => step.id);
  const navigation: StepsNavigationState = draw.output.meta.navigation;

  // The step the runtime shows, unless the renderer opened another: for good where nothing
  // navigates, until the runtime catches up (or refuses) where it does.
  let active = node.activeStepId;
  const opened = memory.shown.get(node.id);
  if (opened !== undefined) {
    if (!ids.includes(opened) || (moves && opened === node.activeStepId)) {
      memory.shown.delete(node.id);
    } else {
      active = opened;
    }
  }
  memory.active.set(node.id, active);
  memory.flat = flat;
  if (active !== undefined && !moves) {
    setOf(memory.visited, node.id).add(active);
  }

  const total = node.steps.length;
  const activeIndex = Math.max(0, ids.indexOf(active ?? ""));
  const words = draw.words;
  const visited = memory.visited.get(node.id);
  const completed = memory.completed.get(node.id);

  const steps: StepState[] = node.steps.map((step): StepState => {
    let status = stepStatus(step.id, active, navigation);
    if (!moves && status !== "active") {
      status = completed?.has(step.id) ? "completed" : visited?.has(step.id) ? "visited" : status;
    }
    const headingId = step.model.accessibility.labelId;
    memory.headings.set(step.id, headingId);
    const reached = status === "completed" || status === "visited";
    const select = !flat && step.id !== active && (authoring || reached) ? () => void goTo(live, node.id, step.id) : undefined;
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

  const previous = flat ? undefined : node.steps[activeIndex - 1];
  const following = flat ? undefined : node.steps[activeIndex + 1];
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
    ...(previous ? { back: { label: words("back"), go: () => void goTo(live, node.id, previous.id) } } : {}),
    ...(following && active !== undefined ? { next: { label: words("continue"), go: () => void proceed(live, node.id, active, following.id) } } : {}),
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
        if (reveal.kind !== "step" || memory.active.get(reveal.stepsId) === reveal.stepId) {
          continue;
        }
        // Shown now; the runtime follows (and may refuse, which puts the step back).
        memory.shown.set(reveal.stepsId, reveal.stepId);
        memory.active.set(reveal.stepsId, reveal.stepId);
        if (navigates(live)) {
          const undo = (): void => {
            if (memory.shown.get(reveal.stepsId) === reveal.stepId) {
              memory.shown.delete(reveal.stepsId);
              live.redraw();
            }
          };
          const move = (live.runtime as StepsRuntime).navigate?.(reveal.stepId);
          move?.then((result) => (result.ok ? undefined : undo()), undo);
        } else {
          setOf(memory.visited, reveal.stepsId).add(reveal.stepId);
        }
        changed = true;
      }
      return changed;
    }
  };
}
