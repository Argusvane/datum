import type { CapabilityDefinition, PropertyEditorContribution } from "./contracts.js";
import type { ComponentNode } from "./types.js";

/** Where a component names its data source unless a request says otherwise. */
export const DEFAULT_SOURCE_PROPERTY_PATH = "data.sourceId";

/** Where a component says the answers of its data source are free: `true` skips the snapshot check. */
export const ANSWERS_FREE_PROPERTY_PATH = "data.answersFree";

/** The data source id a configuration names at `path`, or `undefined` when it names none. */
export function readSourceId(
  configuration: unknown,
  path: string = DEFAULT_SOURCE_PROPERTY_PATH
): string | undefined {
  let cursor: unknown = configuration;
  for (const part of path.split(".")) {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return typeof cursor === "string" && cursor.length > 0 ? cursor : undefined;
}

export interface DataSourceCapabilityOptions {
  id?: string;
  version?: string;
  sourcePropertyPath?: string;
}

/**
 * The capability a component type declares to take its options from a data source: it
 * contributes a "Data source" picker (a `data-source-selector` field) that writes the source
 * id to `data.sourceId`. The picker lists the ids the host wired into the builder
 * (`dataSources` / `dataSourceIds`), and is a plain text box when it wired none. The field
 * lands in the inspector's Data section beside inline options (`createInlineOptionsCapability`).
 */
export function createDataSourceCapability(
  options: DataSourceCapabilityOptions = {}
): CapabilityDefinition {
  const sourcePropertyPath = options.sourcePropertyPath ?? DEFAULT_SOURCE_PROPERTY_PATH;

  return {
    id: options.id ?? "dataSource",
    version: options.version ?? "1.0.0",
    apply(component: ComponentNode): ComponentNode {
      if (!component.configuration || typeof component.configuration !== "object") {
        component.configuration = {};
      }
      return component;
    },
    configureEditor: () => {
      const contribution: PropertyEditorContribution = {
        fields: [
          {
            id: "data-source-id",
            type: "data-source-selector",
            propertyPath: sourcePropertyPath,
            label: "Data source",
            description: "Options come from this source; it takes precedence over inline options."
          },
          // Beside the source: a typeahead whose suggestions are not the only answers.
          // The server reads it at the default path only, so only the default path offers it.
          ...(sourcePropertyPath === DEFAULT_SOURCE_PROPERTY_PATH
            ? [
                {
                  id: "data-answers-free",
                  type: "boolean" as const,
                  propertyPath: ANSWERS_FREE_PROPERTY_PATH,
                  label: "Answers may be free text",
                  description:
                    "Suggestions are not the only answers allowed: the answer is not checked against the data source's list (it still keeps the field's own limits). Leave off to refuse an answer the list does not hold."
                }
              ]
            : [])
        ]
      };

      return contribution;
    }
  };
}
