import { describe, expect, it } from "vitest";

import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import {
  DEFAULT_TRY_SUBMISSION,
  normalizeTryPlacement,
  normalizeTrySubmission,
  trySubmissionReference
} from "../form-engine/builder/controller/try-submission.js";
import { BuilderPreviewRuntime } from "../form-engine/builder/preview/builder-preview-runtime.js";
import { checkAnswerErrors, checkAnswers, describeProblems, tryPanelHtml, type TryPanelView } from "../form-engine/builder/web-component/try-it.js";
import { FormEventType } from "../form-engine/core/events/event-types.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

/** What Submit does in Try it: the session settings, the reference, and errors on the canvas's runtime. */

function root(): ComponentNode {
  return {
    id: "root",
    type: "form",
    configuration: {},
    children: {
      content: [
        { id: "fullName", type: "text", configuration: { label: "Full name", required: true } },
        { id: "email", type: "text", configuration: { label: "Email" } }
      ]
    }
  };
}

describe("Submitting in Try it settings", () => {
  it("start from the defaults", () => {
    expect(normalizeTrySubmission(undefined)).toEqual({
      outcome: "accept",
      delayMs: 800,
      statusPlacement: ["top"],
      statusText: "",
      receipt: {
        kind: "success",
        title: "Thank you",
        message: "We have your answers.",
        detailLabel: "Confirmation number",
        referencePattern: "DT-{n}",
        placement: ["top"]
      },
      refusalMessage: "The server refused the form.",
      afterAccept: "editable"
    });
  });

  it("keep each value to what it may be, the rest from the base", () => {
    const base = normalizeTrySubmission({ outcome: "refuse", receipt: { title: "Merci" } });
    const next = normalizeTrySubmission(
      { delayMs: 20_000, outcome: "nope" as never, afterAccept: "readonly", receipt: { kind: "info", placement: ["bottom", "top", "side"] as never } },
      base
    );
    expect(next.outcome).toBe("refuse");
    expect(next.delayMs).toBe(10_000);
    expect(next.afterAccept).toBe("readonly");
    expect(next.receipt).toEqual({ ...DEFAULT_TRY_SUBMISSION.receipt, title: "Merci", kind: "info", placement: ["top", "bottom"] });
    expect(normalizeTrySubmission({ delayMs: -5 }).delayMs).toBe(0);
    expect(normalizeTrySubmission({ delayMs: "250" as never }).delayMs).toBe(250);
    expect(normalizeTrySubmission({ delayMs: Number.NaN }).delayMs).toBe(800);
    // A blank text is the author's: kept as typed.
    expect(normalizeTrySubmission({ receipt: { title: "" } }).receipt.title).toBe("");
  });

  it("place top, bottom or both, top first, and the top when nothing is left", () => {
    expect(normalizeTryPlacement(["bottom", "top", "bottom"])).toEqual(["top", "bottom"]);
    expect(normalizeTryPlacement([])).toEqual(["top"]);
    expect(normalizeTryPlacement("bottom")).toEqual(["top"]);
  });

  it("live on the controller for the session, a change emitted once and the definition untouched", () => {
    const controller = new BuilderController({ initialRoot: root() });
    const before = JSON.stringify(controller.snapshot());
    const reasons: string[] = [];
    controller.on("change", (event) => reasons.push(event.reason));
    controller.setTrySubmission({ outcome: "fail", receipt: { message: "Got it." } });
    expect(controller.trySubmission().outcome).toBe("fail");
    expect(controller.trySubmission().receipt.message).toBe("Got it.");
    expect(controller.trySubmission().receipt.title).toBe("Thank you");
    // The same values again change nothing.
    controller.setTrySubmission({ outcome: "fail" });
    expect(reasons).toEqual(["preview"]);
    expect(JSON.stringify(controller.snapshot())).toBe(before);
  });
});

describe("the receipt's reference", () => {
  it("puts six digits for each {n}", () => {
    expect(trySubmissionReference("DT-{n}", () => 0.123456)).toBe("DT-123456");
    expect(trySubmissionReference("A{n}-{n}", () => 0)).toBe("A000000-000000");
    expect(trySubmissionReference("DT-{n}", () => 0.9999999999)).toBe("DT-999999");
    expect(trySubmissionReference("FIXED")).toBe("FIXED");
    expect(trySubmissionReference("  ")).toBeUndefined();
    expect(trySubmissionReference("DT-{n}")).toMatch(/^DT-\d{6}$/);
  });
});

describe("errors on the canvas's runtime", () => {
  it("are put on the form with ERRORS_CHANGED, a field's dropping when its value changes", () => {
    const runtime = new BuilderPreviewRuntime(root());
    const published: string[] = [];
    runtime.events().subscribe(FormEventType.ERRORS_CHANGED, () => published.push("errors"));
    expect(runtime.errors()).toEqual([]);
    runtime.setErrors([]);
    expect(published).toEqual([]);
    runtime.setErrors([
      { id: "a", code: "required", componentId: "fullName", stage: "client", source: "client" },
      { id: "b", code: "refused", message: "No.", stage: "host", source: "server" }
    ]);
    expect(published).toEqual(["errors"]);
    expect(runtime.errors()).toHaveLength(2);

    // Another field's value leaves them.
    runtime.setValue("email", "a@b.c");
    expect(runtime.errors()).toHaveLength(2);
    expect(published).toEqual(["errors"]);

    runtime.setValue("fullName", "Ada");
    expect(runtime.errors().map((error) => error.id)).toEqual(["b"]);
    expect(published).toEqual(["errors", "errors"]);

    runtime.setErrors([]);
    expect(runtime.errors()).toEqual([]);
    expect(published).toHaveLength(3);
  });
});

describe("the browser's checks", () => {
  it("give the errors raw for the form and worded for the panel", () => {
    const options = { locale: "en", required: new Map([["fullName", true]]), hidden: () => false };
    const errors = checkAnswerErrors(root(), {}, options);
    expect(errors).toEqual([expect.objectContaining({ code: "required", componentId: "fullName" })]);
    expect(checkAnswers(root(), {}, options)).toEqual([expect.objectContaining({ componentId: "fullName", label: "Full name" })]);
    expect(checkAnswerErrors(root(), {}, { ...options, hidden: (id) => id === "fullName" })).toEqual([]);
  });
});

describe("the Try it panel's markup", () => {
  const view = (patch: Partial<TryPanelView> = {}): TryPanelView => ({
    mode: "interactive",
    answers: "{}",
    live: false,
    server: { status: "none", label: "WebAssembly", on: false, busy: false },
    submit: { state: "none" },
    pdf: false,
    pdfBusy: false,
    ...patch
  });
  /** The text of the element carrying `attribute` (no nested elements of the same tag), tags dropped. */
  const textOf = (html: string, attribute: string): string => {
    const match = new RegExp(`<(\\w+)[^>]*\\s${attribute}(?=[=\\s>])[^>]*>([\\s\\S]*?)</\\1>`).exec(html);
    return (match?.[2] ?? "").replace(/<[^>]+>/g, "").trim();
  };
  const tagOf = (html: string, attribute: string): string => new RegExp(`<[^>]*\\s${attribute}(?=[=\\s>])[^>]*>`).exec(html)?.[0] ?? "";

  it("says the last submit in a polite status", () => {
    const at = new Date("2026-10-06T14:05:12Z");
    const line = (submit: TryPanelView["submit"]): string => textOf(tryPanelHtml(view({ submit })), "data-try-submit");
    expect(tagOf(tryPanelHtml(view()), "data-try-submit")).toContain('aria-live="polite"');
    expect(line({ state: "none" })).toContain("Not yet");
    expect(line({ state: "submitting" })).toBe("Submitting…");
    expect(line({ state: "accepted", reference: "DT-123456", at })).toMatch(/^Accepted · DT-123456 · /);
    expect(line({ state: "refused", at })).toMatch(/^Refused · /);
    expect(line({ state: "failed", at })).toMatch(/^Could not be sent · /);
    expect(line({ state: "invalid", count: 2, at })).toMatch(/^2 problems/);
    expect(line({ state: "invalid", count: 1, at })).toMatch(/^1 problem:/);
  });

  it("draws the WebAssembly part for every state", () => {
    const html = (server: TryPanelView["server"]): string => tryPanelHtml(view({ server }));
    const none = html({ status: "none", label: "WebAssembly", on: false, busy: false });
    expect(tagOf(none, "data-try-server")).toContain(" disabled");
    expect(textOf(none, "data-try-wasm-status")).toBe("Not available: the page provides no WebAssembly validator.");
    const loading = html({ status: "loading", label: "WebAssembly", on: false, busy: false });
    expect(textOf(loading, "data-try-wasm-status")).toBe("Loading the WebAssembly validator…");
    const ready = html({ status: "ready", label: "Kernel", on: true, busy: false });
    expect(tagOf(ready, "data-try-server")).toContain(" checked");
    expect(tagOf(ready, "data-try-server")).not.toContain(" disabled");
    expect(textOf(ready, "data-try-wasm-status")).toBe("Ready: Kernel.");
    const failed = html({ status: "failed", label: "WebAssembly", reason: "no file", on: false, busy: false });
    expect(textOf(failed, "data-try-wasm-status")).toBe("Not available: no file");
    expect(textOf(failed, "data-try-wasm-retry")).toBe("Try again");
  });
});

describe("the panel's wording", () => {
  it("uses the field's authored patternMessage, as the renderer does, over a container's catalog", () => {
    const tree = {
      id: "form",
      type: "root",
      configuration: { messages: { pattern: "Form-wide pattern text" } },
      children: {
        content: [{ id: "code", type: "text", configuration: { label: "Code", patternMessage: "Use five digits" } }]
      }
    } as unknown as ComponentNode;
    const [problem] = describeProblems(tree, [{ code: "pattern", componentId: "code", stage: "client", source: "client" }], "en");
    expect(problem?.message).toBe("Use five digits");
  });
});
