/**
 * Building a form from a data model without the DOM: the form's own model as an
 * import compares it, and what Add missing fields and Replace form contents would place. The
 * Data workspace's import, which draws the rows and buttons, imports these back (this module
 * never imports it: it touches the DOM); the browser-assistant tools (`add_components` / `replace_form` with
 * `fromData`, `get_definition { section: "data-model" }`) reach them through
 * `data-model-plan-loader.ts`, so the planner never rides in the builder's entry or in the
 * assistant's own chunk and nothing here touches a page.
 *
 * Pure: it reads a controller and returns plans; placing them is the caller's, through the
 * controller's own `requestInsertComponents` / `requestReplaceContent`, one undo step each, with
 * a thunk that plans again from the committed tree when the insert runs (as the import does).
 */
import type { ComponentNode } from "../../core/schema/types.js";
import type { BuilderController } from "../controller/builder-controller.js";
import type { DataModel } from "../data-model/data-model.js";
import { classifyComponentForDataModel, dataModelFromForm, type DataModelClassification } from "../data-model/from-form.js";
import { compareDataModels, type DataModelComparison } from "../data-model/compare.js";
import { planAddMissing, planReplace, type DataModelPlan, type DataModelReplacement, type GenerateOptions } from "../data-model/generate.js";
import { BuilderWords } from "../logic/builder-texts.js";

export { readDataModelInput, type DataModelReadAs, type DataModelSourceKind, type ReadDataModelResult } from "../data-model/read-input.js";
export { compareDataModels, type DataModelComparison, type DataModelComparisonEntry, type DataModelStatus } from "../data-model/compare.js";
export { dataModelToJsonSchema } from "../data-model/to-json-schema.js";
export { dataModelExample } from "../data-model/example.js";
export type { DataModel, DataModelNode, DataModelNote } from "../data-model/data-model.js";
export type { DataModelPlan, DataModelReplacement, GeneratedComponent, SkippedPlace } from "../data-model/generate.js";

/**
 * How a type the engine does not know takes part: a group when it has children, an answer
 * of unknown kind when its inspector offers a Data key (it holds a value), else nothing.
 */
export function dataModelClassifier(controller: BuilderController): (node: ComponentNode) => DataModelClassification | undefined {
  return (node) => {
    if (classifyComponentForDataModel(node) !== undefined) {
      return undefined;
    }
    if (node.children && Object.keys(node.children).length > 0) {
      return { role: "group" };
    }
    return controller.offersDataKey(node.type) ? { role: "value", kind: "unknown" } : { role: "none" };
  };
}

/** What a build may use: the ids the form claims, the types and templates the builder has, the builder's words for a skipped place. */
export function dataModelGenerateOptions(controller: BuilderController, words: BuilderWords): GenerateOptions {
  return {
    // What a journey's page-only fields hold: no component built takes it.
    takenIds: controller.claimedIds(),
    hasType: (type) => controller.hasComponentType(type),
    template: (type) => controller.componentTemplate(type),
    text: words.options()
  };
}

/** The form's data model as an import compares it, open drafts applied. */
export function formDataModel(controller: BuilderController): DataModel {
  return dataModelFromForm(controller.previewSnapshot(), { locale: controller.currentLocale(), classify: dataModelClassifier(controller) });
}

/** What Add missing fields would insert, with the incoming model laid over the form's committed one. */
export interface DataModelAddPlan extends DataModelPlan {
  /** Every incoming place against the form: new, present, held as something else (and the form's own at the end). */
  comparison: DataModelComparison;
}

/**
 * What Add missing fields would insert for `model`, planned over the committed tree (the drafts
 * the person has not applied are not built around): the import's own plan, so a field the
 * assistant adds is the one the Data workspace would. `words` word the reasons a place is
 * skipped (English when absent).
 */
export function planDataModelAdd(controller: BuilderController, model: DataModel, words: BuilderWords = new BuilderWords()): DataModelAddPlan {
  const options = dataModelGenerateOptions(controller, words);
  const committed = controller.snapshot();
  const formModel = dataModelFromForm(committed, { locale: controller.currentLocale(), classify: dataModelClassifier(controller) });
  const comparison = compareDataModels(formModel, model, { hasType: options.hasType });
  return { ...planAddMissing(committed, formModel, comparison, options), comparison };
}

/**
 * What Replace form contents would put in the form's place for `model`: a component for every
 * place, the root's closing buttons kept (`keep`), planned over the committed tree.
 */
export function planDataModelReplace(controller: BuilderController, model: DataModel, words: BuilderWords = new BuilderWords()): DataModelReplacement {
  return planReplace(controller.snapshot(), model, dataModelGenerateOptions(controller, words));
}
