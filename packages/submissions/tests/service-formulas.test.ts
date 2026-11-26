import { describe, expect, it } from "vitest";
import type { CanonicalSubmission, ComponentNode, FormDefinition } from "@argusvane/datum-engine";

import { InMemorySubmissionStore, SubmissionServiceError, createKernelValidator, createSubmissionService, statusOf, SUBMISSION_ROUTES } from "../src/index.js";

/**
 * Formulas on the server (the formulas plan): the definition is registered as written with a
 * compiled copy beside it, the policy decides what a formula that does not parse does, the day
 * `today()` reads is one value per judgement, and the definition a host serves to a browser has
 * no `server-secret` rule while the server still judges with it.
 */

function formWith(reason: ComponentNode["rules"], configuration: Record<string, unknown> = { title: "Apply" }): FormDefinition {
  return {
    id: "apply-form",
    version: "1",
    schemaVersion: "1",
    root: {
      id: "form",
      type: "form",
      configuration,
      children: {
        content: [
          { id: "employed", type: "checkbox", configuration: {} },
          { id: "reason", type: "text", configuration: {}, ...(reason ? { rules: reason } : {}) }
        ]
      }
    }
  };
}

function envelopeOf(definition: FormDefinition, values: Record<string, unknown>): CanonicalSubmission {
  return {
    versionContext: {
      form: { id: definition.id, version: definition.version },
      client: { runtimeVersion: "1.0.0", rendererVersion: "1.0.0", schemaVersion: "1" }
    },
    submission: { locale: "en", values }
  };
}

function make(options: { today?: () => string; clock?: () => Date } = {}) {
  const store = new InMemorySubmissionStore();
  let n = 0;
  const service = createSubmissionService({ store, validator: createKernelValidator(), ids: () => `rec-${++n}`, ...options });
  return { service, store };
}

const rule = (value: unknown): ComponentNode["rules"] => value as ComponentNode["rules"];
const reasonRequired = (record: { errors: Array<{ componentId?: string | undefined }> }): boolean => record.errors.some((error) => error.componentId === "reason");

describe("SubmissionService: formulas at register, serve and judge", () => {
  it("serves the public definition without a secret rule while judge enforces it, and reports serverRules", async () => {
    const definition = formWith(
      rule({
        requiredWhen: { formula: "employed = true", run: "server-secret" },
        visibleWhen: { formula: "employed = true or employed = false", run: "server" }
      })
    );
    const before = JSON.stringify(definition);
    const { service } = make();
    await service.register(definition);

    const served = await service.publicDefinition("apply-form@1");
    const text = JSON.stringify(served);
    expect(text).not.toContain("server-secret");
    expect(text).not.toContain("employed = true\"");
    const servedRules = (served.root.children?.content as ComponentNode[])[1]?.rules as Record<string, unknown>;
    expect(servedRules.requiredWhen).toBeUndefined();
    // A rule that is only server-side, not secret, is served as written.
    expect(servedRules.visibleWhen).toEqual({ formula: "employed = true or employed = false", run: "server" });
    // The field itself stays.
    expect((served.root.children?.content as ComponentNode[]).map((node) => node.id)).toEqual(["employed", "reason"]);

    // The stored original still holds the secret rule, and the verdict applies it.
    expect((await service.getEntry("apply-form@1"))?.definition).toEqual(JSON.parse(before));
    const { record } = await service.receive({ submissionKey: crypto.randomUUID(), document: envelopeOf(definition, { employed: true }) });
    expect(record.status).toBe("rejected");
    expect(reasonRequired(record)).toBe(true);
    expect(record.serverRules).toContain("reason");

    const answered = await service.receive({ submissionKey: crypto.randomUUID(), document: envelopeOf(definition, { employed: true, reason: "yes" }) });
    expect(answered.record.status).toBe("accepted");
    const idle = await service.receive({ submissionKey: crypto.randomUUID(), document: envelopeOf(definition, { employed: false }) });
    expect(idle.record.status).toBe("accepted");
  });

  it("folds in this process with the day the sandbox judged by, so a route on today() works out the same path the verdict took", async () => {
    const definition: FormDefinition = {
      ...formWith(undefined),
      journey: {
        journeys: [
          {
            id: "j",
            pages: [
              { id: "first", components: ["employed"], routes: [{ to: "late", when: 'today() >= "2026-01-01"' }, { to: "$end" }] },
              { id: "late", components: ["reason"], routes: [{ to: "$end" }] }
            ]
          }
        ]
      }
    };
    const withJourney = (values: Record<string, unknown>): CanonicalSubmission => {
      const envelope = envelopeOf(definition, values);
      return { ...envelope, submission: { ...envelope.submission, journey: { id: "j" } } };
    };
    const early = make({ today: () => "2025-06-01", clock: () => new Date(2030, 0, 1) });
    await early.service.register(definition);
    const late = make({ today: () => "2026-06-01", clock: () => new Date(2020, 0, 1) });
    await late.service.register(definition);

    // The trace is this process's fold: with the sandbox's day it takes the route the verdict took.
    expect((await early.service.validate({ document: withJourney({ employed: true, reason: "x" }) })).journey).toEqual({ pages: ["first"], end: "end" });
    expect((await late.service.validate({ document: withJourney({ employed: true, reason: "x" }) })).journey).toEqual({ pages: ["first", "late"], end: "end" });
    // And the record's judged values follow that path: an answer on the page the path skips is withheld.
    const earlyRecord = (await early.service.receive({ submissionKey: crypto.randomUUID(), document: withJourney({ employed: true, reason: "x" }) })).record;
    const lateRecord = (await late.service.receive({ submissionKey: crypto.randomUUID(), document: withJourney({ employed: true, reason: "x" }) })).record;
    expect(earlyRecord.status).toBe("accepted");
    expect(lateRecord.status).toBe("accepted");
    expect(earlyRecord.values?.reason).toBeUndefined();
    expect(lateRecord.values?.reason).toBe("x");
  });

  it("refuses to serve a form that is not registered", async () => {
    const { service } = make();
    await expect(service.publicDefinition("none@1")).rejects.toMatchObject({ code: "unknown_form" });
    expect(SUBMISSION_ROUTES.some((route) => route.method === "GET" && route.path === "/api/forms/:key/definition" && route.operation === "publicDefinition")).toBe(true);
  });

  it("judges a string rule as it judges the same rule as a tree", async () => {
    const asTree = formWith(
      rule({ requiredWhen: { kind: "binary", operator: "eq", left: { kind: "path", path: "employed" }, right: { kind: "literal", value: true } } })
    );
    const asString = formWith(rule({ requiredWhen: "employed = true" }));
    const outcomes: string[] = [];
    for (const definition of [asTree, asString]) {
      const { service } = make();
      await service.register(definition);
      for (const values of [{ employed: true }, { employed: false }, { employed: true, reason: "x" }]) {
        const { record } = await service.receive({ submissionKey: crypto.randomUUID(), document: envelopeOf(definition, values) });
        outcomes.push(`${record.status}:${record.errors.map((error) => `${error.componentId}/${error.code}`).join(",")}`);
      }
    }
    expect(outcomes.slice(0, 3)).toEqual(outcomes.slice(3));
    expect(outcomes[0]).toMatch(/^rejected:reason\//);
    expect(outcomes[1]).toBe("accepted:");
  });

  it("reads today() from the today dependency, else the local calendar date of the clock", async () => {
    const definition = formWith(rule({ requiredWhen: { formula: 'today() >= "2026-01-01"', run: "server" } }));
    const early = make({ today: () => "2025-06-01", clock: () => new Date(2030, 0, 1) });
    await early.service.register(definition);
    const a = await early.service.receive({ submissionKey: crypto.randomUUID(), document: envelopeOf(definition, {}) });
    expect(a.record.status).toBe("accepted");

    const late = make({ today: () => "2026-06-01", clock: () => new Date(2020, 0, 1) });
    await late.service.register(definition);
    const b = await late.service.receive({ submissionKey: crypto.randomUUID(), document: envelopeOf(definition, {}) });
    expect(b.record.status).toBe("rejected");
    expect(reasonRequired(b.record)).toBe(true);
    expect(b.record.clockDependent).toContain("reason");

    // No dependency: the clock's own local date is the day.
    const byClock = make({ clock: () => new Date(2026, 5, 1, 23, 59) });
    await byClock.service.register(definition);
    expect((await byClock.service.receive({ submissionKey: crypto.randomUUID(), document: envelopeOf(definition, {}) })).record.status).toBe("rejected");
    const before = make({ clock: () => new Date(2025, 11, 31, 23, 59) });
    await before.service.register(definition);
    expect((await before.service.receive({ submissionKey: crypto.randomUUID(), document: envelopeOf(definition, {}) })).record.status).toBe("accepted");
  });

  it("refuses to register a form with a bad formula by default and under fail, and registers it with the problems under the warn opt-in", async () => {
    const bad = formWith(rule({ requiredWhen: "employed = = true" }));

    // The default is fail.
    const byDefault = make();
    await expect(byDefault.service.register(bad)).rejects.toMatchObject({ code: "invalid_definition" });
    expect(await byDefault.service.getEntry("apply-form@1")).toBeUndefined();

    const refusing = make();
    await expect(refusing.service.register(bad, { validation: { unknownFields: "strip", formulaErrors: "fail" } })).rejects.toBeInstanceOf(SubmissionServiceError);
    await expect(refusing.service.register(bad, { validation: { unknownFields: "strip", formulaErrors: "fail" } })).rejects.toMatchObject({ code: "invalid_definition" });
    expect(statusOf({ code: "invalid_definition" })).toBe(422);
    expect(await refusing.service.getEntry("apply-form@1")).toBeUndefined();

    // The form's own word does the same when the server's setting is silent.
    const formFails = make();
    await expect(formFails.service.register(formWith(rule({ requiredWhen: "employed = = true" }), { title: "Apply", formulaErrors: "fail" }))).rejects.toMatchObject({
      code: "invalid_definition"
    });
    // The server's setting overrides the form's.
    const overridden = make();
    const entry = await overridden.service.register(formWith(rule({ requiredWhen: "employed = = true" }), { title: "Apply", formulaErrors: "fail" }), {
      validation: { unknownFields: "strip", formulaErrors: "warn" }
    });
    expect(entry.formulaProblems).toHaveLength(1);

    const warning = make();
    const registered = await warning.service.register(bad, { validation: { unknownFields: "strip", formulaErrors: "warn" } });
    expect(registered.formulaProblems).toHaveLength(1);
    expect(registered.formulaProblems?.[0]?.where).toContain("reason");
    // The rule that does not parse is absent when judging: nothing requires the field.
    const { record } = await warning.service.receive({ submissionKey: crypto.randomUUID(), document: envelopeOf(bad, { employed: true }) });
    expect(record.status).toBe("accepted");
  });

  // A rule holds only for the boolean true, on the server as in the browser.
  it("requires a field for a rule that comes to true and not for one that comes to text, a number or a list", async () => {
    const outcome = async (requiredWhen: string): Promise<boolean> => {
      const definition = formWith(rule({ requiredWhen }));
      const { service } = make();
      await service.register(definition);
      const { record } = await service.receive({ submissionKey: crypto.randomUUID(), document: envelopeOf(definition, { employed: true }) });
      return reasonRequired(record);
    };
    expect(await outcome("employed")).toBe(true);
    expect(await outcome("employed = true")).toBe(true);
    expect(await outcome('if employed then "yes"')).toBe(false);
    expect(await outcome("if employed then 1 else 0")).toBe(false);
    expect(await outcome("not employed")).toBe(false);
    expect(await outcome('upper("x")')).toBe(false);
  });

  it("never mutates the definition it is given or stores as the original", async () => {
    const definition = formWith(rule({ requiredWhen: { formula: "employed = true", run: "server-secret" }, visibleWhen: "employed = true" }));
    const before = JSON.stringify(definition);
    const { service } = make();
    const entry = await service.register(definition);
    expect(JSON.stringify(definition)).toBe(before);
    expect(JSON.stringify(entry.definition)).toBe(before);
    expect(JSON.stringify(entry.compiled)).not.toBe(before);

    await service.publicDefinition("apply-form@1");
    await service.receive({ submissionKey: crypto.randomUUID(), document: envelopeOf(definition, { employed: true }) });
    await service.validate({ formId: "apply-form", formVersion: "1", values: { employed: true } });
    expect(JSON.stringify(definition)).toBe(before);
    expect(JSON.stringify((await service.getEntry("apply-form@1"))?.definition)).toBe(before);
  });

  // A risky regular expression is refused unless the operator allows it.
  it("refuses a literal risky matches pattern at register (invalid_definition), registers it under warn or when allowed, and tells the sandbox", async () => {
    const risky = formWith(rule({ visibleWhen: 'matches(reason, "(a+)+$")' }));
    const byDefault = make();
    await expect(byDefault.service.register(risky)).rejects.toMatchObject({ code: "invalid_definition", message: expect.stringContaining("(a+)+$") });

    const warned = make();
    const entry = await warned.service.register(risky, { validation: { unknownFields: "strip", formulaErrors: "warn" } });
    expect(entry.formulaProblems).toMatchObject([{ code: "pattern.risky" }]);

    const allowed = make();
    const allowedEntry = await allowed.service.register(risky, { validation: { unknownFields: "strip", riskyPatterns: "allow" } });
    expect(allowedEntry.formulaProblems).toBeUndefined();
    expect(allowedEntry.settings.validation.riskyPatterns).toBe("allow");
    const { record } = await allowed.service.receive({ submissionKey: crypto.randomUUID(), document: envelopeOf(risky, { reason: "aaa" }) });
    expect(record.status).toBe("accepted");
  });

  it("does not run a risky field pattern: a hostile answer is refused under fail (pattern, risky) and no time is spent on it", async () => {
    const definition: FormDefinition = {
      id: "apply-form",
      version: "1",
      schemaVersion: "1",
      root: { id: "form", type: "form", configuration: {}, children: { content: [{ id: "code", type: "text", configuration: { pattern: "(a+)+$" } }] } }
    };
    const { service } = make();
    await service.register(definition);
    const started = Date.now();
    const { record } = await service.receive({ submissionKey: crypto.randomUUID(), document: envelopeOf(definition, { code: "a".repeat(40) + "!" }) });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(record.status).toBe("rejected");
    expect(record.errors).toMatchObject([{ code: "pattern", componentId: "code", parameters: { invalid: true, risky: true } }]);
  });

  it("answers the check inspection with pattern.risky unless the settings allow it", async () => {
    const risky = formWith(rule({ visibleWhen: 'matches(reason, "(a+)+$")' }));
    const warned = make();
    await warned.service.register(risky, { validation: { unknownFields: "strip", formulaErrors: "warn" } });
    const answer = await warned.service.inspect("apply-form@1", "check");
    expect(JSON.stringify(answer)).toContain("pattern.risky");
    const allowed = make();
    await allowed.service.register(risky, { validation: { unknownFields: "strip", formulaErrors: "warn", riskyPatterns: "allow" } });
    expect(JSON.stringify(await allowed.service.inspect("apply-form@1", "check"))).not.toContain("pattern.risky");
  });
});
