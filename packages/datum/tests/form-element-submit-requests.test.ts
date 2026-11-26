import { afterEach, describe, expect, it } from "vitest";

import "../src/form.js";
import type { DatumFormElement, DatumFormSubmitDetail } from "../src/form.js";
import { SubmitBusyError } from "@argusvane/datum-engine";

import { sampleDefinition, until } from "./helpers.js";

afterEach(() => {
  document.body.innerHTML = "";
});

const COUNTRIES = [{ value: "CA", label: "Canada" }];

const within = <T,>(promise: Promise<T>, ms: number): Promise<T | "TIMEOUT"> =>
  Promise.race([promise, new Promise<"TIMEOUT">((resolve) => setTimeout(() => resolve("TIMEOUT"), ms))]);

async function readyForm(): Promise<DatumFormElement> {
  const element = document.createElement("datum-form") as DatumFormElement;
  element.dataSources = { countries: COUNTRIES };
  element.definition = sampleDefinition();
  document.body.append(element);
  await until(() => element.renderer?.shadowRoot?.querySelector("form"));
  element.runtime!.setValue("fullName", "Ada Lovelace");
  return element;
}

/** Holds every accepted submit's delivery open until `release` is called. */
function holdDelivery(element: DatumFormElement): { submits: DatumFormSubmitDetail[]; release: () => void } {
  let release!: () => void;
  const delivery = new Promise<void>((resolve) => (release = resolve));
  const submits: DatumFormSubmitDetail[] = [];
  element.addEventListener("datum-submit", (event) => {
    const detail = (event as CustomEvent<DatumFormSubmitDetail>).detail;
    submits.push(detail);
    detail.waitUntil(delivery);
  });
  return { submits, release };
}

describe("<datum-form> a second submit while one is in flight", () => {
  it("joins the first when it asks for the same thing", async () => {
    const element = await readyForm();
    const { submits, release } = holdDelivery(element);
    const first = element.submit();
    await until(() => submits.length === 1);
    const second = element.submit();
    release();
    expect(await second).toBe(await first);
    expect(submits).toHaveLength(1);
  });

  it("is refused while a plain submit is in flight when it is a download, and downloads nothing", async () => {
    const element = await readyForm();
    const { submits, release } = holdDelivery(element);
    let downloads = 0;
    element.addEventListener("datum-download", (event) => {
      downloads += 1;
      event.preventDefault();
    });
    const first = element.submit();
    await until(() => submits.length === 1);
    await expect(element.submitAndDownload()).rejects.toBeInstanceOf(SubmitBusyError);
    release();
    expect((await first).accepted).toBe(true);
    expect(submits).toHaveLength(1);
    expect(downloads).toBe(0);
  });

  it("is refused once the definition changed under it, never answered with the old form's outcome", async () => {
    const element = await readyForm();
    const { submits, release } = holdDelivery(element);
    const first = element.submit();
    await until(() => submits.length === 1);
    const other = sampleDefinition();
    other.id = "other-form";
    element.definition = other;
    await expect(element.submit()).rejects.toMatchObject({ code: "submission.busy" });
    release();
    expect((await first).accepted).toBe(true);
    expect(submits).toHaveLength(1);
  });

  it("cannot be waited on by the delivery of the submit it would join", async () => {
    const element = await readyForm();
    let nested: Promise<unknown> | undefined;
    element.addEventListener("datum-submit", (event) => {
      const detail = (event as CustomEvent<DatumFormSubmitDetail>).detail;
      nested = element.submit();
      detail.waitUntil(nested);
    });
    const detail = await within(element.submit(), 2000);
    expect(detail).not.toBe("TIMEOUT");
    await expect(nested).rejects.toBeInstanceOf(SubmitBusyError);
    expect(element.submitting).toBe(false);
  });

  // The join would hand back a promise the delivery then waits on: a download's wrapper, or one
  // the listener chained on. Asked while datum-submit is being dispatched, it is refused instead.
  for (const [label, ask] of [
    ["a download listener waiting on submitAndDownload()", (element: DatumFormElement) => element.submitAndDownload()],
    ["a listener waiting on a promise chained on submit()", (element: DatumFormElement) => element.submit().then((detail) => detail)]
  ] as const) {
    it(`never waits on itself: ${label}`, async () => {
      const element = await readyForm();
      element.addEventListener("datum-download", (event) => event.preventDefault());
      let nested: Promise<unknown> | undefined;
      let listened = 0;
      element.addEventListener("datum-submit", (event) => {
        listened += 1;
        if (listened === 1) {
          nested = ask(element);
          (event as CustomEvent<DatumFormSubmitDetail>).detail.waitUntil(nested);
        }
      });
      const run = label.startsWith("a download") ? element.submitAndDownload() : element.submit();
      expect(await within(run, 2000)).not.toBe("TIMEOUT");
      await expect(nested).rejects.toBeInstanceOf(SubmitBusyError);
      expect(element.submitting).toBe(false);
    });
  }

  it("names the form in flight when it refuses a call after a definition swap", async () => {
    const element = await readyForm();
    const { submits, release } = holdDelivery(element);
    const first = element.submit();
    await until(() => submits.length === 1);
    const flying = element.definition!.id;
    const other = sampleDefinition();
    other.id = "other-form";
    element.definition = other;
    await expect(element.submit()).rejects.toMatchObject({ formId: flying });
    release();
    await first;
  });
});

describe("<datum-form> wasmTimeout", () => {
  it("falls back to the default for a value that is no time limit", () => {
    const element = document.createElement("datum-form") as DatumFormElement;
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY, "150" as unknown as number]) {
      element.wasmTimeout = 150;
      element.wasmTimeout = bad;
      expect(element.wasmTimeout).toBeUndefined();
    }
    element.wasmTimeout = 0;
    expect(element.wasmTimeout).toBe(0);
    element.wasmTimeout = 2500;
    expect(element.wasmTimeout).toBe(2500);
  });
});
