import { afterEach, describe, expect, it } from "vitest";

import "../src/form.js";
import type { DatumFormElement } from "../src/form.js";
import { SubmitBusyError, type FormPlugin } from "@argusvane/datum-engine";

import { sampleDefinition, until } from "./helpers.js";

/*
 * A plugin hook that awaits the element's own submit() is part of the run that call would
 * join: joining would have the run wait on itself for good. The element refuses it with a
 * SubmitBusyError, the run ends, and the form is no longer locked. A person's second click
 * while the answers are delivered still joins (form-element-submit-requests.test.ts).
 */

afterEach(() => {
  document.body.innerHTML = "";
});

const within = <T,>(promise: Promise<T>, ms: number): Promise<T | "TIMEOUT"> =>
  Promise.race([promise, new Promise<"TIMEOUT">((resolve) => setTimeout(() => resolve("TIMEOUT"), ms))]);

type HookName = "beforeSubmit" | "beforeValidation" | "afterValidation" | "afterSubmit";

async function formWithHook(name: HookName, nested: Array<unknown>): Promise<DatumFormElement> {
  const element = document.createElement("datum-form") as DatumFormElement;
  const plugin = {
    id: "reentrant-hook",
    version: "1",
    hooks: {
      [name]: [
        async () => {
          if (nested.length > 0) {
            return;
          }
          nested.push("asked");
          nested[0] = await within(
            element.submit().then(
              () => "joined",
              (error: unknown) => error
            ),
            1000
          );
        }
      ]
    }
  } as unknown as FormPlugin;
  element.plugins = [plugin];
  element.dataSources = { countries: [{ value: "CA", label: "Canada" }] };
  element.definition = sampleDefinition();
  document.body.append(element);
  await until(() => element.renderer?.shadowRoot?.querySelector("form"));
  element.runtime!.setValue("fullName", "Ada Lovelace");
  return element;
}

describe("<datum-form> a submit asked from one of the run's own hooks", () => {
  for (const name of ["beforeSubmit", "beforeValidation", "afterValidation", "afterSubmit"] as const) {
    it(`is refused from ${name}, and the run it is part of ends`, async () => {
      const nested: unknown[] = [];
      const element = await formWithHook(name, nested);
      const outcome = await within(element.submit(), 2000);
      expect(outcome).not.toBe("TIMEOUT");
      expect(nested[0]).toBeInstanceOf(SubmitBusyError);
      expect(element.submitting).toBe(false);
      // Nothing is held over: the next submit runs afresh.
      expect(await within(element.submit(), 2000)).not.toBe("TIMEOUT");
    });
  }
});
