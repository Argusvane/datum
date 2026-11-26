import { describe, expect, it } from "vitest";

import {
  createDataSourceCapability,
  readSourceId
} from "../form-engine/core/schema/data-source-capability.js";
import { createInlineOptionsCapability } from "../form-engine/core/schema/inline-options.js";
import { buildInspectorModel } from "../form-engine/builder/property-editor/inspector-model.js";

describe("data source capability", () => {
  it("provides a Data source picker field, left to the inspector's own sectioning", () => {
    const capability = createDataSourceCapability();
    const contribution = capability.configureEditor?.({
      component: { id: "country", type: "select", configuration: {} }
    });

    expect(contribution?.fields?.[0]?.type).toBe("data-source-selector");
    expect(contribution?.fields?.[0]?.propertyPath).toBe("data.sourceId");
    // No section of its own: declaring one would drop every other capability's fields from
    // the panel (a declared section list is exhaustive), so the field takes the inspector's
    // natural "Data" group instead.
    expect(contribution?.sections).toBeUndefined();
  });

  it("offers the free-answers switch beside the source, at the default path only", () => {
    const fields = createDataSourceCapability().configureEditor?.({ component: { id: "c", type: "select", configuration: {} } })?.fields;
    expect(fields?.[1]).toMatchObject({ id: "data-answers-free", type: "boolean", propertyPath: "data.answersFree" });
    const custom = createDataSourceCapability({ sourcePropertyPath: "lookup.source" }).configureEditor?.({
      component: { id: "c", type: "select", configuration: {} }
    })?.fields;
    expect(custom).toHaveLength(1);
  });

  it("supports custom source property path", () => {
    const capability = createDataSourceCapability({ sourcePropertyPath: "lookup.source" });
    const contribution = capability.configureEditor?.({
      component: { id: "country", type: "select", configuration: {} }
    });

    expect(contribution?.fields?.[0]?.propertyPath).toBe("lookup.source");
  });

  it("reads the source id a configuration names, at the default or a custom path", () => {
    expect(readSourceId({ data: { sourceId: "countries" } })).toBe("countries");
    expect(readSourceId({ lookup: { source: "cities" } }, "lookup.source")).toBe("cities");
    expect(readSourceId({ data: { sourceId: "" } })).toBeUndefined();
    expect(readSourceId({ data: 4 })).toBeUndefined();
    expect(readSourceId(undefined)).toBeUndefined();
  });

  it("names the picker's path in shapeDependsOn where an options row follows it, so a change repaints the row", () => {
    const node = { id: "country", type: "select", configuration: { data: { sourceId: "countries" } } };
    const both = buildInspectorModel(node, [createInlineOptionsCapability(), createDataSourceCapability()]);
    expect(both.shapeDependsOn).toEqual(["data.sourceId"]);
    // No options row to keep in step: a live write of the picker stays live.
    expect(buildInspectorModel(node, [createDataSourceCapability()]).shapeDependsOn).toBeUndefined();
  });
});
