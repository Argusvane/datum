import type {
  CapabilityDefinition,
  PropertyEditorContribution,
  PropertyEditorDefinition,
  PropertyEditorFeature,
  PropertyEditorField,
  PropertyEditorSection
} from "../../core/schema/contracts.js";

export interface ComposedPropertyEditor {
  mode: "default" | "extend" | "replace" | "none";
  fields: PropertyEditorField[];
  sections: PropertyEditorSection[];
  features: PropertyEditorFeature[];
  render?: PropertyEditorDefinition["render"];
}

function mergeContributions(
  contributions: PropertyEditorContribution[]
): Pick<ComposedPropertyEditor, "fields" | "sections" | "features"> {
  const merged: Pick<ComposedPropertyEditor, "fields" | "sections" | "features"> = {
    fields: [] as PropertyEditorField[],
    sections: [] as PropertyEditorSection[],
    features: [] as PropertyEditorFeature[]
  };

  for (const contribution of contributions) {
    if (contribution.fields) {
      merged.fields.push(...contribution.fields);
    }
    if (contribution.sections) {
      merged.sections.push(...contribution.sections);
    }
    if (contribution.features) {
      merged.features.push(...contribution.features);
    }
  }

  return merged;
}

export function composePropertyEditor(
  capabilities: CapabilityDefinition[],
  capabilityContext: Parameters<NonNullable<CapabilityDefinition["configureEditor"]>>[0],
  componentEditor?: PropertyEditorDefinition
): ComposedPropertyEditor | undefined {
  const capabilityContributions = mergeContributions(
    capabilities
      .map((capability) => capability.configureEditor?.(capabilityContext))
      .filter((c): c is PropertyEditorContribution => Boolean(c))
  );

  const mode = componentEditor?.mode ?? "default";

  if (mode === "none") {
    return undefined;
  }

  if (mode === "replace") {
    return {
      mode,
      fields: [...(componentEditor?.fields ?? [])],
      sections: [...(componentEditor?.sections ?? [])],
      features: [...(componentEditor?.features ?? [])],
      render: componentEditor?.render
    };
  }

  if (mode === "default") {
    return {
      mode,
      fields: capabilityContributions.fields,
      sections: capabilityContributions.sections,
      features: capabilityContributions.features
    };
  }

  // Extend mode composes capability defaults with component-specific additions.
  return {
    mode,
    fields: [...capabilityContributions.fields, ...(componentEditor?.fields ?? [])],
    sections: [...capabilityContributions.sections, ...(componentEditor?.sections ?? [])],
    features: [...capabilityContributions.features, ...(componentEditor?.features ?? [])],
    render: componentEditor?.render
  };
}
