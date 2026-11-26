import { describe, expect, it } from "vitest";
import {
  SESSION_IDLE_TIMEOUT_MS,
  SESSION_PURPOSE_MAX,
  SESSION_SUMMARY_MAX,
  SESSION_TOOL_ANNOTATIONS,
  SESSION_TOOL_NAMES,
  SESSION_TOOL_TEXTS,
  sessionToolSchemas
} from "../form-engine/agent/session-tools.js";

/**
 * The session pair's words and schemas. Chrome keeps one title,
 * description and schema per name per document, and the registrar registers the pair once for
 * a page that may hold a form, a builder or both, so the wording may name neither catalogue's
 * tools and the schemas must stay inside the keyword subset the sanity test allows.
 */
const ALLOWED_KEYWORDS = new Set(["type", "properties", "required", "enum", "items", "description", "minimum", "maximum", "maxLength"]);

function keywordsOf(schema: unknown, into: Set<string>): void {
  if (typeof schema !== "object" || schema === null) {
    return;
  }
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    into.add(key);
    if (key === "properties" && typeof value === "object" && value !== null) {
      for (const property of Object.values(value as Record<string, unknown>)) {
        keywordsOf(property, into);
      }
    } else if (key === "items") {
      keywordsOf(value, into);
    }
  }
}

describe("session tool texts", () => {
  it("names exactly the pair", () => {
    expect([...SESSION_TOOL_NAMES]).toEqual(["begin_session", "end_session"]);
    expect(Object.keys(SESSION_TOOL_TEXTS).sort()).toEqual(["begin_session", "end_session"]);
  });

  it("carries the exact titles", () => {
    expect(SESSION_TOOL_TEXTS.begin_session.title).toBe("Start a session");
    expect(SESSION_TOOL_TEXTS.end_session.title).toBe("End the session");
  });

  it("has non-empty descriptions of at most 600 characters", () => {
    for (const name of SESSION_TOOL_NAMES) {
      const { description } = SESSION_TOOL_TEXTS[name];
      expect(description.length).toBeGreaterThan(0);
      expect(description.length).toBeLessThanOrEqual(600);
    }
  });

  it("mentions Undo all and undo: true in both descriptions, and the Stop button where the banner is introduced", () => {
    for (const name of SESSION_TOOL_NAMES) {
      const { description } = SESSION_TOOL_TEXTS[name];
      expect(description).toContain("Undo all");
      expect(description).toContain("undo: true");
    }
    // The exact end_session text names the banner's Undo all button, not Stop (the
    // person already saw Stop while the session ran); the strings stay byte for byte.
    expect(SESSION_TOOL_TEXTS.begin_session.description).toContain("Stop");
  });

  it("names neither catalogue's own tools", () => {
    for (const name of SESSION_TOOL_NAMES) {
      const { description, title } = SESSION_TOOL_TEXTS[name];
      expect(description).not.toContain("undo_agent_changes");
      expect(description).not.toContain("history");
      expect(title).not.toContain("undo_agent_changes");
    }
  });

  it("promises the idle timeout the registrar arms and says the result describes the form or the builder", () => {
    expect(SESSION_IDLE_TIMEOUT_MS).toBe(45_000);
    expect(SESSION_TOOL_TEXTS.begin_session.description).toContain("45 seconds");
    for (const name of SESSION_TOOL_NAMES) {
      expect(SESSION_TOOL_TEXTS[name].description).toContain("the form or the builder");
    }
  });

  it("has empty annotations: UI state, nothing leaves the page", () => {
    expect(SESSION_TOOL_ANNOTATIONS).toEqual({});
  });
});

describe("session tool schemas", () => {
  const schemas = sessionToolSchemas();

  it("use only the keyword subset, with type object and a description on every property", () => {
    for (const name of SESSION_TOOL_NAMES) {
      const schema = schemas[name];
      expect(schema.type).toBe("object");
      const used = new Set<string>();
      keywordsOf(schema, used);
      expect([...used].filter((keyword) => !ALLOWED_KEYWORDS.has(keyword))).toEqual([]);
      for (const [key, property] of Object.entries(schema.properties as Record<string, Record<string, unknown>>)) {
        expect(typeof property.description, `${name}.${key}`).toBe("string");
        expect((property.description as string).length).toBeGreaterThan(0);
      }
    }
  });

  it("caps purpose at 200 and summary at 500, and types undo as boolean", () => {
    const begin = schemas.begin_session.properties as Record<string, Record<string, unknown>>;
    const end = schemas.end_session.properties as Record<string, Record<string, unknown>>;
    expect(begin.purpose).toMatchObject({ type: "string", maxLength: 200 });
    expect(end.summary).toMatchObject({ type: "string", maxLength: 500 });
    expect(end.undo).toMatchObject({ type: "boolean" });
    expect(SESSION_PURPOSE_MAX).toBe(200);
    expect(SESSION_SUMMARY_MAX).toBe(500);
  });

  it("requires purpose on begin_session and summary on end_session", () => {
    expect(schemas.begin_session.required).toEqual(["purpose"]);
    expect(schemas.end_session.required).toEqual(["summary"]);
  });

  it("carries target, form and builder on both, with the same wording", () => {
    const begin = schemas.begin_session.properties as Record<string, unknown>;
    const end = schemas.end_session.properties as Record<string, unknown>;
    for (const key of ["target", "form", "builder"]) {
      expect(begin[key]).toBeDefined();
      expect(end[key]).toEqual(begin[key]);
    }
    expect(begin.target).toMatchObject({ type: "string", enum: ["form", "builder"] });
    expect(Object.keys(begin).sort()).toEqual(["builder", "form", "purpose", "target"]);
    expect(Object.keys(end).sort()).toEqual(["builder", "form", "summary", "target", "undo"]);
  });

  it("round-trips through JSON and hands out fresh objects per call", () => {
    for (const name of SESSION_TOOL_NAMES) {
      expect(JSON.parse(JSON.stringify(schemas[name]))).toEqual(schemas[name]);
    }
    const again = sessionToolSchemas();
    expect(again).toEqual(schemas);
    expect(again.begin_session).not.toBe(schemas.begin_session);
    expect(again.begin_session.properties).not.toBe(schemas.begin_session.properties);
  });
});
