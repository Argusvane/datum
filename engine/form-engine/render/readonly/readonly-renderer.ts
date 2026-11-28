import type { ComponentNode } from "../../core/schema/types.js";
import { formatFileSize, readFileAttachments } from "../../core/schema/file-upload.js";
import type { FormState } from "../../core/state/form-state.js";
import type { DataSourceResolver } from "../core/component-options.js";
import { resolveOptionStatesForTree } from "../core/component-options.js";
import {
  buildComponentModels,
  type RenderComponentModel,
  type RenderModelContext
} from "../core/component-model.js";

export interface ReadonlyComponentModel extends RenderComponentModel {
  displayValue: string;
}

export interface ReadonlyRenderModel {
  mode: "readonly";
  components: ReadonlyComponentModel[];
}

function displayValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  // A file's value is its attachments; a reader of the read-only form wants the names, not the bytes.
  const attachments = readFileAttachments(value);
  if (attachments.length > 0) {
    return attachments.map((attachment) => `${attachment.name} (${formatFileSize(attachment.size)})`).join(", ");
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  // A value no JSON holds (a cycle, a getter that throws, a function) reads as nothing rather
  // than failing the whole read-only render; a BigInt inside one reads as its digits.
  try {
    const text = JSON.stringify(value, (_key, inner: unknown) => (typeof inner === "bigint" ? inner.toString() : inner));
    return typeof text === "string" ? text : "";
  } catch {
    return "";
  }
}

export async function buildReadonlyRenderModel(
  root: ComponentNode,
  state: FormState,
  resolver: DataSourceResolver,
  modelContext: Omit<RenderModelContext, "readOnlyByMode"> = {}
): Promise<ReadonlyRenderModel> {
  const optionStates = await resolveOptionStatesForTree(resolver, root, {}, {}, {
    locale: modelContext.locale ?? state.locale,
    translations: modelContext.translations,
    translationCatalog: modelContext.translationCatalog
  });
  const models = buildComponentModels(root, state, optionStates, {
    ...modelContext,
    readOnlyByMode: true
  });

  return {
    mode: "readonly",
    components: models.map((model) => ({
      ...model,
      displayValue: displayValue(model.value)
    }))
  };
}
