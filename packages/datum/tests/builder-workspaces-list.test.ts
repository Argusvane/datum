import { afterEach, describe, expect, it } from "vitest";

import "../src/builder.js";
import type { DatumFormBuilderElement } from "../src/builder.js";

import { branchingJourneyForm, sampleDefinition, until } from "./helpers.js";

afterEach(() => {
  document.body.innerHTML = "";
});

function mount(setup: (element: DatumFormBuilderElement) => void): DatumFormBuilderElement {
  const element = document.createElement("datum-form-builder");
  setup(element);
  document.body.append(element);
  return element;
}

async function built(element: DatumFormBuilderElement): Promise<void> {
  await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
}

describe("<datum-form-builder workspaces>", { timeout: 20000 }, () => {
  it("offers only the workspaces the list names, and fetches no side it leaves out", async () => {
    const element = mount((el) => {
      el.setAttribute("workspaces", "form logic");
      el.definition = sampleDefinition();
    });
    await built(element);
    expect(element.workspaces).toEqual(["form", "logic"]);
    expect(element.builder!.availableWorkspaces()).toEqual(["form", "logic"]);
    // The form is still there, so this is no designer alone: its documents stay on the bar.
    expect(element.builder!.hiddenModeIds).toEqual([]);
    expect(element.mode).toBe("form");
    expect(element.pdfMode).toBeUndefined();
    expect(element.journeyMode).toBeUndefined();
    // The page's own hidden list is not the allow-list's complement.
    expect(element.hiddenWorkspaces).toEqual([]);
  });

  it("is taken from by hidden-workspaces, and gives every workspace back when the attribute goes", async () => {
    const element = mount((el) => {
      el.setAttribute("workspaces", "form logic data");
      el.setAttribute("hidden-workspaces", "data");
      el.definition = sampleDefinition();
    });
    await built(element);
    expect(element.builder!.availableWorkspaces()).toEqual(["form", "logic"]);
    element.removeAttribute("workspaces");
    expect(element.workspaces).toBeUndefined();
    await until(() => element.pdfMode !== undefined && element.journeyMode !== undefined);
    expect(element.builder!.availableWorkspaces()).not.toContain("data");
    expect(element.builder!.availableWorkspaces()).toEqual(expect.arrayContaining(["form", "logic", "languages", "pdf", "journeys"]));
  });

  it("reads a list that names no workspace as no list", async () => {
    const element = mount((el) => {
      el.setAttribute("workspaces", "nothing, real");
      el.definition = sampleDefinition();
    });
    await built(element);
    expect(element.workspaces).toBeUndefined();
    expect(element.builder!.availableWorkspaces()).toContain("form");
  });

  it("is the journeys alone for workspaces=\"journeys\": opens on them, the form's documents off the bar, no PDF side", async () => {
    const element = mount((el) => {
      el.workspaces = ["journeys"];
      el.definition = branchingJourneyForm();
    });
    expect(element.getAttribute("workspaces")).toBe("journeys");
    await until(() => element.journeyMode !== undefined);
    await until(() => element.mode === "journeys");
    expect(element.builder!.hidden).toBe(false);
    expect(element.builder!.hiddenModeIds).toEqual(["form"]);
    expect(element.builder!.availableWorkspaces()).toEqual(["journeys"]);
    expect(element.pdfMode).toBeUndefined();
    expect(element.definition.journey).toEqual(branchingJourneyForm().journey);
  });

  it("becomes the PDF layouts alone when the list is set on a builder already up, and the whole builder again without it", async () => {
    const element = mount((el) => {
      el.definition = sampleDefinition();
    });
    await until(() => element.pdfMode !== undefined);
    expect(element.mode).toBe("form");
    element.setAttribute("workspaces", "pdf");
    await until(() => element.mode === "pdf");
    expect(element.builder!.hiddenModeIds).toEqual(["form"]);
    expect(element.builder!.availableWorkspaces()).toEqual(["pdf"]);
    element.removeAttribute("workspaces");
    expect(element.builder!.hiddenModeIds).toEqual([]);
    expect(element.builder!.availableWorkspaces()).toContain("form");
  });

  it("opens on the layout layout-id names", async () => {
    const definition = sampleDefinition();
    const layout = (id: string) => ({ id, name: id, kind: "generated" as const, root: { id: `${id}-root`, type: "pdf-document", configuration: {}, children: { body: [] } } });
    const element = mount((el) => {
      el.setAttribute("workspaces", "pdf");
      el.setAttribute("layout-id", "second");
      el.definition = { ...definition, pdf: { layouts: [layout("first"), layout("second")], defaultLayoutId: "first" } };
    });
    await until(() => element.pdfMode?.ready);
    expect(element.layoutId).toBe("second");
    expect(element.pdfMode!.pdfLayout?.id).toBe("second");
    element.layoutId = "first";
    await until(() => element.pdfMode!.pdfLayout?.id === "first");
  });
});
