import type { DataModel, DataModelNode } from "./data-model.js";

const FORMAT_EXAMPLES: Record<string, string> = {
  date: "2026-01-31",
  "date-time": "2026-01-31T09:30:00Z",
  time: "09:30",
  email: "name@example.com",
  uri: "https://example.com",
  uuid: "123e4567-e89b-12d3-a456-426614174000"
};

function exampleOf(node: DataModelNode): unknown {
  if (node.default !== undefined) {
    return node.default;
  }
  const firstOption = node.options?.[0]?.value;
  switch (node.kind) {
    case "string":
      return firstOption ?? (node.format ? FORMAT_EXAMPLES[node.format] : undefined) ?? "text";
    case "number":
    case "integer": {
      const option = firstOption !== undefined ? Number(firstOption) : Number.NaN;
      return Number.isFinite(option) ? option : (node.minimum ?? 0);
    }
    case "boolean":
      return false;
    case "object":
      return Object.fromEntries((node.children ?? []).map((child) => [child.key, node.format === "flags" ? false : exampleOf(child)]));
    case "array":
      return node.items ? [exampleOf(node.items)] : [];
    case "file":
      return { storage: "base64", name: "document.pdf", type: "application/pdf", size: 0 };
    default:
      return null;
  }
}

/**
 * One document the model allows, for a reader to see its shape: each key's default, else its
 * first choice, else a value of its format or kind; one entry in every list.
 */
export function dataModelExample(model: DataModel): Record<string, unknown> {
  return exampleOf(model.root) as Record<string, unknown>;
}
