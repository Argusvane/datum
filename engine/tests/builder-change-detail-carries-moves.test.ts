// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { defineDatumBuilderElement, type DatumBuilderChangeDetail, type DatumBuilderElement } from "../form-engine/builder/web-component/default-builder-element.js";
import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

/*
 * A host that keeps references of its own to the form's components or answers (a PDF seed it
 * holds while no PDF mode is up) follows them from the builder-change detail: a rename, an Undo
 * or a Redo of one, and a move of where answers are stored all reach it there.
 */

defineDatumBuilderElement();

afterEach(() => {
  document.body.innerHTML = "";
});

function formRoot(): ComponentNode {
  return {
    id: "root",
    type: "form",
    configuration: { title: "Intake" },
    children: { content: [{ id: "fullName", type: "text", configuration: { label: "Full name" } }] }
  };
}

function mount(): { element: DatumBuilderElement; details: DatumBuilderChangeDetail[] } {
  const element = document.createElement("datum-builder") as DatumBuilderElement;
  element.options = { initialRoot: formRoot(), componentTypes: [{ type: "text", label: "Text" }] };
  document.body.append(element);
  const details: DatumBuilderChangeDetail[] = [];
  element.addEventListener("builder-change", (event) => details.push((event as CustomEvent<DatumBuilderChangeDetail>).detail));
  return { element, details };
}

describe("the builder-change detail", () => {
  it("carries where a data key edit moved the answers", () => {
    const { element, details } = mount();
    element.controller.setProperty("fullName", "dataKey", "name");
    expect(details.at(-1)?.dataMoved).toEqual([{ from: "fullName", to: "name" }]);
    expect(details.at(-1)?.renamed).toBeUndefined();
  });

  it("carries an Undo and a Redo of a rename, and which way the ids went", () => {
    const { element, details } = mount();
    element.controller.renameId("fullName", "person");
    expect(details.at(-1)?.renamed).toMatchObject({ from: "fullName", to: "person" });
    expect(details.at(-1)?.renameStepped).toBeUndefined();
    element.controller.undo();
    expect(details.at(-1)?.renameStepped).toEqual({ from: "person", to: "fullName", by: "undo" });
    expect(details.at(-1)?.renamed).toBeUndefined();
    expect(details.at(-1)?.historyStep).toBe("undo");
    element.controller.redo();
    expect(details.at(-1)?.renameStepped).toEqual({ from: "fullName", to: "person", by: "redo" });
    expect(details.at(-1)?.historyStep).toBe("redo");
  });

  it("carries a redone data move again, said to be a Redo", () => {
    const { element, details } = mount();
    element.controller.setProperty("fullName", "dataKey", "name");
    expect(details.at(-1)).not.toHaveProperty("historyStep");
    element.controller.undo();
    element.controller.redo();
    expect(details.at(-1)?.dataMoved).toEqual([{ from: "fullName", to: "name" }]);
    expect(details.at(-1)?.historyStep).toBe("redo");
  });

  it("carries neither on a change that moved nothing", () => {
    const { element, details } = mount();
    element.controller.setProperty("fullName", "label", "Name");
    expect(details.at(-1)).not.toHaveProperty("dataMoved");
    expect(details.at(-1)).not.toHaveProperty("renameStepped");
    expect(details.at(-1)).not.toHaveProperty("historyStep");
  });
  it("hands a host its own copy of the moves: draining them takes nothing from the modes", () => {
    const { element } = mount();
    const heard: unknown[] = [];
    element.addMode({
      id: "paper",
      label: "Paper",
      controller: new BuilderController({ initialRoot: formRoot() }),
      formDataMoved: (moves) => heard.push(moves.map((move) => ({ ...move })))
    });
    element.addEventListener("builder-change", (event) => {
      const moves = (event as CustomEvent<DatumBuilderChangeDetail>).detail.dataMoved as { from: string; to: string }[] | undefined;
      while (moves && moves.length > 0) {
        moves.shift();
      }
    });
    element.controller.setProperty("fullName", "dataKey", "name");
    expect(heard).toEqual([[{ from: "fullName", to: "name" }]]);
  });

  it("keeps the step's Redo whole when a host drained the moves it was handed", () => {
    const { element } = mount();
    const heard: Array<DatumBuilderChangeDetail> = [];
    element.addEventListener("builder-change", (event) => {
      const detail = (event as CustomEvent<DatumBuilderChangeDetail>).detail;
      heard.push(structuredClone(detail));
      (detail.dataMoved as { from: string; to: string }[] | undefined)?.splice(0);
    });
    element.controller.setProperty("fullName", "dataKey", "name");
    element.controller.undo();
    element.controller.redo();
    expect(heard.at(-1)?.historyStep).toBe("redo");
    expect(heard.at(-1)?.dataMoved).toEqual([{ from: "fullName", to: "name" }]);
  });

  it("hands a host its own copy of a rename's Undo too", () => {
    const { element, details } = mount();
    element.controller.renameId("fullName", "person");
    element.controller.undo();
    const stepped = details.at(-1)!.renameStepped!;
    const controllerEvents: unknown[] = [];
    element.controller.on("change", (event) => controllerEvents.push(event.renameStepped));
    element.controller.redo();
    expect(controllerEvents[0]).not.toBe(details.at(-1)!.renameStepped);
    expect(stepped).toEqual({ from: "person", to: "fullName", by: "undo" });
  });
  it("hands a host its own copy of a rename: editing what it was told leaves what the modes hear whole", () => {
    const element = document.createElement("datum-builder") as DatumBuilderElement;
    element.options = {
      initialRoot: {
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
            { id: "note", type: "text", configuration: { label: "Note" }, rules: { visibleWhen: "email = 1" } }
          ]
        }
      },
      componentTypes: [
        { type: "text", label: "Text" },
        { type: "container", label: "Container" }
      ]
    };
    document.body.append(element);
    const controllerEvents: Array<{ rules?: string[]; dataPath?: unknown }> = [];
    element.controller.on("change", (event) => {
      if (event.renamed) {
        controllerEvents.push(event.renamed);
      }
    });
    const heard: unknown[] = [];
    element.addMode({
      id: "paper",
      label: "Paper",
      controller: new BuilderController({ initialRoot: formRoot() }),
      formRenamed: (rename) => heard.push(structuredClone(rename))
    });
    let told: DatumBuilderChangeDetail["renamed"];
    element.addEventListener("builder-change", (event) => {
      told = (event as CustomEvent<DatumBuilderChangeDetail>).detail.renamed;
      (told as { rules?: string[] } | undefined)?.rules?.splice(0);
      if (told?.dataPath !== undefined && "to" in told.dataPath) {
        told.dataPath.to = "elsewhere";
      }
    });
    element.controller.renameId("email", "mail");
    expect(told).toBeDefined();
    expect(told).not.toBe(controllerEvents[0]);
    expect(told?.dataPath).not.toBe(controllerEvents[0]?.dataPath);
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({ from: "email", to: "mail", dataPath: { from: "applicant.email", to: "applicant.mail" } });
    expect(controllerEvents[0]?.dataPath).toEqual({ from: "applicant.email", to: "applicant.mail" });
    expect(controllerEvents[0]?.rules).toEqual(["note"]);
  });
});
