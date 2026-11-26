// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { defineDatumBuilderElement, type BuilderFileActions, type DatumBuilderElement } from "../form-engine/builder/web-component/default-builder-element.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { definitionSizeProblem } from "../form-engine/builder/web-component/definition-size.js";

/*
 * The bar's Open reads a chosen file only up to the builder's `maxDefinitionBytes` (2 MiB unless
 * set, the cap the elements hold a definition to): a longer file is refused by its size before a
 * byte of it is read, so a huge file never reaches the host's check or JSON.parse.
 */

defineDatumBuilderElement();

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function formRoot(): ComponentNode {
  return { id: "root", type: "form", configuration: { title: "Sample" }, children: { content: [{ id: "fullName", type: "text", configuration: { label: "Full name" } }] } };
}

function mount(actions: BuilderFileActions, setup?: (element: DatumBuilderElement) => void): DatumBuilderElement {
  const element = document.createElement("datum-builder") as DatumBuilderElement;
  element.options = { initialRoot: formRoot(), componentTypes: [{ type: "text", label: "Text" }] };
  element.fileActions = actions;
  setup?.(element);
  document.body.append(element);
  return element;
}

const q = <T extends HTMLElement = HTMLElement>(element: DatumBuilderElement, selector: string): T => element.shadowRoot!.querySelector<T>(selector)!;

async function until(check: () => unknown, timeoutMs = 4000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("until(): condition not met in time");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Chooses a file in the shell's hidden picker, as the browser would: files set, then a change. */
function chooseFile(element: DatumBuilderElement, file: File): void {
  const input = q<HTMLInputElement>(element, "[data-file-input]");
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("Open reads a file only up to the cap", () => {
  it("is 2 MiB unless set, and takes a whole number of bytes above 0 or undefined to put it back", () => {
    const element = mount({ open: () => () => undefined });
    expect(element.maxDefinitionBytes).toBe(2 * 1024 * 1024);
    element.maxDefinitionBytes = 4096;
    expect(element.maxDefinitionBytes).toBe(4096);
    expect(() => {
      element.maxDefinitionBytes = 0;
    }).toThrow(RangeError);
    expect(() => {
      element.maxDefinitionBytes = 1.5;
    }).toThrow(RangeError);
    expect(element.maxDefinitionBytes).toBe(4096);
    element.maxDefinitionBytes = undefined;
    expect(element.maxDefinitionBytes).toBe(2 * 1024 * 1024);
  });

  it("refuses a longer file by its size, reading none of it and asking the host nothing", async () => {
    const read = vi.spyOn(FileReader.prototype, "readAsText");
    const open = vi.fn(() => () => undefined);
    const element = mount({ open }, (el) => {
      el.maxDefinitionBytes = 2048;
    });
    await until(() => element.shadowRoot?.querySelector("[data-file-input]"));
    chooseFile(element, new File([`{"pad":"${"x".repeat(3072 - 10)}"}`], "big.json"));
    await until(() => !q(element, "[data-file-error]").hidden);
    expect(q(element, "[data-file-error-message]").textContent).toBe('Could not read "big.json": it is 3 KB; up to 2 KB is read.');
    expect(read).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("hands the host a file at the cap whole", async () => {
    const texts: string[] = [];
    const element = mount(
      {
        open: (file) => {
          texts.push(file.text);
          throw new Error("checked");
        }
      },
      (el) => {
        el.maxDefinitionBytes = 2048;
      }
    );
    await until(() => element.shadowRoot?.querySelector("[data-file-input]"));
    const text = `{"pad":"${"é".repeat((2048 - 10) / 2)}"}`;
    expect(new TextEncoder().encode(text).length).toBe(2048);
    chooseFile(element, new File([text], "exact.json"));
    await until(() => texts.length > 0);
    expect(texts).toEqual([text]);
  });
});

describe("the size sentence Open and the elements share", () => {
  it("names the size and the cap in whole units, says over when only part was read, and nothing within the cap", () => {
    expect(definitionSizeProblem(2 * 1024 * 1024, 2 * 1024 * 1024)).toBeUndefined();
    expect(definitionSizeProblem(3 * 1024 * 1024, 2 * 1024 * 1024)).toBe("it is 3,072 KB; up to 2 MB is read");
    expect(definitionSizeProblem(3000, 2048)).toBe("it is 3 KB; up to 2 KB is read");
    expect(definitionSizeProblem(1500, 1000, true)).toBe("it is over 1 KB; up to 1,000 bytes is read");
  });
});
