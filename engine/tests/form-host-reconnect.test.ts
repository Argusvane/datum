// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FormDefinition } from "../form-engine/core/schema/types.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { DATUM_FORM_HOST_TAG, defineDatumFormHostElement, type DatumFormHostElement } from "../form-engine/render/web-component/form-host-element.js";
import type { DatumFormRendererElement } from "../form-engine/render/web-component/form-renderer-element.js";

/*
 * <datum-form-host> builds its toolbar, its listeners and its inner renderer once: taken off the
 * page and put back, one press still acts once, and moved within one task the renderer keeps
 * its form (the tab open in it) as a bare renderer does.
 */

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function runtimeOf(print?: Record<string, unknown>): FormRuntime {
  const form = {
    id: "intake",
    version: "1",
    schemaVersion: "1",
    localization: { defaultLocale: "en", supportedLocales: [{ code: "en" }] },
    root: {
      id: "root",
      type: "form",
      configuration: { title: "Intake", ...(print ? { print } : {}) },
      children: {
        content: [
          {
            id: "sections",
            type: "tabs",
            configuration: { tabs: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
            children: {
              a: [{ id: "email", type: "text", configuration: { label: "Email" } }],
              b: [{ id: "phone", type: "text", configuration: { label: "Phone" } }]
            }
          }
        ]
      }
    }
  } as FormDefinition;
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
  return new FormRuntime(form, { submissionModes: modes, validationPipeline: new ValidationPipeline([]) });
}

function hostWith(runtime: FormRuntime, parent: Element = document.body): DatumFormHostElement {
  defineDatumFormHostElement();
  const host = document.createElement(DATUM_FORM_HOST_TAG) as DatumFormHostElement;
  host.runtime = runtime;
  parent.append(host);
  return host;
}

const inner = (host: DatumFormHostElement): DatumFormRendererElement => host.shadowRoot!.querySelector("datum-form-renderer") as DatumFormRendererElement;
const press = (host: DatumFormHostElement, selector: string): void => host.shadowRoot!.querySelector<HTMLElement>(selector)!.click();
const tabsSelected = (renderer: DatumFormRendererElement): string =>
  [...renderer.shadowRoot!.querySelectorAll('[role="tab"]')].map((tab) => tab.getAttribute("aria-selected")).join(",");

describe("the form host put back on the page", () => {
  it("validates once per press after being taken off and put back", async () => {
    const host = hostWith(runtimeOf());
    host.remove();
    document.body.append(host);
    host.remove();
    document.body.append(host);
    const validate = vi.spyOn(inner(host), "validate").mockResolvedValue(undefined as never);
    press(host, "[data-validate]");
    expect(validate).toHaveBeenCalledTimes(1);
  });

  it("opens the Print menu of several renditions on one press after being put back", async () => {
    const host = hostWith(runtimeOf({ renditions: ["answers", "blank"] }));
    host.remove();
    document.body.append(host);
    press(host, "[data-print]");
    expect(host.shadowRoot!.querySelector<HTMLElement>("[data-print-menu]")!.hidden).toBe(false);
  });

  it("keeps its renderer and the tab open in it when moved within one task", async () => {
    const from = document.createElement("div");
    const to = document.createElement("div");
    document.body.append(from, to);
    const host = hostWith(runtimeOf(), from);
    const renderer = inner(host);
    await renderer.painted();
    renderer.shadowRoot!.querySelectorAll<HTMLElement>('[role="tab"]')[1]!.click();
    await renderer.painted();
    expect(tabsSelected(renderer)).toBe("false,true");

    to.append(host);
    await new Promise((done) => setTimeout(done, 20));
    await inner(host).painted();
    expect(inner(host)).toBe(renderer);
    expect(tabsSelected(inner(host))).toBe("false,true");
  });

  it("draws the form again when put back after leaving the page", async () => {
    const host = hostWith(runtimeOf());
    await inner(host).painted();
    host.remove();
    await new Promise((done) => setTimeout(done, 0));
    document.body.append(host);
    await inner(host).painted();
    expect(inner(host).shadowRoot!.querySelectorAll('[role="tab"]')).toHaveLength(2);
  });
});

describe("the form host's Print button", () => {
  it("starts no second print while one is in flight", async () => {
    const host = hostWith(runtimeOf());
    let finish: () => void = () => undefined;
    const print = vi.spyOn(inner(host), "print").mockImplementation(() => new Promise<void>((done) => (finish = done)));
    press(host, "[data-print]");
    press(host, "[data-print]");
    expect(print).toHaveBeenCalledTimes(1);
    finish();
    await new Promise((done) => setTimeout(done, 0));
    press(host, "[data-print]");
    expect(print).toHaveBeenCalledTimes(2);
  });

  it("starts no second print from the menu while one is in flight", async () => {
    const host = hostWith(runtimeOf({ renditions: ["answers", "blank"] }));
    const print = vi.spyOn(inner(host), "print").mockImplementation(() => new Promise<void>(() => undefined));
    press(host, "[data-print]");
    press(host, '[data-print-rendition="blank"]');
    press(host, "[data-print]");
    press(host, '[data-print-rendition="answers"]');
    expect(print).toHaveBeenCalledTimes(1);
    expect(print).toHaveBeenCalledWith({ rendition: "blank" });
  });
});

describe("the form host's printRenditions", () => {
  it("gives the renditions the form offers and its default, as the renderer does", () => {
    const runtime = runtimeOf({ renditions: ["blank", "answers"], defaultRendition: "blank" });
    defineDatumFormHostElement();
    const host = document.createElement(DATUM_FORM_HOST_TAG) as DatumFormHostElement;
    host.runtime = runtime;
    const expected = { offered: ["blank", "answers"], default: "blank" };
    // Before the host is on the page, and once its renderer is drawn.
    expect(host.printRenditions).toEqual(expected);
    document.body.append(host);
    expect(host.printRenditions).toEqual(expected);
    expect(host.printRenditions).toEqual(inner(host).printRenditions);
  });

  it("gives the defaults with no runtime", () => {
    defineDatumFormHostElement();
    const host = document.createElement(DATUM_FORM_HOST_TAG) as DatumFormHostElement;
    expect(host.printRenditions).toEqual({ offered: ["answers"], default: "answers" });
  });
});
