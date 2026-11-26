import { describe, expect, it } from "vitest";

import type { JourneyValidationRequest } from "../form-engine/core/journey/journey-types.js";
import {
  classifyValidatorFailure,
  journeyCheckKey,
  journeyReplyOutcome,
  journeyStableJson,
  normalizeValidationReply,
  scopeReplyToPage
} from "../form-engine/core/journey/journey-server-check.js";

/** The pure half of a journey's checks against the host's server. */

const request: JourneyValidationRequest = {
  formId: "f",
  formVersion: "1",
  journeyId: "apply",
  scope: "page",
  pageId: "about",
  values: { age: "30", "abroad.nation": "FR" },
  locale: "en"
};

describe("journeyCheckKey", () => {
  it("is a SHA-256 of the whole request, whatever order its keys were written in", () => {
    const key = journeyCheckKey(request);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    const reordered: JourneyValidationRequest = {
      locale: "en",
      values: { "abroad.nation": "FR", age: "30" },
      pageId: "about",
      scope: "page",
      journeyId: "apply",
      formVersion: "1",
      formId: "f"
    };
    expect(journeyCheckKey(reordered)).toBe(key);
  });

  it("differs when anything the server would judge differs", () => {
    const key = journeyCheckKey(request);
    for (const changed of [
      { ...request, values: { ...request.values, age: "31" } },
      { ...request, values: { ...request.values, reference: "R" } },
      { ...request, locale: "fr" },
      { ...request, pageId: "details" },
      { ...request, scope: "journey" as const },
      { ...request, journeyId: "other" },
      { ...request, formVersion: "2" }
    ]) {
      expect(journeyCheckKey(changed)).not.toBe(key);
    }
  });

  it("orders keys by code unit, never by locale collation", () => {
    expect(journeyStableJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: 2 }, B: 0, "é": 3, e: 4 })).toBe(
      '{"B":0,"a":{"c":2,"d":[{"y":2,"z":1}]},"b":1,"e":4,"é":3}'
    );
  });
});

describe("normalizeValidationReply", () => {
  it("reads componentId, else field, else a value path the resolver maps", () => {
    const resolve = (path: string): string | undefined => (path === "abroad.nation" ? "country" : undefined);
    expect(
      normalizeValidationReply(
        {
          accepted: false,
          errors: [
            { code: "a", componentId: "age", field: "ignored" },
            { code: "b", field: "age" },
            { code: "c", path: "abroad.nation" },
            { code: "d", path: "nowhere" },
            { code: "e" }
          ]
        },
        resolve
      )
    ).toEqual([
      { code: "a", source: "server", componentId: "age" },
      { code: "b", source: "server", componentId: "age" },
      { code: "c", source: "server", path: "abroad.nation", componentId: "country" },
      { code: "d", source: "server", path: "nowhere" },
      { code: "e", source: "server" }
    ]);
  });

  it("keeps a known severity, the message and the parameters, and calls every entry the server's", () => {
    expect(
      normalizeValidationReply({
        errors: [
          { code: "a", severity: "warning", message: "Check it", parameters: { min: 3 }, source: "client" },
          { code: "b", severity: "fatal", parameters: "nope" }
        ]
      })
    ).toEqual([
      { code: "a", source: "server", message: "Check it", severity: "warning", parameters: { min: 3 } },
      { code: "b", source: "server" }
    ]);
  });

  it("is undefined for anything that is not a verdict", () => {
    for (const reply of [undefined, null, "ok", [], {}, { errors: {} }, { errors: [null] }, { errors: [{ message: "no code" }] }, { errors: [{ code: "" }] }]) {
      expect(normalizeValidationReply(reply)).toBeUndefined();
    }
    expect(normalizeValidationReply({ errors: [] })).toEqual([]);
  });

  it("is undefined for an entry whose path is not a value path, never a reply that throws later", () => {
    // A JSON Pointer (Ajv's `instancePath`), a double index, a trailing dot: the form cannot
    // place any of them, so the whole reply is no verdict ("malformed").
    for (const path of ["/notes", "items[0][1]", "notes.", "a b"]) {
      expect(normalizeValidationReply({ errors: [{ code: "ok", path: "notes" }, { code: "bad", path }] })).toBeUndefined();
    }
    // A path left blank names nothing, as an absent one does.
    expect(normalizeValidationReply({ errors: [{ code: "blank", path: "  " }] })).toEqual([{ code: "blank", source: "server" }]);
    expect(normalizeValidationReply({ errors: [{ code: "row", path: "order.items[0].sku" }] })).toEqual([
      { code: "row", source: "server", path: "order.items[0].sku" }
    ]);
  });
});

describe("scopeReplyToPage", () => {
  it("keeps the page's components and the entries naming none", () => {
    const errors = [
      { code: "on-page", componentId: "age" },
      { code: "elsewhere", componentId: "notes" },
      { code: "form-level" },
      { code: "unresolved-path", path: "nowhere" }
    ];
    const known = new Set(["age", "resident", "notes"]);
    expect(scopeReplyToPage(errors, new Set(["age", "resident"]), (id) => known.has(id)).map((error) => error.code)).toEqual([
      "on-page",
      "form-level",
      "unresolved-path"
    ]);
  });

  it("keeps an entry naming a component the form does not have, as the form's own", () => {
    const errors = [
      { code: "typo", componentId: "agee", parameters: { limit: 3 } },
      { code: "proto", componentId: "__proto__" }
    ];
    const known = new Set(["age"]);
    expect(scopeReplyToPage(errors, new Set(["age"]), (id) => known.has(id))).toEqual([
      { code: "typo", parameters: { componentId: "agee", limit: 3 } },
      { code: "proto", parameters: { componentId: "__proto__" } }
    ]);
  });
});

describe("journeyReplyOutcome", () => {
  it("blocks on severity error, the default; warnings and notes alone are warnings", () => {
    expect(journeyReplyOutcome([])).toBe("clean");
    expect(journeyReplyOutcome([{ severity: "warning" }, { severity: "info" }])).toBe("warnings");
    expect(journeyReplyOutcome([{ severity: "warning" }, {}])).toBe("invalid");
    expect(journeyReplyOutcome([{ severity: "error" }])).toBe("invalid");
  });
});

describe("classifyValidatorFailure", () => {
  const withStatus = (status: unknown): Error => Object.assign(new Error("x"), { status });

  it("calls every status a server error, a 4xx included: an answer that is no verdict is an outage", () => {
    for (const status of [400, 401, 403, 404, 408, 410, 422, 429]) {
      expect(classifyValidatorFailure(withStatus(status), false)).toEqual({ outcome: "unavailable", reason: "server-error", status });
    }
    expect(classifyValidatorFailure(withStatus(503), false)).toEqual({ outcome: "unavailable", reason: "server-error", status: 503 });
    expect(classifyValidatorFailure({ status: 302 }, false)).toEqual({ outcome: "unavailable", reason: "server-error", status: 302 });
  });

  it("calls no status the network, and a timeout a timeout whatever the error says", () => {
    expect(classifyValidatorFailure(new TypeError("Failed to fetch"), false)).toEqual({ outcome: "unavailable", reason: "network" });
    expect(classifyValidatorFailure("offline", false)).toEqual({ outcome: "unavailable", reason: "network" });
    expect(classifyValidatorFailure(withStatus("404"), false)).toEqual({ outcome: "unavailable", reason: "network" });
    expect(classifyValidatorFailure(new Error("aborted"), true)).toEqual({ outcome: "unavailable", reason: "timeout" });
    expect(classifyValidatorFailure(withStatus(404), true)).toEqual({ outcome: "unavailable", reason: "timeout", status: 404 });
  });
});
