import { afterEach, describe, expect, it } from "vitest";

import "../src/builder.js";
import type { DatumFormBuilderChangeDetail, DatumFormBuilderElement } from "../src/builder.js";
import { branchingJourneyForm, until } from "./helpers.js";

afterEach(() => {
  document.body.innerHTML = "";
});

/*
 * With the PDF side off the layouts ride in the seed, and the form's moves reach them there: a
 * rename, an Undo or a Redo of one, and every move of where answers are stored, as one map a change.
 */

type Path = { source: { path: string } };

function definition(): unknown {
  return {
    id: "intake",
    version: "1.0.0",
    schemaVersion: "1",
    root: {
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          {
            id: "applicant",
            type: "container",
            configuration: { label: "Applicant", scopeData: true },
            children: { content: [{ id: "email", type: "text", configuration: { label: "Email" } }] }
          },
          { id: "first", type: "text", configuration: { label: "First" } },
          { id: "second", type: "text", configuration: { label: "Second" } }
        ]
      }
    },
    pdf: {
      layouts: [
        {
          id: "letter",
          kind: "template",
          name: "Letter",
          template: { storage: "base64", name: "letter.pdf", type: "application/pdf", size: 4, data: "JVBERg==" },
          fields: [
            { pdfField: "Email", source: { kind: "path", path: "applicant.email" } },
            { pdfField: "First", source: { kind: "path", path: "first" } },
            { pdfField: "Second", source: { kind: "path", path: "second" } }
          ]
        }
      ]
    }
  };
}

async function mount(): Promise<DatumFormBuilderElement> {
  const element = document.createElement("datum-form-builder") as DatumFormBuilderElement;
  element.setAttribute("pdf", "off");
  element.definition = definition() as never;
  document.body.append(element);
  await until(() => element.controller);
  return element;
}

function paths(element: DatumFormBuilderElement): string[] {
  const layout = element.definition.pdf?.layouts?.[0] as unknown as { fields: Path[] };
  return layout.fields.map((field) => field.source.path);
}

/** The change as the inner builder announces it, for a controller that has not announced it yet. */
function announce(element: DatumFormBuilderElement, detail: Record<string, unknown>): void {
  const inner = (element as unknown as { builderEl: HTMLElement }).builderEl;
  inner.dispatchEvent(new CustomEvent("builder-change", { detail: { root: element.definition.root, selectedComponentId: undefined, reason: "edit", ...detail } }));
}

describe("the PDF layouts in the seed follow the form", () => {
  it("follow a rename of a component in a scoped container, its Undo and its Redo, each way by the path the answer is stored under", async () => {
    const element = await mount();
    const controller = element.controller!;
    controller.select("email");
    controller.setDraftId("email", "mail");
    expect(controller.commitDraft("email")).toBe(true);
    expect(paths(element)[0]).toBe("applicant.mail");
    controller.undo();
    expect(paths(element)[0]).toBe("applicant.email");
    controller.redo();
    expect(paths(element)[0]).toBe("applicant.mail");
    controller.undo();
    expect(paths(element)[0]).toBe("applicant.email");
  });

  it("follow a data key edit as it is made", async () => {
    const element = await mount();
    element.controller!.setProperty("first", "dataKey", "given");
    expect(paths(element)).toEqual(["applicant.email", "given", "second"]);
  });

  it("follow a data key edit's Undo and Redo from the controller itself", async () => {
    const element = await mount();
    const controller = element.controller!;
    controller.setProperty("first", "dataKey", "given");
    controller.undo();
    expect(paths(element)).toEqual(["applicant.email", "first", "second"]);
    controller.redo();
    expect(paths(element)).toEqual(["applicant.email", "given", "second"]);
    controller.undo();
    expect(paths(element)).toEqual(["applicant.email", "first", "second"]);
  });

  it("follow the moves an Undo announces, and the same moves again on a Redo", async () => {
    const element = await mount();
    element.controller!.setProperty("first", "dataKey", "given");
    announce(element, { dataMoved: [{ from: "given", to: "first" }], historyStep: "undo" });
    expect(paths(element)).toEqual(["applicant.email", "first", "second"]);
    announce(element, { dataMoved: [{ from: "first", to: "given" }], historyStep: "redo" });
    expect(paths(element)).toEqual(["applicant.email", "given", "second"]);
  });

  it("follow two keys swapped as one map, and the swap's Undo as one map back", async () => {
    const element = await mount();
    const swap = [
      { from: "first", to: "second" },
      { from: "second", to: "first" }
    ];
    announce(element, { dataMoved: swap });
    expect(paths(element)).toEqual(["applicant.email", "second", "first"]);
    announce(element, { dataMoved: swap, historyStep: "undo" });
    expect(paths(element)).toEqual(["applicant.email", "first", "second"]);
  });

  it("follow a rename an Undo announces by ids alone when no answer moved with it", async () => {
    const element = await mount();
    announce(element, { renameStepped: { from: "first", to: "initial", by: "redo" }, historyStep: "redo" });
    expect(paths(element)).toEqual(["applicant.email", "initial", "second"]);
    announce(element, { renameStepped: { from: "initial", to: "first", by: "undo" }, historyStep: "undo" });
    expect(paths(element)).toEqual(["applicant.email", "first", "second"]);
  });

  it("follow a rename and the moves beside it in the one change", async () => {
    const element = await mount();
    announce(element, { renamed: { from: "first", to: "initial" }, dataMoved: [{ from: "second", to: "other" }] });
    expect(paths(element)).toEqual(["applicant.email", "initial", "other"]);
  });

  it("are not rewritten by a change that moved nothing", async () => {
    const element = await mount();
    const before = element.definition.pdf;
    element.controller!.setProperty("first", "label", "Given name");
    expect(element.definition.pdf).toEqual(before);
  });
});

describe("the element's change tells the page the moves", () => {
  it("carries renameStepped, the moves and the history step, as copies", async () => {
    const element = await mount();
    const heard: DatumFormBuilderChangeDetail[] = [];
    element.addEventListener("datum-builder-change", (event) => {
      const detail = (event as CustomEvent<DatumFormBuilderChangeDetail>).detail;
      if (detail.mode === "form") {
        heard.push(structuredClone(detail));
        // A page that drains what it was told leaves the moves the seed follows whole.
        (detail.dataMoved as { from: string; to: string }[] | undefined)?.splice(0);
      }
    });
    element.controller!.setProperty("first", "dataKey", "given");
    expect(heard.at(-1)?.dataMoved).toEqual([{ from: "first", to: "given" }]);
    expect(paths(element)).toEqual(["applicant.email", "given", "second"]);
    expect(heard.at(-1)).not.toHaveProperty("historyStep");
    element.controller!.undo();
    expect(paths(element)).toEqual(["applicant.email", "first", "second"]);
    element.controller!.redo();
    expect(paths(element)).toEqual(["applicant.email", "given", "second"]);
    expect(heard.at(-1)?.historyStep).toBe("redo");
    expect(heard.at(-1)?.dataMoved).toEqual([{ from: "first", to: "given" }]);
    element.controller!.select("second");
    element.controller!.setDraftId("second", "other");
    element.controller!.commitDraft("second");
    element.controller!.undo();
    expect(heard.at(-1)?.renameStepped).toEqual({ from: "other", to: "second", by: "undo" });
    expect(heard.at(-1)?.historyStep).toBe("undo");
  });
});

describe("the element's rename is the page's own copy", () => {
  it("is not the object the seed route follows: a page editing the path it was told changes nothing there", async () => {
    const element = await mount();
    let told: DatumFormBuilderChangeDetail["renamed"];
    element.addEventListener("datum-builder-change", (event) => {
      const detail = (event as CustomEvent<DatumFormBuilderChangeDetail>).detail;
      if (detail.mode === "form" && detail.renamed) {
        told = detail.renamed;
        const move = detail.renamed.dataPath as { from: string; to: string } | undefined;
        if (move) {
          move.to = "applicant.elsewhere";
        }
      }
    });
    const controller = element.controller!;
    controller.select("email");
    controller.setDraftId("email", "mail");
    expect(controller.commitDraft("email")).toBe(true);
    expect(told?.dataPath).toBeDefined();
    expect(paths(element)[0]).toBe("applicant.mail");
  });
});

describe("a rename's own path move is told by the direction of the step", () => {
  it("is not replayed from an older rename of the same ids when the later one moved no path", async () => {
    const element = document.createElement("datum-form-builder") as DatumFormBuilderElement;
    element.setAttribute("pdf", "off");
    const form = definition() as { root: { children: { content: Array<{ children: { content: unknown[] } }> } }; pdf: { layouts: Array<{ fields: unknown[] }> } };
    form.root.children.content[0]!.children.content.push({ id: "contact", type: "text", configuration: { label: "Contact" } });
    form.pdf.layouts[0]!.fields.push({ pdfField: "Contact", source: { kind: "path", path: "applicant.contact" } });
    element.definition = form as never;
    document.body.append(element);
    await until(() => element.controller);
    const controller = element.controller!;
    controller.select("email");
    controller.setDraftId("email", "mail");
    expect(controller.commitDraft("email")).toBe(true);
    controller.setProperty("mail", "dataKey", "addr");
    controller.setProperty("contact", "dataKey", "email");
    expect(paths(element)).toEqual(["applicant.addr", "first", "second", "applicant.email"]);
    // The same ids again, this time with a data key in the way: the component's data stayed where it was.
    controller.select("mail");
    controller.setDraftId("mail", "email");
    expect(controller.commitDraft("mail")).toBe(true);
    const before = paths(element);
    controller.undo();
    expect(paths(element)).toEqual(before);
    expect(paths(element)[3]).toBe(controller.dataPathOf("contact"));
    controller.redo();
    expect(paths(element)).toEqual(before);
  });
});

describe("a step the seed followed while a side had no mode", () => {
  it("is undone and redone in the PDF layouts once the PDF mode has registered", async () => {
    const element = await mount();
    const controller = element.controller!;
    controller.select("email");
    controller.setDraftId("email", "mail");
    expect(controller.commitDraft("email")).toBe(true);
    controller.setProperty("first", "dataKey", "given");
    expect(paths(element)).toEqual(["applicant.mail", "given", "second"]);
    element.removeAttribute("pdf");
    await until(() => element.pdfMode !== undefined);
    expect(paths(element)).toEqual(["applicant.mail", "given", "second"]);
    controller.undo();
    expect(paths(element)).toEqual(["applicant.mail", "first", "second"]);
    controller.undo();
    expect(paths(element)).toEqual(["applicant.email", "first", "second"]);
    controller.redo();
    expect(paths(element)).toEqual(["applicant.mail", "first", "second"]);
    controller.redo();
    expect(paths(element)).toEqual(["applicant.mail", "given", "second"]);
  });

  it("is told once as a layout change when the registered mode takes it back", async () => {
    const element = await mount();
    const controller = element.controller!;
    controller.select("email");
    controller.setDraftId("email", "mail");
    expect(controller.commitDraft("email")).toBe(true);
    element.removeAttribute("pdf");
    await until(() => element.pdfMode !== undefined);
    const layoutChanges: unknown[] = [];
    element.addEventListener("datum-pdf-layout-change", (event) => layoutChanges.push((event as CustomEvent).detail));
    controller.undo();
    expect(layoutChanges).toHaveLength(1);
  });

  it("is not taken back twice for a step the mode itself followed", async () => {
    const element = await mount();
    element.removeAttribute("pdf");
    await until(() => element.pdfMode !== undefined);
    const controller = element.controller!;
    controller.select("email");
    controller.setDraftId("email", "mail");
    expect(controller.commitDraft("email")).toBe(true);
    expect(paths(element)[0]).toBe("applicant.mail");
    controller.undo();
    expect(paths(element)[0]).toBe("applicant.email");
    controller.redo();
    expect(paths(element)[0]).toBe("applicant.mail");
  });

  it("is undone and redone in the journeys once the Journeys mode has registered", async () => {
    const element = document.createElement("datum-form-builder") as DatumFormBuilderElement;
    element.setAttribute("pdf", "off");
    element.setAttribute("journeys", "off");
    element.definition = branchingJourneyForm();
    document.body.append(element);
    await until(() => element.controller);
    const controller = element.controller!;
    const pageOf = (id: string): unknown => element.journeyConfiguration?.journeys?.[0]?.pages.find((page) => page.id === id)?.components;
    controller.select("email");
    controller.setDraftId("email", "mail");
    expect(controller.commitDraft("email")).toBe(true);
    expect(pageOf("contact")).toEqual(["mail"]);
    element.removeAttribute("journeys");
    await until(() => element.journeyMode !== undefined);
    expect(pageOf("contact")).toEqual(["mail"]);
    controller.undo();
    expect(pageOf("contact")).toEqual(["email"]);
    controller.redo();
    expect(pageOf("contact")).toEqual(["mail"]);
  });
});
