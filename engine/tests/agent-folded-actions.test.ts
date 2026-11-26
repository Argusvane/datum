import { describe, expect, it } from "vitest";

import { checkActionArgs, type FoldedActionSpec } from "../form-engine/agent/folded-actions.js";

/**
 * The folded-action convention's argument check: every message exactly, every problem at once, a warning for each
 * argument the action does not read, the `always` keys never warned, and `remove_part`'s `kind`
 * read as the action. The specs below follow the documented grammar for `documents`,
 * `drafts` and `remove_part`.
 */

const DOCUMENT_ACTIONS = ["list", "open", "new", "duplicate", "rename", "set_default", "move", "map_fields", "create_form_fields", "preview_pdf", "restore_removed"];

function documentsSpec(input: Record<string, unknown>): FoldedActionSpec {
  return {
    key: "action",
    action: input.action as string,
    kind: input.kind as string,
    needs: {
      open: ["id"],
      duplicate: ["id"],
      rename: ["id", "name"],
      set_default: ["id"],
      move: ["id", "toIndex"],
      restore_removed: ["id"]
    },
    reads: {
      open: ["discardTriedAnswers"],
      new: ["name", "shape", "from", "templateId", "discardTriedAnswers"],
      duplicate: ["name", "discardTriedAnswers"],
      preview_pdf: ["id", "answers"]
    },
    always: ["builder", "expectedRevision", "kind"],
    kindActions: {
      journey: ["list", "open", "new", "duplicate", "rename", "set_default", "restore_removed"],
      pdf_layout: DOCUMENT_ACTIONS
    },
    kindOnly: { shape: "journey", from: "pdf_layout", templateId: "pdf_layout", toIndex: "pdf_layout", answers: "pdf_layout" }
  };
}

function documents(input: Record<string, unknown>) {
  return checkActionArgs(input, documentsSpec(input));
}

function draftsSpec(input: Record<string, unknown>): FoldedActionSpec {
  return {
    key: "action",
    action: input.action as string,
    needs: {},
    reads: { restore: ["replaceAnswers"] },
    always: ["form", "expectedRevision"]
  };
}

function removePartSpec(input: Record<string, unknown>): FoldedActionSpec {
  return {
    key: "kind",
    action: input.kind as string,
    needs: { language: ["id"], journey: ["id"], pdf_layout: ["id"] },
    reads: {},
    always: ["builder", "expectedRevision", "kind", "id"]
  };
}

describe("checkActionArgs", () => {
  it("answers the documented example exactly: an action the kind does not have, and an argument only another kind reads", () => {
    expect(documents({ action: "move", kind: "journey", id: "intake", toIndex: 0 })).toEqual({
      problems: [
        { key: "action", expected: "an action for kind 'journey': list, open, new, duplicate, rename, set_default, restore_removed" },
        { key: "toIndex", expected: "kind 'pdf_layout' only" }
      ],
      warnings: []
    });
  });

  it("names every argument an action needs and did not get: required for action '<action>'", () => {
    expect(documents({ action: "rename", kind: "journey" })).toEqual({
      problems: [
        { key: "id", expected: "required for action 'rename'" },
        { key: "name", expected: "required for action 'rename'" }
      ],
      warnings: []
    });
    expect(documents({ action: "rename", kind: "journey", id: "intake", name: "Intake" })).toEqual({ problems: [], warnings: [] });
  });

  it("reports every problem at once, in a fixed order", () => {
    expect(documents({ action: "move", kind: "pdf_layout", shape: "questions", answers: "tried" })).toEqual({
      problems: [
        { key: "id", expected: "required for action 'move'" },
        { key: "toIndex", expected: "required for action 'move'" },
        { key: "shape", expected: "kind 'journey' only" }
      ],
      warnings: ["ignored argument for action 'move': answers"]
    });
  });

  it("does not ask an action the kind lacks for its own arguments", () => {
    expect(documents({ action: "map_fields", kind: "journey", from: "blank" })).toEqual({
      problems: [
        { key: "action", expected: "an action for kind 'journey': list, open, new, duplicate, rename, set_default, restore_removed" },
        { key: "from", expected: "kind 'pdf_layout' only" }
      ],
      warnings: []
    });
    expect(documents({ action: "move", kind: "journey" }).problems).toEqual([
      { key: "action", expected: "an action for kind 'journey': list, open, new, duplicate, rename, set_default, restore_removed" }
    ]);
  });

  it("warns, once each, for arguments the action does not read: ignored argument for action '<action>': <key>", () => {
    expect(documents({ action: "list", kind: "pdf_layout", name: "x", id: "a", discardTriedAnswers: true })).toEqual({
      problems: [],
      warnings: ["ignored argument for action 'list': name", "ignored argument for action 'list': id", "ignored argument for action 'list': discardTriedAnswers"]
    });
    // An argument of the right kind that this action does not read is a warning, not a problem.
    expect(documents({ action: "open", kind: "pdf_layout", id: "a", from: "blank" })).toEqual({
      problems: [],
      warnings: ["ignored argument for action 'open': from"]
    });
    // What an action reads besides its needs is not warned.
    expect(documents({ action: "new", kind: "journey", name: "Intake", shape: "questions", discardTriedAnswers: true })).toEqual({ problems: [], warnings: [] });
    expect(documents({ action: "preview_pdf", kind: "pdf_layout", answers: "host" })).toEqual({ problems: [], warnings: [] });
    // undefined is not given.
    expect(documents({ action: "list", kind: "journey", name: undefined })).toEqual({ problems: [], warnings: [] });
  });

  it("never warns for the keys every action reads: the handle, expectedRevision, documents.kind and the action key", () => {
    expect(documents({ action: "list", kind: "journey", builder: "b", expectedRevision: 3 })).toEqual({ problems: [], warnings: [] });
    expect(checkActionArgs({ action: "list", expectedRevision: 3 }, draftsSpec({ action: "list" }))).toEqual({ problems: [], warnings: [] });
    expect(checkActionArgs({ action: "save", form: "claim", replaceAnswers: true }, draftsSpec({ action: "save" }))).toEqual({
      problems: [],
      warnings: ["ignored argument for action 'save': replaceAnswers"]
    });
    expect(checkActionArgs({ action: "restore", form: "claim", replaceAnswers: true }, draftsSpec({ action: "restore" }))).toEqual({ problems: [], warnings: [] });
    // Without `always`, the action key itself is still read.
    expect(checkActionArgs({ action: "list" }, { key: "action", action: "list", needs: {}, reads: {} })).toEqual({ problems: [], warnings: [] });
  });

  it("reads remove_part's kind as the action (key: 'kind'), with kind and id never warned", () => {
    const missing = { kind: "journey", expectedRevision: 2 };
    expect(checkActionArgs(missing, removePartSpec(missing))).toEqual({
      problems: [{ key: "id", expected: "required for action 'journey'" }],
      warnings: []
    });
    const full = { kind: "language", id: "fr", builder: "b", expectedRevision: 2 };
    expect(checkActionArgs(full, removePartSpec(full))).toEqual({ problems: [], warnings: [] });
    // A kind-only spec keyed on `kind` names that key in the action-for-kind problem.
    const keyed: FoldedActionSpec = {
      key: "kind",
      action: "move",
      kind: "journey",
      needs: {},
      reads: {},
      kindActions: { journey: ["list"] }
    };
    expect(checkActionArgs({ kind: "move" }, keyed).problems).toEqual([{ key: "kind", expected: "an action for kind 'journey': list" }]);
  });
});
