import { BUTTON_COMPONENT_TYPE } from "../core/schema/button.js";
import { BUTTON_GROUP_COMPONENT_TYPE } from "../core/schema/button-group.js";
import { DATA_GRID_COMPONENT_TYPE } from "../core/schema/data-grid.js";
import { FILE_COMPONENT_TYPE } from "../core/schema/file-upload.js";
import { GRID_COMPONENT_TYPE } from "../core/schema/grid.js";
import { IMAGE_COMPONENT_TYPE } from "../core/schema/image.js";
import { HTML_COMPONENT_TYPE } from "../core/schema/static-html.js";
import { STEPS_COMPONENT_TYPE, STEP_COMPONENT_TYPE } from "../core/schema/steps.js";

/**
 * Component types that lay their children out in more than one field per row. Any other
 * container (`fieldset`, `section`, …) stacks its children one per row — the form default.
 */
export const LAYOUT_CONTAINER_TYPES: ReadonlySet<string> = new Set(["grid"]);

/**
 * Container types that organize other components but never render as an input themselves.
 * A floor under the render output's `containersById` check: a `fieldset` authored without a
 * `children` key at all is absent from `containersById`, and must still not render as a
 * stray text box.
 */
export const ALWAYS_CONTAINER_TYPES: ReadonlySet<string> = new Set([
  "form",
  "fieldset",
  "panel",
  "tabs",
  "container",
  BUTTON_GROUP_COMPONENT_TYPE,
  // A data grid: its children are the template of one row.
  DATA_GRID_COMPONENT_TYPE,
  // The containers that draw a shell of their own around their slots.
  GRID_COMPONENT_TYPE,
  STEPS_COMPONENT_TYPE,
  STEP_COMPONENT_TYPE
]);

/**
 * The component types the engine draws with no definition registered: its own controls and
 * its own containers. Any other type needs a definition (a host's `componentDefinitions`, a
 * plugin's `components`), a renderer of the host's, a plugin's or the theme's, or a container
 * renderer; a type with none of those is unknown, and the renderer draws a note naming the
 * type in its place rather than a text box or nothing at all.
 */
export const ENGINE_COMPONENT_TYPES: ReadonlySet<string> = new Set([
  "text",
  "number",
  "textarea",
  "select",
  "checkbox",
  "radio",
  "checkboxes",
  "date",
  FILE_COMPONENT_TYPE,
  BUTTON_COMPONENT_TYPE,
  HTML_COMPONENT_TYPE,
  IMAGE_COMPONENT_TYPE,
  ...ALWAYS_CONTAINER_TYPES,
  ...LAYOUT_CONTAINER_TYPES
]);
