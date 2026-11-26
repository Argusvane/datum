import { describe, expect, it } from "vitest";

import { rankCommands, type BuilderCommand } from "../form-engine/builder/palette/palette-filter.js";

/** The command palette's ranking. */

const command = (id: string, label: string, group: BuilderCommand["group"], extra: Partial<BuilderCommand> = {}): BuilderCommand => ({
  id,
  label,
  group,
  run: () => undefined,
  ...extra
});

const commands: BuilderCommand[] = [
  command("view:outline", "Show the Outline panel", "view"),
  command("add:date", "Add Date field", "add", { keywords: ["date"] }),
  command("add:text", "Add Text field", "add", { keywords: ["text"] }),
  command("go:country", "Go to Country", "go to", { keywords: ["country", "select"] }),
  command("edit:undo", "Undo", "edit", { enabled: () => false }),
  command("workspace:logic", "Go to the Logic workspace", "workspaces"),
  command("go:dob", "Go to Date of birth", "go to", { keywords: ["dob"] })
];

const ids = (query: string, recent: string[] = []): string[] => rankCommands(commands, query, recent).map((entry) => entry.command.id);

describe("rankCommands", () => {
  it("lists recent commands, then every group in order, for an empty query", () => {
    expect(ids("", ["go:country"])).toEqual(["go:country", "workspace:logic", "add:date", "add:text", "go:dob", "edit:undo", "view:outline"]);
  });

  it("matches the label as a subsequence, word starts first", () => {
    expect(ids("add d")[0]).toBe("add:date");
    expect(ids("gtc")[0]).toBe("go:country");
    expect(ids("logic")).toEqual(["workspace:logic"]);
  });

  it("matches keywords too, below a label match", () => {
    expect(ids("dob")).toEqual(["go:dob"]);
    expect(ids("select")).toEqual(["go:country"]);
  });

  it("drops what does not match, and ranks a disabled command last", () => {
    expect(ids("zzz")).toEqual([]);
    const ranked = rankCommands([...commands, command("edit:redo", "Redo", "edit")], "do");
    expect(ranked.at(-1)!.command.id).toBe("edit:undo");
  });

  it("returns the label's matched characters for highlighting", () => {
    const [top] = rankCommands(commands, "gtc");
    expect(top!.matched.map((index) => top!.command.label[index])).toEqual(["G", "t", "C"]);
  });
});
