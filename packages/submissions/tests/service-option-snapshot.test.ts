import { describe, expect, it } from "vitest";
import type { CanonicalSubmission, FormDefinition } from "@argusvane/datum-engine";

import {
  InMemorySubmissionStore,
  SubmissionServiceError,
  createKernelValidator,
  createSubmissionService,
  type OptionSnapshotProvider,
  type SubmissionSettings
} from "../src/index.js";

/**
 * The option snapshot seam: the server knows no data source,
 * so a choice that names one is refused unless the host supplies the lists, either as plain data
 * beside the form (`settings.validation.optionSnapshot`) or from a provider handed to the service.
 */

const FORM: FormDefinition = {
  id: "pick",
  version: "1",
  schemaVersion: "1",
  root: {
    id: "form",
    type: "form",
    configuration: { title: "Pick" },
    children: {
      content: [
        { id: "city", type: "select", configuration: { data: { sourceId: "cities" } } },
        { id: "colour", type: "select", configuration: { options: [{ value: "red", label: "Red" }] } },
        // Suggestions only: the author declared the answers free.
        { id: "town", type: "select", configuration: { data: { sourceId: "towns", answersFree: true } } }
      ]
    }
  }
};

function envelope(values: Record<string, unknown>, locale = "en"): CanonicalSubmission {
  return {
    versionContext: { form: { id: FORM.id, version: FORM.version }, client: { runtimeVersion: "1", rendererVersion: "1", schemaVersion: "1" } },
    submission: { locale, values }
  };
}

async function serviceWith(options: { provider?: OptionSnapshotProvider; validation?: Partial<SubmissionSettings["validation"]> } = {}) {
  let n = 0;
  const service = createSubmissionService({
    store: new InMemorySubmissionStore(),
    validator: createKernelValidator(),
    ids: () => `rec-${++n}`,
    ...(options.provider ? { optionSnapshot: options.provider } : {})
  });
  await service.register(FORM, options.validation ? { validation: { unknownFields: "strip", ...options.validation } } : undefined);
  return service;
}
const codes = (errors: ReadonlyArray<{ code: string; componentId?: string }>) => errors.map((error) => `${error.componentId ?? "-"}:${error.code}`);

describe("the submissions service's option snapshot seam", () => {
  it("takes any text for a source whose answers the author declared free, snapshot or none, and still holds the shape", async () => {
    const bare = await serviceWith();
    expect(codes((await bare.validate({ document: envelope({ town: "Nowhere" }) })).errors)).toEqual([]);
    const withList = await serviceWith({ validation: { optionSnapshot: { towns: [{ value: "ott" }] } } });
    expect(codes((await withList.validate({ document: envelope({ town: "Nowhere" }) })).errors)).toEqual([]);
    expect(codes((await bare.validate({ document: envelope({ town: 7 }) })).errors)).toEqual(["town:option.notAllowed"]);
  });

  it("refuses an answer to a source-backed choice when nothing supplies the source (fail closed)", async () => {
    const service = await serviceWith();
    const verdict = await service.validate({ document: envelope({ city: "ott" }) });
    expect(verdict.accepted).toBe(false);
    expect(codes(verdict.errors)).toEqual(["city:option.sourceUnavailable"]);
    // The inline list and an unanswered choice need no snapshot.
    expect(codes((await service.validate({ document: envelope({ colour: "red" }) })).errors)).toEqual([]);
  });

  it("holds the answer to the snapshot registered beside the form, in validate and receive", async () => {
    const service = await serviceWith({ validation: { optionSnapshot: { cities: [{ value: "ott", label: "Ottawa" }] } } });
    expect((await service.validate({ document: envelope({ city: "ott" }) })).accepted).toBe(true);
    expect(codes((await service.validate({ document: envelope({ city: "Atlantis" }) })).errors)).toEqual(["city:option.notAllowed"]);
    const kept = await service.receive({ submissionKey: crypto.randomUUID(), document: envelope({ city: "ott" }) });
    expect(kept.record.status).toBe("accepted");
    const refused = await service.receive({ submissionKey: crypto.randomUUID(), document: envelope({ city: "Atlantis" }) });
    expect(refused.record.status).toBe("rejected");
  });

  it("asks a provider with the definition, the answers and the locale, for every judgement", async () => {
    const seen: Array<{ id: string; values: Record<string, unknown>; locale: string | undefined }> = [];
    const service = await serviceWith({
      provider: (definition, values, locale) => {
        seen.push({ id: definition.id, values, locale });
        return { cities: [{ value: locale === "fr" ? "mtl" : "ott" }] };
      }
    });
    expect((await service.validate({ document: envelope({ city: "ott" }, "en") })).accepted).toBe(true);
    expect(codes((await service.validate({ document: envelope({ city: "ott" }, "fr") })).errors)).toEqual(["city:option.notAllowed"]);
    expect(seen).toEqual([
      { id: "pick", values: { city: "ott" }, locale: "en" },
      { id: "pick", values: { city: "ott" }, locale: "fr" }
    ]);
  });

  it("lets the provider's list win over the registered one per source, and keeps the sources it leaves out", async () => {
    const service = await serviceWith({
      validation: { optionSnapshot: { cities: [{ value: "old" }], other: [{ value: "x" }] } },
      provider: () => ({ cities: [{ value: "new" }] })
    });
    expect((await service.validate({ document: envelope({ city: "new" }) })).accepted).toBe(true);
    expect(codes((await service.validate({ document: envelope({ city: "old" }) })).errors)).toEqual(["city:option.notAllowed"]);
  });

  it("falls back to the registered snapshot when the provider answers nothing", async () => {
    const service = await serviceWith({ validation: { optionSnapshot: { cities: [{ value: "ott" }] } }, provider: () => undefined });
    expect((await service.validate({ document: envelope({ city: "ott" }) })).accepted).toBe(true);
  });

  it("a source the provider leaves out is unavailable for that judgement", async () => {
    const service = await serviceWith({ provider: () => ({}) });
    expect(codes((await service.validate({ document: envelope({ city: "ott" }) })).errors)).toEqual(["city:option.sourceUnavailable"]);
  });

  it("a provider that throws or rejects leaves no verdict (validator_unavailable) and keeps nothing", async () => {
    for (const provider of [
      () => {
        throw new Error("sources down");
      },
      async () => {
        throw new Error("sources down");
      }
    ] as OptionSnapshotProvider[]) {
      const service = await serviceWith({ provider });
      await expect(service.receive({ submissionKey: crypto.randomUUID(), document: envelope({ city: "ott" }) })).rejects.toMatchObject({ code: "validator_unavailable" });
      await expect(service.receive({ submissionKey: crypto.randomUUID(), document: envelope({ city: "ott" }) })).rejects.toBeInstanceOf(SubmissionServiceError);
      expect((await service.listRecords()).items).toEqual([]);
    }
  });

  it("takes a new snapshot from updateSettings without registering again", async () => {
    const service = await serviceWith();
    expect((await service.validate({ document: envelope({ city: "ott" }) })).accepted).toBe(false);
    await service.updateSettings("pick@1", { validation: { optionSnapshot: { cities: [{ value: "ott" }] } } });
    expect((await service.validate({ document: envelope({ city: "ott" }) })).accepted).toBe(true);
  });
});
