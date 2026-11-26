import { describe, expect, it } from "vitest";
import type { FormDefinition } from "@argusvane/datum-engine";

import { InMemorySubmissionStore, aggregate, classifyComponent, countPerDay, createKernelValidator, createSubmissionService, recordsToCsv, walkValueFields, type SubmissionRecord } from "../src/index.js";

const SURVEY: FormDefinition = {
  id: "survey",
  version: "2.0.0",
  schemaVersion: "1.0.0",
  root: {
    id: "form",
    type: "form",
    configuration: { title: "Survey" },
    children: {
      content: [
        { id: "name", type: "text", configuration: { label: "Name" } },
        { id: "age", type: "number", configuration: { label: "Age" } },
        { id: "colour", type: "select", configuration: { label: "Colour", options: [{ value: "red", label: "Red" }, { value: "blue", label: "Blue" }, { value: "green", label: "Green" }] } },
        { id: "toppings", type: "checkboxes", configuration: { options: ["cheese", "olives"] } },
        { id: "agree", type: "checkbox", configuration: {} },
        {
          id: "address",
          type: "container",
          configuration: {},
          children: { content: [{ id: "city", type: "text", configuration: {} }] }
        },
        { id: "photo", type: "file", configuration: {} },
        { id: "go", type: "button", configuration: {} }
      ]
    }
  }
};

function record(id: string, receivedAt: string, values: Record<string, unknown>, extra: Partial<SubmissionRecord> = {}): SubmissionRecord {
  return {
    id,
    formId: "survey",
    formVersion: "2.0.0",
    receivedAt,
    status: "accepted",
    document: { versionContext: { form: { id: "survey", version: "2.0.0" }, client: { runtimeVersion: "1", rendererVersion: "1", schemaVersion: "1" } }, submission: { locale: "en", values } },
    digest: `d-${id}`,
    submissionKey: `k-${id}`,
    locale: "en",
    source: "renderer",
    errors: [],
    ...extra
  };
}

const RECORDS: SubmissionRecord[] = [
  record("a", "2026-09-13T09:00:00.000Z", { name: "Ada", age: 36, colour: "red", toppings: ["cheese"], agree: true, "address.city": "London" }),
  record("b", "2026-09-14T09:00:00.000Z", { name: "Grace", age: 45, colour: "blue", toppings: ["cheese", "olives"], agree: false, address: { city: "Arlington" } }, { locale: "fr" }),
  record("c", "2026-09-15T09:00:00.000Z", { name: "", age: "51", colour: "red", toppings: [] }),
  record("d", "2026-09-15T10:00:00.000Z", { name: "Rejected", age: 1000, colour: "green" }, { status: "rejected", errors: [{ code: "max", componentId: "age", stage: "field-constraints", source: "wasm" }] })
];

describe("field index and aggregation", () => {
  it("lists the value-bearing fields with their paths, kinds, labels and inline options; groups and buttons are left out", () => {
    const fields = walkValueFields(SURVEY);
    expect(fields.map((field) => `${field.componentId}:${field.kind}@${field.valuePath}`)).toEqual(["name:text@name", "age:number@age", "colour:choice@colour", "toppings:multi@toppings", "agree:boolean@agree", "city:text@address.city", "photo:file@photo", "go:other@go"]);
    expect(fields.find((field) => field.componentId === "age")?.label).toBe("Age");
    expect(fields.find((field) => field.componentId === "colour")?.options).toEqual(["red", "blue", "green"]);
    expect(fields.find((field) => field.componentId === "toppings")?.options).toEqual(["cheese", "olives"]);
  });

  it("names a keyed field by where its answer is stored, in the field list and the CSV", () => {
    const keyed: FormDefinition = {
      ...SURVEY,
      root: {
        id: "form",
        type: "form",
        configuration: {},
        children: {
          content: [
            {
              id: "billing_address",
              type: "container",
              configuration: { dataKey: "billing" },
              children: { content: [{ id: "billing_street", type: "text", configuration: { label: "Street", dataKey: "street" } }] }
            }
          ]
        }
      }
    };
    expect(walkValueFields(keyed)).toEqual([{ componentId: "billing_street", valuePath: "billing.street", type: "text", kind: "text", label: "Street" }]);
    const csv = recordsToCsv([record("k", "2026-09-27T00:00:00.000Z", { "billing.street": "1 Main" })], walkValueFields(keyed));
    const [header, row] = csv.split("\r\n");
    expect(header!.split(",").pop()).toBe("billing.street");
    expect(row!.split(",").pop()).toBe("1 Main");
  });

  it("treats a data grid as a group, empty or not: it is no value-bearing field of its own", () => {
    const withGrids: FormDefinition = {
      ...SURVEY,
      root: {
        id: "form",
        type: "form",
        configuration: {},
        children: {
          content: [
            { id: "owner", type: "text", configuration: { label: "Owner" } },
            {
              id: "dependants",
              type: "dataGrid",
              configuration: {},
              collection: { collectionPath: "dependants" },
              children: { content: [{ id: "kidName", type: "text", configuration: { label: "Name" } }] }
            },
            { id: "emptyGrid", type: "dataGrid", configuration: {}, collection: { collectionPath: "emptyGrid" } }
          ]
        }
      }
    };
    expect(classifyComponent({ id: "g", type: "dataGrid", configuration: {} })).toBe("group");
    expect(walkValueFields(withGrids).map((field) => field.componentId)).toEqual(["owner", "kidName"]);
  });

  it("counts per day, with or without a fixed window", () => {
    expect(countPerDay(RECORDS)).toEqual([
      { day: "2026-09-13", accepted: 1, rejected: 0 },
      { day: "2026-09-14", accepted: 1, rejected: 0 },
      { day: "2026-09-15", accepted: 1, rejected: 1 }
    ]);
    const window = countPerDay(RECORDS, { days: 5, now: new Date("2026-09-16T12:00:00.000Z") });
    expect(window.map((entry) => entry.day)).toEqual(["2026-09-12", "2026-09-13", "2026-09-14", "2026-09-15", "2026-09-16"]);
    expect(window[0]).toEqual({ day: "2026-09-12", accepted: 0, rejected: 0 });
    expect(window[3]).toEqual({ day: "2026-09-15", accepted: 1, rejected: 1 });
  });

  it("aggregates accepted records: acceptance, choices, numbers, completion, breakdowns; rejected ones on request", () => {
    const result = aggregate(RECORDS, SURVEY, { now: new Date("2026-09-15T12:00:00.000Z") });
    expect(result).toMatchObject({ total: 4, accepted: 3, rejected: 1, acceptanceRate: 0.75 });
    expect(result.byLocale).toEqual([{ value: "en", count: 2 }, { value: "fr", count: 1 }]);
    expect(result.byVersion).toEqual([{ value: "2.0.0", count: 3 }]);
    expect(result.bySource).toEqual([{ value: "renderer", count: 3 }]);

    const colour = result.choices.find((entry) => entry.field.componentId === "colour");
    expect(colour).toMatchObject({ answered: 3, other: 0, counts: [{ value: "red", count: 2 }, { value: "blue", count: 1 }] });
    const toppings = result.choices.find((entry) => entry.field.componentId === "toppings");
    expect(toppings).toMatchObject({ answered: 2, counts: [{ value: "cheese", count: 2 }, { value: "olives", count: 1 }] });
    const agree = result.choices.find((entry) => entry.field.componentId === "agree");
    expect(agree?.counts).toEqual([{ value: "false", count: 1 }, { value: "true", count: 1 }]);

    // Numbers as numbers, and a numeric string counts; the rejected 1000 does not.
    const age = result.numbers.find((entry) => entry.field.componentId === "age");
    expect(age).toMatchObject({ count: 3, min: 36, max: 51, sum: 132, median: 45 });
    expect(age?.mean).toBeCloseTo(44);
    expect(age?.p90).toBeCloseTo(49.8);

    // Completion: an empty string is unanswered; a nested answer is found flat or as an object.
    const completion = Object.fromEntries(result.completion.map((entry) => [entry.field.componentId, entry.answered]));
    expect(completion).toEqual({ name: 2, age: 3, colour: 3, toppings: 2, agree: 2, city: 2, photo: 0, go: 0 });
    expect(result.completion.find((entry) => entry.field.componentId === "name")?.rate).toBeCloseTo(2 / 3);
    expect(result.skipped.map((field) => field.componentId)).toEqual(["name", "city", "photo", "go"]);

    const withRejected = aggregate(RECORDS, SURVEY, { includeRejected: true, fields: ["age", "colour"], topValues: 1 });
    expect(withRejected.numbers[0]).toMatchObject({ count: 4, max: 1000 });
    expect(withRejected.choices[0]).toMatchObject({ counts: [{ value: "red", count: 2 }], other: 2 });
    expect(withRejected.completion).toHaveLength(2);

    expect(aggregate([], SURVEY)).toMatchObject({ total: 0, acceptanceRate: 0, perDay: [], numbers: [] });
  });

  it("writes CSV with the record columns then one per field, quoting as RFC 4180 asks", () => {
    const csv = recordsToCsv(RECORDS.slice(0, 2), walkValueFields(SURVEY));
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("id,receivedAt,status,locale,formVersion,source,digest,name,age,colour,toppings,agree,address.city,photo,go");
    expect(lines[1]).toBe("a,2026-09-13T09:00:00.000Z,accepted,en,2.0.0,renderer,d-a,Ada,36,red,cheese,true,London,,");
    expect(lines[2]).toBe("b,2026-09-14T09:00:00.000Z,accepted,fr,2.0.0,renderer,d-b,Grace,45,blue,cheese|olives,false,Arlington,,");
    expect(lines[3]).toBe("");
    const quoted = recordsToCsv([record("q", "2026-09-15T00:00:00.000Z", { name: 'Ada "the" Countess, Lovelace' })], walkValueFields(SURVEY));
    expect(quoted.split("\r\n")[1]).toContain('"Ada ""the"" Countess, Lovelace"');
  });

  it("counts and exports an answer that is not a scalar without throwing: an object entry as its JSON, a null entry as nothing", () => {
    // A store holds what a host put there; an entry whose own toString is not a function makes
    // String() throw, and the whole aggregate or export with it.
    const odd = record("o", "2026-09-15T00:00:00.000Z", {
      name: { toString: "x" },
      colour: { toString: 1, valueOf: 2 },
      toppings: [{ toString: "x" }, null, "cheese", 2],
      agree: true
    });
    const result = aggregate([odd], SURVEY);
    // A null entry is no answer, so it is not counted.
    const toppings = result.choices.find((entry) => entry.field.componentId === "toppings")?.counts.map((entry) => `${entry.value}=${String(entry.count)}`);
    expect(toppings?.sort()).toEqual(["2=1", "cheese=1", '{"toString":"x"}=1']);
    expect(result.choices.find((entry) => entry.field.componentId === "colour")?.counts).toEqual([{ value: '{"toString":1,"valueOf":2}', count: 1 }]);
    const line = recordsToCsv([odd], walkValueFields(SURVEY)).split("\r\n")[1];
    expect(line).toBe('o,2026-09-15T00:00:00.000Z,accepted,en,2.0.0,renderer,d-o,"{""toString"":""x""}",,"{""toString"":1,""valueOf"":2}","{""toString"":""x""}||cheese|2",true,,,');
  });

  it("the service aggregates and exports a form's records, and refuses a form it does not know", async () => {
    const store = new InMemorySubmissionStore();
    const service = createSubmissionService({ store, validator: createKernelValidator(), clock: () => new Date("2026-09-15T12:00:00.000Z") });
    await service.register(SURVEY);
    for (const entry of RECORDS) {
      await store.putRecord(entry);
    }
    const result = await service.aggregate("survey@2.0.0", { days: 3 });
    expect(result.total).toBe(4);
    expect(result.perDay.map((entry) => entry.day)).toEqual(["2026-09-13", "2026-09-14", "2026-09-15"]);
    const csv = await service.exportRecords("survey@2.0.0", "csv");
    expect(csv.fileName).toBe("survey-2.0.0-submissions.csv");
    expect(csv.mimeType).toBe("text/csv");
    expect(csv.text.split("\r\n")).toHaveLength(5); // header + 3 accepted + trailing newline
    const json = await service.exportRecords("survey@2.0.0", "json", { includeRejected: true });
    expect(json.fileName).toBe("survey-2.0.0-submissions.json");
    const parsed = JSON.parse(json.text) as Array<{ id: string; status: string; values: Record<string, unknown> }>;
    expect(parsed.map((entry) => entry.id)).toEqual(["a", "b", "c", "d"]);
    expect(parsed[3]?.status).toBe("rejected");
    await expect(service.aggregate("nobody@1")).rejects.toMatchObject({ code: "unknown_form" });
  });
});
