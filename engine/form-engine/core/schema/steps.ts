import type { ComponentNode } from "./types.js";

/**
 * A multi-step form: a `steps` container whose children are `step` containers,
 * shown one at a time with a step indicator, a Back and a Continue button. The runtime's
 * wizard navigation (`FormRuntime.navigate`, `next`, `back`, its hooks and gating rules)
 * already knows a `step` node; the container and its shell give it a place in the tree and
 * a face.
 */

export const STEPS_COMPONENT_TYPE = "steps";
export const STEP_COMPONENT_TYPE = "step";

/** The `step` children of a `steps` container, in order, from every slot. */
export function stepNodesOf(container: ComponentNode): ComponentNode[] {
  if (!container.children) {
    return [];
  }
  return Object.values(container.children)
    .flat()
    .filter((child) => child.type === STEP_COMPONENT_TYPE);
}

/** What the runtime's navigation state says about one step, as the shells read it. */
export interface StepsNavigationState {
  currentStepId?: string | undefined;
  visitedStepIds: readonly string[];
  completedStepIds: readonly string[];
}

/**
 * The step a `steps` container shows: the runtime's current step when it is one of this
 * container's, else the first — a form that has not navigated yet opens on its first step,
 * and a current step belonging to another container (two `steps` containers on one form) does
 * not move this one.
 */
export function activeStepId(container: ComponentNode, navigation: StepsNavigationState | undefined): string | undefined {
  const steps = stepNodesOf(container);
  const current = navigation?.currentStepId;
  if (current !== undefined && steps.some((step) => step.id === current)) {
    return current;
  }
  return steps[0]?.id;
}

export type StepStatus = "active" | "completed" | "visited" | "upcoming";

/** A step's status against the navigation state, `active` for the step the container shows. */
export function stepStatus(stepId: string, active: string | undefined, navigation: StepsNavigationState | undefined): StepStatus {
  if (stepId === active) {
    return "active";
  }
  if (navigation?.completedStepIds.includes(stepId)) {
    return "completed";
  }
  if (navigation?.visitedStepIds.includes(stepId)) {
    return "visited";
  }
  return "upcoming";
}
