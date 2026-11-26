import { afterAll, describe, expect, it } from "vitest";
import { sandboxProgramHost } from "./fixtures/sandbox-host.js";
import type { CanonicalSubmission, FormDefinition } from "@argusvane/datum-engine";
import { APPLY_BELOW, presentationForm } from "@argusvane/datum-engine/tests/fixtures/presentation-form";

import {
  InMemorySubmissionStore,
  createKernelValidator,
  createProgramHostValidator,
  createSubmissionService,
  type SubmissionValidator
} from "../src/index.js";

/**
 * At the server, a number component's answer is a number and a date component's a
 * real date, in `validate` and `receive`, whichever way the server judges — the kernel
 * in-process or the sandbox program in QuickJS. A filled form field is an ordinary form field:
 * a forged non-numeric worked-out total is refused.
 */

const FORM: FormDefinition = {
  id: "household",
  version: "1.0.0",
  schemaVersion: "1.0.0",
  root: {
    id: "form",
    type: "form",
    configuration: { title: "Household" },
    children: {
      content: [
        { id: "members", type: "number", configuration: { required: true } },
        { id: "moved_in", type: "date", configuration: {} }
      ]
    }
  }
};

function envelopeOf(form: FormDefinition, values: Record<string, unknown>, journey?: { id: string }): CanonicalSubmission {
  return {
    versionContext: { form: { id: form.id, version: form.version }, client: { runtimeVersion: "1.0.0", rendererVersion: "1.0.0", schemaVersion: "1.0.0" } },
    submission: { locale: "en", values, ...(journey ? { journey } : {}) }
  };
}

const quickJsPromise = sandboxProgramHost();

afterAll(async () => {
  (await quickJsPromise).dispose();
});

async function validators(): Promise<Array<[string, SubmissionValidator]>> {
  return [
    ["kernel", createKernelValidator()],
    ["quickjs", createProgramHostValidator(await quickJsPromise)]
  ];
}

async function serviceFor(form: FormDefinition, validator: SubmissionValidator, settings?: Parameters<ReturnType<typeof createSubmissionService>["register"]>[1]) {
  const store = new InMemorySubmissionStore();
  let n = 0;
  const service = createSubmissionService({ store, validator, ids: () => `rec-${++n}` });
  await service.register(form, settings);
  return service;
}

function codes(errors: ReadonlyArray<{ code: string; componentId?: string }>): string[] {
  return errors.map((error) => `${error.componentId ?? "-"}:${error.code}`);
}

describe("SubmissionService: number and date answers", () => {
  it("refuses text on a number field and an impossible date, in validate and receive, both ways", async () => {
    for (const [label, validator] of await validators()) {
      const service = await serviceFor(FORM, validator);
      const document = envelopeOf(FORM, { members: "abc", moved_in: "2026-02-31" });
      const verdict = await service.validate({ document });
      expect(verdict.accepted, label).toBe(false);
      expect(codes(verdict.errors), label).toEqual(["members:number", "moved_in:date"]);
      const received = await service.receive({ submissionKey: crypto.randomUUID(), document });
      expect(received.record.status, label).toBe("rejected");
      expect(codes(received.errors), label).toEqual(["members:number", "moved_in:date"]);
    }
  });

  it("accepts numeric strings and real dates, both ways, keeping the answers as sent", async () => {
    for (const [label, validator] of await validators()) {
      const service = await serviceFor(FORM, validator);
      for (const members of ["3", " 4 ", 5]) {
        const document = envelopeOf(FORM, { members, moved_in: "2024-02-29" });
        expect(await service.validate({ document }), `${label} ${String(members)}`).toEqual({ accepted: true, errors: [] });
        const received = await service.receive({ submissionKey: crypto.randomUUID(), document });
        expect(received.record.status, label).toBe("accepted");
        expect(received.record.values, label).toEqual({ members, moved_in: "2024-02-29" });
      }
    }
  });

  it("gives what only a browser's control knows no weight: an empty answer is required or nothing", async () => {
    for (const [label, validator] of await validators()) {
      const service = await serviceFor(FORM, validator);
      const verdict = await service.validate({ document: envelopeOf(FORM, { members: "", moved_in: "" }) });
      expect(codes(verdict.errors), label).toEqual(["members:required"]);
    }
  });

  it("refuses a forged non-numeric worked-out total, both ways", async () => {
    const form = presentationForm();
    for (const [label, validator] of await validators()) {
      const service = await serviceFor(form, validator);
      const honest = await service.validate({ document: envelopeOf(form, APPLY_BELOW, { id: "apply" }) });
      expect(honest, label).toMatchObject({ accepted: true, errors: [] });
      const forged = await service.validate({ document: envelopeOf(form, { ...APPLY_BELOW, annual_income: "lots" }, { id: "apply" }) });
      expect(forged.accepted, label).toBe(false);
      expect(codes(forged.errors), label).toEqual(["annual_income:number"]);
      const received = await service.receive({ submissionKey: crypto.randomUUID(), document: envelopeOf(form, { ...APPLY_BELOW, annual_income: "lots" }, { id: "apply" }) });
      expect(received.record.status, label).toBe("rejected");
    }
  });
});

/**
 * The gate gaps at the server: a text that is not a string,
 * a number and a date outside their declared bounds, a file that is no attachment or too many of
 * them, a repeating section's entries, and a choice whose source the service has no options for.
 * The service passes the kernel no option snapshot (it knows no data source), so an answer to a
 * source-backed choice is refused (`option.sourceUnavailable`) until a host's validator
 * supplies one.
 */
describe("SubmissionService: the gate gaps", () => {
  const GATE: FormDefinition = {
    id: "gate",
    version: "1.0.0",
    schemaVersion: "1.0.0",
    root: {
      id: "form",
      type: "form",
      configuration: { title: "Gate" },
      children: {
        content: [
          { id: "code", type: "text", configuration: { maxLength: 3, pattern: "[A-Z]+" } },
          { id: "age", type: "number", configuration: { min: 18, max: 120 } },
          { id: "when", type: "date", configuration: { min: "2024-01-01", max: "2024-12-31" } },
          { id: "doc", type: "file", configuration: { accept: ".png" } },
          { id: "city", type: "select", configuration: { label: "City", data: { sourceId: "cities" } } },
          { id: "size", type: "select", configuration: { options: [{ value: "s", label: "S" }] } },
          {
            id: "lines",
            type: "repeatingSection",
            configuration: {},
            collection: { itemFields: ["sku", "qty", "total"] },
            children: {
              content: [
                { id: "sku", type: "text", configuration: { required: true, maxLength: 4 } },
                { id: "qty", type: "number", configuration: {} },
                { id: "total", type: "number", configuration: {}, rules: { value: "row.qty * 2" } }
              ]
            }
          }
        ]
      }
    }
  };
  const png = { storage: "inline", name: "a.png", type: "image/png", size: 10 };

  it("refuses what the browser's controls never send, both ways, in validate and receive", async () => {
    for (const [label, validator] of await validators()) {
      const service = await serviceFor(GATE, validator);
      const cases: Array<[Record<string, unknown>, string[]]> = [
        [{ code: 1234567 }, ["code:text"]],
        [{ code: { x: "abcdefgh" } }, ["code:text"]],
        [{ age: 17, when: "2025-01-01" }, ["age:number.min", "when:date.max"]],
        [{ age: 120, when: "2024-01-01" }, []],
        [{ doc: "a.exe" }, ["doc:file"]],
        [{ doc: [png, png] }, ["doc:fileCount"]],
        [{ doc: png }, []],
        [{ "lines[0].sku": "A", "lines[1].sku": "TOOLONG" }, ["sku:maxLength"]],
        [{ "lines[0].qty": 1, "lines[1].sku": "B" }, ["sku:required"]],
        [{ city: "Atlantis" }, ["city:option.sourceUnavailable"]],
        [{ city: "" }, []],
        [{ size: "forged" }, ["size:option.notAllowed"]]
      ];
      for (const [values, expected] of cases) {
        const document = envelopeOf(GATE, values);
        const verdict = await service.validate({ document });
        expect(codes(verdict.errors), `${label} ${JSON.stringify(values)}`).toEqual(expected);
        expect(verdict.accepted, label).toBe(expected.length === 0);
        const received = await service.receive({ submissionKey: crypto.randomUUID(), document });
        expect(received.record.status, label).toBe(expected.length === 0 ? "accepted" : "rejected");
      }
    }
  });

  it("stores a forged entry total as the server worked it out, both ways", async () => {
    for (const [label, validator] of await validators()) {
      const service = await serviceFor(GATE, validator);
      const received = await service.receive({ submissionKey: crypto.randomUUID(), document: envelopeOf(GATE, { "lines[0].sku": "A", "lines[0].qty": 2, "lines[0].total": 999 }) });
      expect(received.record.status, label).toBe("accepted");
      expect(received.record.values, label).toEqual({ "lines[0].sku": "A", "lines[0].qty": 2, "lines[0].total": 4 });
    }
  });

  it("passes the kernel the snapshot registered beside the form (the service's seam), and refuses a forged answer against it", async () => {
    const service = await serviceFor(GATE, createKernelValidator(), { validation: { unknownFields: "strip", optionSnapshot: { cities: [{ value: "ott" }] } } });
    expect((await service.validate({ document: envelopeOf(GATE, { city: "ott" }) })).accepted).toBe(true);
    expect(codes((await service.validate({ document: envelopeOf(GATE, { city: "Atlantis" }) })).errors)).toEqual(["city:option.notAllowed"]);
  });
});
