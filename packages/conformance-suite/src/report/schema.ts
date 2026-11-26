import schema from "./report.schema.json" with { type: "json" };

/** The JSON Schema (draft-07) every report validates against; `schemaVersion` 1. */
export const REPORT_SCHEMA: object = schema;
