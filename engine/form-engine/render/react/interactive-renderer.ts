import type { ComponentNode } from "../../core/schema/types.js";
import type { FormState } from "../../core/state/form-state.js";
import type { DataSourceResolver } from "../core/component-options.js";
import { resolveOptionStatesForTree } from "../core/component-options.js";
import {
  buildComponentModels,
  type RenderComponentModel,
  type RenderModelContext
} from "../core/component-model.js";

export interface InteractiveRenderModel {
  mode: "interactive";
  components: RenderComponentModel[];
}

export async function buildInteractiveRenderModel(
  root: ComponentNode,
  state: FormState,
  resolver: DataSourceResolver,
  queryByComponentId: Record<string, Record<string, unknown>> = {},
  sourcePathByComponentId: Record<string, string> = {},
  modelContext: Omit<RenderModelContext, "readOnlyByMode"> = {}
): Promise<InteractiveRenderModel> {
  const optionStates = await resolveOptionStatesForTree(
    resolver,
    root,
    queryByComponentId,
    sourcePathByComponentId,
    { locale: modelContext.locale ?? state.locale, translations: modelContext.translations, translationCatalog: modelContext.translationCatalog }
  );

  return {
    mode: "interactive",
    components: buildComponentModels(root, state, optionStates, {
      ...modelContext,
      readOnlyByMode: false
    })
  };
}
