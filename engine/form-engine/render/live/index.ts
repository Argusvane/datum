/**
 * The narrow public surface the live renderer and its bindings read the engine through. Each
 * name here is the engine's own implementation (text wording, validation messages, row
 * labelling, tab and data-grid configuration, typed month and character counting, the
 * presentation tree and the summary entries); the renderer imports them from here rather
 * than from deep module paths.
 *
 * Nothing here pulls in lit, and `render/index.ts` does not
 * re-export this module, so the engine entry stays free of the renderer's dependencies.
 */
export { createFormTextResolver } from "../../core/localization/form-texts.js";
export { layerValidationMessages } from "../../core/localization/validation-messages.js";
export { rowModelsByValuePath } from "../core/error-wording.js";
export { journeyPageComponents } from "../core/journey-render.js";
export { readTabDescriptors, type TabDescriptor } from "../core/tab-slots.js";
export { dataGridSettingsOf } from "../../core/schema/data-grid.js";
export { readTypedMonth, readTypedNumber } from "../web-component/typed-answers.js";
export { countCharacters } from "../../core/schema/length-limits.js";
export * from "../core/presentation-tree.js";
export type {
  ErrorSummaryEntry,
  ErrorSummaryFormEntry,
  ErrorSummaryWording
} from "../core/error-summary.js";
