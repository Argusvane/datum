/**
 * The data-model planner's loader: `data-model-plan.ts` is fetched
 * the first time a browser-assistant tool builds from a JSON sample or schema, or reads the
 * form's data model, once per page. A failed load is forgotten so the next call tries again (the
 * Data surface's and the Tests panel's loaders do the same).
 *
 * Nothing here imports the planner statically: a value import would put it in the builder's
 * entry. The Data workspace's import imports it statically, so Rollup lays the planner in a chunk
 * both reach; that is the one module instance either side ever runs.
 */
export type DataModelPlanModule = typeof import("./data-model-plan.js");

let memo: Promise<DataModelPlanModule> | undefined;

/** The planner's module, fetched once; a rejected fetch is tried again on the next call. */
export function loadDataModelPlan(): Promise<DataModelPlanModule> {
  if (!memo) {
    const next = import("./data-model-plan.js");
    next.catch(() => {
      if (memo === next) {
        memo = undefined;
      }
    });
    memo = next;
  }
  return memo;
}
