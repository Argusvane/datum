import type { DataModel, DataModelNode, DataModelOption } from "./data-model.js";

/** The dialect the export declares. */
export const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

/** What a file field stores (`core/schema/file-upload.ts`), as the export's `$defs/attachment`. */
const ATTACHMENT_SCHEMA = {
  type: "object",
  properties: {
    storage: { type: "string" },
    name: { type: "string" },
    type: { type: "string" },
    size: { type: "number" },
    data: { type: "string", contentEncoding: "base64" }
  },
  required: ["storage", "name", "type", "size"]
};

const EXPORTED_FORMATS: ReadonlySet<string> = new Set(["date", "date-time", "time", "email", "uri", "uuid"]);

function optionsSchema(options: readonly DataModelOption[], numeric: boolean): Record<string, unknown> {
  const value = (option: DataModelOption): unknown => (numeric && option.value.trim() !== "" && Number.isFinite(Number(option.value)) ? Number(option.value) : option.value);
  if (options.every((option) => option.label === undefined && option.description === undefined)) {
    return { enum: options.map(value) };
  }
  return {
    oneOf: options.map((option) => ({
      const: value(option),
      ...(option.label !== undefined ? { title: option.label } : {}),
      ...(option.description !== undefined ? { description: option.description } : {})
    }))
  };
}

function typeOf(name: string, nullable: boolean | undefined): string | string[] {
  return nullable ? [name, "null"] : name;
}

/**
 * The model as a JSON Schema (draft 2020-12) — the document a form's answers describe, nested
 * (a submission carries the same data as a flat map keyed by path). Objects close with
 * `additionalProperties: false`, as the sandbox strips keys the form does not define; a file
 * is `$defs/attachment`, which a schema read back in reads as a file again.
 */
export function dataModelToJsonSchema(model: DataModel): Record<string, unknown> {
  let usesAttachment = false;

  const convert = (node: DataModelNode): Record<string, unknown> => {
    const schema: Record<string, unknown> = {};
    if (node.label) {
      schema.title = node.label;
    }
    // A ticked field is listed in `required` below; the sentence is for one only a rule requires.
    const description = [node.description, node.requiredWhen && !node.required ? "Required when a rule of the form says so." : undefined].filter(Boolean).join(" ");
    if (description) {
      schema.description = description;
    }
    switch (node.kind) {
      case "string": {
        schema.type = typeOf("string", node.nullable);
        if (node.format && EXPORTED_FORMATS.has(node.format)) {
          schema.format = node.format;
        }
        if (node.pattern) {
          // The form checks the whole answer; a schema's pattern searches, so it is anchored.
          schema.pattern = `^(?:${node.pattern})$`;
        }
        if (node.minLength !== undefined) {
          schema.minLength = node.minLength;
        }
        if (node.maxLength !== undefined) {
          schema.maxLength = node.maxLength;
        }
        if (node.options && node.options.length > 0) {
          Object.assign(schema, optionsSchema(node.options, false));
        }
        break;
      }
      case "number":
      case "integer": {
        schema.type = typeOf(node.kind, node.nullable);
        if (node.minimum !== undefined) {
          schema.minimum = node.minimum;
        }
        if (node.maximum !== undefined) {
          schema.maximum = node.maximum;
        }
        if (node.options && node.options.length > 0) {
          Object.assign(schema, optionsSchema(node.options, true));
        }
        break;
      }
      case "boolean":
        schema.type = typeOf("boolean", node.nullable);
        break;
      case "null":
        schema.type = "null";
        break;
      case "object": {
        schema.type = typeOf("object", node.nullable);
        const children = node.children ?? [];
        if (node.format === "flags" && node.optionsSource) {
          // The options live in a data source: every key a boolean, the keys not known here.
          schema.additionalProperties = { type: "boolean" };
          break;
        }
        schema.properties = Object.fromEntries(children.map((child) => [child.key, convert(child)]));
        const required = node.format === "flags" ? children.map((child) => child.key) : children.filter((child) => child.required).map((child) => child.key);
        if (required.length > 0) {
          schema.required = required;
        }
        schema.additionalProperties = false;
        break;
      }
      case "array": {
        schema.type = typeOf("array", node.nullable);
        if (node.items) {
          schema.items = convert(node.items);
        }
        if (node.minItems !== undefined) {
          schema.minItems = node.minItems;
        }
        break;
      }
      case "file": {
        usesAttachment = true;
        if (node.nullable) {
          schema.anyOf = [{ $ref: "#/$defs/attachment" }, { type: "null" }];
        } else {
          schema.$ref = "#/$defs/attachment";
        }
        break;
      }
      default:
        break;
    }
    if (node.default !== undefined) {
      schema.default = node.default;
    }
    return schema;
  };

  const body = convert(model.root);
  const out: Record<string, unknown> = { $schema: JSON_SCHEMA_DIALECT };
  if (model.title) {
    out.title = model.title;
  }
  if (model.description) {
    out.description = model.description;
  }
  for (const [key, value] of Object.entries(body)) {
    if (key !== "title" && key !== "description") {
      out[key] = value;
    }
  }
  if (usesAttachment) {
    out.$defs = { attachment: ATTACHMENT_SCHEMA };
  }
  return out;
}
