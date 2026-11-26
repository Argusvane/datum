import { afterEach, describe, expect, it } from "vitest";

import "../src/builder.js";
import type { DatumFormBuilderElement } from "../src/builder.js";
import { until } from "./helpers.js";

afterEach(() => {
  document.body.innerHTML = "";
});

/**
 * With the PDF side off the layouts ride in the seed, and a rename in the form still reaches
 * them: by the answer's whole path when the component sits in a container that scopes its data.
 */
describe("a form component renamed while the PDF side is off", () => {
  it("is followed in a template layout's path source by the path the answer is stored under", async () => {
    const element = document.createElement("datum-form-builder") as DatumFormBuilderElement;
    element.setAttribute("pdf", "off");
    element.definition = {
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
            }
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
            fields: [{ pdfField: "Email", source: { kind: "path", path: "applicant.email" } }]
          }
        ]
      }
    } as never;
    document.body.append(element);
    await until(() => element.controller);

    const controller = element.controller!;
    controller.select("email");
    controller.setDraftId("email", "mail");
    expect(controller.commitDraft("email")).toBe(true);
    const layout = element.definition.pdf?.layouts?.[0] as unknown as { fields: Array<{ source: { path: string } }> };
    expect(layout.fields[0]!.source.path).toBe("applicant.mail");
  });
});
