// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import type { FormDefinition } from "../form-engine/core/schema/types.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { DATUM_FORM_HOST_TAG, defineDatumFormHostElement, type DatumFormHostElement } from "../form-engine/render/web-component/form-host-element.js";
import { DATUM_FORM_RENDERER_TAG, type DatumFormRendererElement } from "../form-engine/render/web-component/form-renderer-element.js";

/*
 * A property a page sets on <datum-form-renderer> or <datum-form-host> before the elements are
 * defined (a script that ran before the module) is taken up once the element is upgraded,
 * not left on the instance shadowing the element's own setter. Nothing in this file defines
 * the elements before the elements below are made.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

function runtimeOf(): FormRuntime {
  const form = {
    id: "intake",
    version: "1",
    schemaVersion: "1",
    localization: { defaultLocale: "en", supportedLocales: [{ code: "en" }] },
    root: { id: "root", type: "form", configuration: { title: "Intake" }, children: { content: [{ id: "name", type: "text", configuration: { label: "Name" } }] } }
  } as FormDefinition;
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
  return new FormRuntime(form, { submissionModes: modes, validationPipeline: new ValidationPipeline([]) });
}

describe("properties set before the engine's elements are defined", () => {
  it("are applied to the renderer and the host once they are upgraded", async () => {
    expect(customElements.get(DATUM_FORM_RENDERER_TAG)).toBeUndefined();
    expect(customElements.get(DATUM_FORM_HOST_TAG)).toBeUndefined();
    const rendererRuntime = runtimeOf();
    const hostRuntime = runtimeOf();
    const renderer = document.createElement(DATUM_FORM_RENDERER_TAG) as DatumFormRendererElement;
    const host = document.createElement(DATUM_FORM_HOST_TAG) as DatumFormHostElement;
    renderer.runtime = rendererRuntime;
    renderer.mode = "readonly";
    host.runtime = hostRuntime;
    host.features = "minimal";
    document.body.append(renderer, host);

    defineDatumFormHostElement();

    expect(Object.prototype.hasOwnProperty.call(renderer, "runtime")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(host, "runtime")).toBe(false);
    expect(renderer.runtime).toBe(rendererRuntime);
    expect(renderer.mode).toBe("readonly");
    await renderer.painted();
    expect(renderer.shadowRoot!.querySelector('[data-component-id="name"]')).not.toBeNull();

    const inner = host.shadowRoot!.querySelector("datum-form-renderer") as DatumFormRendererElement;
    expect(host.runtime).toBe(hostRuntime);
    expect(inner.runtime).toBe(hostRuntime);
    expect(inner.getAttribute("features")).toBe("minimal");
    await inner.painted();
    expect(inner.shadowRoot!.querySelector('[data-component-id="name"]')).not.toBeNull();
  });
});
