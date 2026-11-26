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
 * Containers through <datum-form-renderer>: a grid's fields in their cells (which field in which
 * cell, an empty column kept, document order, the grid itself no field box), and a field inside a
 * data container written to its nested path.
 */

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function runtimeOf(content: ComponentNode[]): FormRuntime {
  const form = { id: "containers", version: "1", schemaVersion: "1", root: { id: "root", type: "form", configuration: {}, children: { content } } } as FormDefinition;
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "m", validate: true, sign: false, serverValidation: false });
  return new FormRuntime(form, { submissionModes: modes, validationPipeline: new ValidationPipeline([]) });
}

async function mounted(runtime: FormRuntime): Promise<ShadowRoot> {
  defineDatumFormRendererElement();
  const element = document.createElement(DATUM_FORM_RENDERER_TAG) as DatumFormRendererElement;
  element.runtime = runtime;
  document.body.append(element);
  await element.painted();
  return element.shadowRoot!;
}

const idsIn = (scope: ParentNode): string[] => [...scope.querySelectorAll<HTMLElement>("[data-component-id]")].map((box) => box.dataset.componentId!);

describe("a grid", () => {
  const text = (id: string, label: string): ComponentNode => ({ id, type: "text", configuration: { label } });

  it("draws its children in the grid, one cell per column, the empty third kept, and is not itself a field box", async () => {
    const root = await mounted(
      runtimeOf([
        text("fullName", "Full name"),
        {
          id: "address",
          type: "grid",
          configuration: { columns: 3 },
          children: {
            column_1: [text("street", "Street")],
            column_2: [text("city", "City"), text("region", "Region")]
          }
        },
        text("notes", "Notes")
      ])
    );

    const grid = root.querySelector<HTMLElement>('[data-container-id="address"]')!;
    expect(grid).toBeTruthy();
    expect(grid.dataset.kind).toBe("grid");
    // Every field is drawn once, in document order; the grid's own children sit inside its box and
    // the two plain fields outside it.
    expect(idsIn(root)).toEqual(["fullName", "street", "city", "region", "notes"]);
    expect(idsIn(grid)).toEqual(["street", "city", "region"]);

    // One cell per column, each stacking its own fields.
    const cells = [...grid.querySelectorAll<HTMLElement>("[data-grid-column]")];
    expect(cells.map((cell) => cell.dataset.gridColumn)).toEqual(["column_1", "column_2", "column_3"]);
    expect(idsIn(cells[0]!)).toEqual(["street"]);
    expect(idsIn(cells[1]!)).toEqual(["city", "region"]);
    expect(idsIn(cells[2]!)).toEqual([]);

    // The grid container is not rendered as a field.
    expect(root.querySelector('[data-component-id="address"]')).toBeNull();
  });
});

describe("a data container", () => {
  it("writes a field inside it to its nested path, and leaves a field outside it flat", async () => {
    const runtime = runtimeOf([
      { id: "reference", type: "text", configuration: { label: "Reference" } },
      {
        id: "applicant",
        type: "container",
        configuration: { label: "Applicant" },
        children: { content: [{ id: "email", type: "text", configuration: { label: "Email" } }] }
      }
    ]);
    const root = await mounted(runtime);
    const type = (id: string, value: string): void => {
      const input = root.querySelector<HTMLInputElement>(`[data-component-id="${id}"] input`)!;
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    };

    type("email", "a@b.c");
    type("reference", "R-1");

    // The container's id is a level in the data; a field outside it stays flat.
    expect(runtime.state().values["applicant.email"]).toBe("a@b.c");
    expect(runtime.state().values.email).toBeUndefined();
    expect(runtime.state().values.reference).toBe("R-1");
  });
});
