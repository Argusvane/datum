// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import {
  DATUM_FORM_RENDERER_TAG,
  defineDatumFormRendererElement,
  type DatumFormRendererElement
} from "../form-engine/render/web-component/form-renderer-element.js";

/*
 * The drawn form's text direction and its language switcher: dir follows the runtime's locale on
 * the form element (ltr by default, rtl for an Arabic locale), flips when the locale is switched
 * at runtime, and the switcher offers exactly the locales the form declares.
 */

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const wait = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(read: () => T | null | undefined | false, tries = 300): Promise<T> {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const value = read();
    if (value) {
      return value;
    }
    await wait(5);
  }
  throw new Error("never became true");
}

const DECLARED = ["en", "fr-CA", "ar-EG"];

function runtimeIn(locale: string): FormRuntime {
  const content: ComponentNode[] = [{ id: "fullName", type: "text", configuration: { label: "Full name" } }];
  const form = {
    id: "direction",
    version: "1",
    schemaVersion: "1",
    root: { id: "root", type: "form", configuration: {}, children: { content } },
    localization: { defaultLocale: locale, supportedLocales: DECLARED.map((code) => ({ code })) }
  } as FormDefinition;
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "m", validate: true, sign: false, serverValidation: false });
  return new FormRuntime(form, { submissionModes: modes, validationPipeline: new ValidationPipeline([]) });
}

async function mounted(runtime: FormRuntime, setup?: (element: DatumFormRendererElement) => void): Promise<ShadowRoot> {
  defineDatumFormRendererElement();
  const element = document.createElement(DATUM_FORM_RENDERER_TAG) as DatumFormRendererElement;
  setup?.(element);
  element.runtime = runtime;
  document.body.append(element);
  await element.painted();
  return element.shadowRoot!;
}

describe("the form's dir", () => {
  it("is ltr by default and rtl for an Arabic locale", async () => {
    const ltr = await mounted(runtimeIn("en"));
    expect(ltr.querySelector("form")?.getAttribute("dir")).toBe("ltr");
    document.body.innerHTML = "";

    const rtl = await mounted(runtimeIn("ar-EG"));
    expect(rtl.querySelector("form")?.getAttribute("dir")).toBe("rtl");
  });

  it("flips from ltr to rtl when the locale is switched at runtime, and back", async () => {
    const runtime = runtimeIn("en");
    const root = await mounted(runtime);
    expect(root.querySelector("form")?.getAttribute("dir")).toBe("ltr");

    await runtime.setLocale("ar-EG");
    await until(() => root.querySelector("form")?.getAttribute("dir") === "rtl");

    await runtime.setLocale("fr-CA");
    await until(() => root.querySelector("form")?.getAttribute("dir") === "ltr");
  });

  it("flips when the person picks the locale in the form's own switcher", async () => {
    const runtime = runtimeIn("en");
    const root = await mounted(runtime, (el) => {
      el.chrome = { header: [{ type: "language-switcher" }] };
    });
    const select = root.querySelector<HTMLSelectElement>("select[data-locale-switch]")!;
    select.value = "ar-EG";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await until(() => root.querySelector("form")?.getAttribute("dir") === "rtl");
  });
});

describe("the language switcher's options", () => {
  it("are exactly the locales the form declares, in the form's order, with none the runtime would refuse", async () => {
    const root = await mounted(runtimeIn("en"), (el) => {
      el.chrome = { header: [{ type: "language-switcher" }] };
    });
    const select = root.querySelector<HTMLSelectElement>("select[data-locale-switch]")!;
    expect(Array.from(select.options).map((option) => option.value)).toEqual(DECLARED);
  });
});
