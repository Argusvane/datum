/**
 * The Datum adapters of the containers, by the engine type each draws: the group containers
 * (`groups.ts`), tabs, steps and the data grid. `datumContainerComponents(options)` is what the
 * Datum binding spreads into its `components`; `options.controls` are the container choices a
 * design system's markup differs in (`DatumContainerControls`).
 *
 * The engine types with no shell of their own are drawn too: the form root and a `tab`
 * container (no group; the renderer names the `<form>` by the root's label) and
 * `repeatingSection` (the data grid, or the generic group).
 *
 * A collection-bound container (a repeating section) may be any container type, so every group
 * type also holds the data grid's adapter: the lookup picks the adapter of the node's kind, and a
 * node that is a grid is drawn as one whatever its type.
 */
import type { Adapter, AdapterEntry } from "../contract.js";
import { type DatumContainerControls } from "./container-kit.js";
import { createDatumGridAdapter } from "./grid.js";
import {
  createDatumButtonGroupAdapter,
  createDatumGroupAdapter,
  createDatumLayoutGridAdapter,
  createDatumPanelAdapter,
  createDatumStepAdapter,
  createDatumUngroupedAdapter,
  DATUM_CONTAINER_CSS
} from "./groups.js";
import type { DatumParts } from "./parts.js";
import { createDatumStepsAdapter } from "./steps.js";
import { createDatumTabsAdapter } from "./tabs.js";

export interface DatumContainerOptions {
  controls?: Partial<DatumContainerControls> | undefined;
  /** The host's part templates the containers draw (`stepBack`). */
  parts?: Pick<DatumParts, "stepBack" | "labelMarks" | "errorMessage"> | undefined;
}

export { DATUM_CONTAINER_CSS };

export function datumContainerComponents(options: DatumContainerOptions = {}): Record<string, AdapterEntry> {
  const kit = { controls: options.controls, parts: options.parts };
  const grid = createDatumGridAdapter(kit);
  const withGrid = (adapter: Adapter): AdapterEntry => [adapter, grid];
  const group = createDatumGroupAdapter(kit);
  return {
    // The generic group draws every container the engine has no shell for.
    fieldset: withGrid(group),
    container: withGrid(group),
    panel: withGrid(createDatumPanelAdapter(kit)),
    grid: withGrid(createDatumLayoutGridAdapter(kit)),
    step: withGrid(createDatumStepAdapter(kit)),
    "button-group": withGrid(createDatumButtonGroupAdapter(kit)),
    // The root and a tab's own container are no group; a repeating section is the data grid,
    // or the generic group where it is bound to no collection.
    form: withGrid(createDatumUngroupedAdapter("datum-form-root")),
    tab: withGrid(createDatumUngroupedAdapter("datum-tab")),
    repeatingSection: withGrid(group),
    tabs: createDatumTabsAdapter(kit),
    steps: createDatumStepsAdapter({ ...kit, parts: options.parts }),
    dataGrid: grid
  };
}
