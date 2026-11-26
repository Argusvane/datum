import { describe, expect, it } from "vitest";

import { renameInTests } from "../../form-engine/builder/form-tests/tests-rename.js";
import type { FormTestConfiguration } from "../../form-engine/core/form-tests/form-test-types.js";

// Following a component's rename into the form's tests: the
// parser's reference spans say where a name sits, so only real references change.

function tests(...sources: string[]): FormTestConfiguration {
  return { scenarios: sources.map((source, index) => ({ id: `test-${index + 1}`, source })) };
}

function block(...lines: string[]): string {
  return lines.join("\n");
}

function renamed(source: string, from: string, to: string, signatures = [] as Array<{ name: string; min: number; max: number }>): string | undefined {
  return renameInTests(tests(source), from, to, signatures)?.scenarios[0]!.source;
}

describe("a top-level field", () => {
  it("is renamed in set, clear, every kind of expectation and a submitted read", () => {
    const source = block(
      'test "totals"',
      "  set total = 5",
      "  clear total",
      "  expect total visible",
      "  expect total required",
      "  expect total = 5",
      "  expect error on total",
      "  expect error on total: required",
      '  expect message on total = "Too small"',
      "  submit",
      "  expect submitted total = 5",
      "  expect total withheld"
    );
    expect(renamed(source, "total", "sum")).toBe(
      block(
        'test "totals"',
        "  set sum = 5",
        "  clear sum",
        "  expect sum visible",
        "  expect sum required",
        "  expect sum = 5",
        "  expect error on sum",
        "  expect error on sum: required",
        '  expect message on sum = "Too small"',
        "  submit",
        "  expect submitted sum = 5",
        "  expect sum withheld"
      )
    );
  });

  it("is renamed in the expect-no-error form and in empty and state words", () => {
    const source = block('test "t"', "  expect no error on total", "  expect total not empty", "  expect total readonly");
    expect(renamed(source, "total", "sum")).toBe(block('test "t"', "  expect no error on sum", "  expect sum not empty", "  expect sum readonly"));
  });

  it("is renamed in a plain formula and a backticked one, keeping the ticks", () => {
    const source = block('test "f"', "  expect total + 1 = 6", "  expect `total` > 3", "  expect count(selected(total)) = 2");
    expect(renamed(source, "total", "sum")).toBe(block('test "f"', "  expect sum + 1 = 6", "  expect `sum` > 3", "  expect count(selected(sum)) = 2"));
  });

  it("leaves a longer name, a string, a comment and a name of another namespace alone", () => {
    const source = block(
      'test "totals"',
      "  given host.total = 1",
      '  set totality = "total"',
      "  expect page = total",
      "  expect layout = total",
      "  expect total_extra visible # total is not renamed here",
      '  expect message on totality = "total"'
    );
    expect(renamed(source, "total", "sum")).toBeUndefined();
  });

  it("keeps indentation, trailing comments and the other lines byte for byte", () => {
    const source = block('test "keep"   # header total', "", "    set total = 1   # total", "\tset other = 2");
    expect(renamed(source, "total", "sum")).toBe(block('test "keep"   # header total', "", "    set sum = 1   # total", "\tset other = 2"));
  });

  it("renames every occurrence on a line, back to front", () => {
    const source = block('test "twice"', "  expect total = total + total");
    expect(renamed(source, "total", "grand_total")).toBe(block('test "twice"', "  expect grand_total = grand_total + grand_total"));
  });

  it("reads the `to` shorter or longer than the `from` without shifting later spans", () => {
    const source = block('test "t"', "  set a_very_long_name = 1", "  expect a_very_long_name = 1", "  expect a_very_long_name visible");
    expect(renamed(source, "a_very_long_name", "x")).toBe(block('test "t"', "  set x = 1", "  expect x = 1", "  expect x visible"));
  });
});

describe("a row field", () => {
  it("is renamed after the row position in set and expect", () => {
    const source = block(
      'test "rows"',
      "  add row to items",
      "  set items[0].qty = 3",
      "  expect items[0].qty = 3",
      "  expect items[1].qty required"
    );
    expect(renamed(source, "qty", "amount")).toBe(
      block('test "rows"', "  add row to items", "  set items[0].amount = 3", "  expect items[0].amount = 3", "  expect items[1].amount required")
    );
  });

  it("is renamed in the keys of add row to items with qty = 2", () => {
    const source = block('test "rows"', "  add row to items with qty = 2, sku = \"A\"", "  expect rows of items = 1");
    expect(renamed(source, "qty", "amount")).toBe(block('test "rows"', '  add row to items with amount = 2, sku = "A"', "  expect rows of items = 1"));
  });

  it("is renamed in a data container's path", () => {
    const source = block('test "c"', '  set applicant.email = "a@b.c"', "  expect applicant.email visible");
    expect(renamed(source, "email", "mail")).toBe(block('test "c"', '  set applicant.mail = "a@b.c"', "  expect applicant.mail visible"));
  });
});

describe("a collection", () => {
  it("is renamed in row paths, rows of, add row and remove row", () => {
    const source = block(
      'test "collection"',
      "  add row to items with qty = 2",
      "  add row to items",
      "  expect rows of items = 2",
      "  set items[1].qty = 5",
      "  expect items[0].qty = 2",
      "  remove row 0 of items",
      "  expect rows of items = 1"
    );
    expect(renamed(source, "items", "lines")).toBe(
      block(
        'test "collection"',
        "  add row to lines with qty = 2",
        "  add row to lines",
        "  expect rows of lines = 2",
        "  set lines[1].qty = 5",
        "  expect lines[0].qty = 2",
        "  remove row 0 of lines",
        "  expect rows of lines = 1"
      )
    );
  });

  it("never reads the digits of a position as a name", () => {
    const source = block('test "p"', "  set items[0].qty = 1");
    expect(renamed(source, "0", "9")).toBeUndefined();
  });

  it("does not touch a row key because its collection was renamed: the key is relative", () => {
    const source = block('test "k"', "  add row to items with qty = 2");
    expect(renamed(source, "items", "lines")).toBe(block('test "k"', "  add row to lines with qty = 2"));
  });
});

describe("the block", () => {
  it("is undefined when no entry changed, and the same entries come back otherwise", () => {
    const block1 = block('test "one"', "  expect total visible");
    const block2 = block('test "two"', "  expect other visible");
    expect(renameInTests(tests(block1, block2), "missing", "x", [])).toBeUndefined();
    const result = renameInTests(tests(block1, block2), "total", "sum", [])!;
    expect(result.scenarios.map((entry) => entry.id)).toEqual(["test-1", "test-2"]);
    expect(result.scenarios[0]!.source).toContain("expect sum visible");
    expect(result.scenarios[1]!.source).toBe(block2);
  });

  it("is undefined for an absent block, and for a rename to itself or from nothing", () => {
    expect(renameInTests(undefined, "a", "b", [])).toBeUndefined();
    expect(renameInTests(tests(block('test "t"', "  expect a visible")), "a", "a", [])).toBeUndefined();
    expect(renameInTests(tests(block('test "t"', "  expect a visible")), "", "b", [])).toBeUndefined();
  });

  it("leaves a source that does not parse as it is while another entry changes", () => {
    const good = block('test "good"', "  expect total visible");
    const bad = block('test "bad"', "  expect total visible", "  frobnicate total");
    const result = renameInTests(tests(bad, good), "total", "sum", [])!;
    expect(result.scenarios[0]!.source).toBe(bad);
    expect(result.scenarios[1]!.source).toBe(block('test "good"', "  expect sum visible"));
  });

  it("changes nothing when the only source that names the field does not parse", () => {
    expect(renameInTests(tests(block('test "bad"', "  expect total visible", "  frobnicate total")), "total", "sum", [])).toBeUndefined();
  });

  it("reads a plugin function's signature when parsing, so a formula that calls it is followed", () => {
    const source = block('test "plugin"', "  expect shout(total) = 1");
    expect(renamed(source, "total", "sum")).toBeUndefined();
    expect(renamed(source, "total", "sum", [{ name: "shout", min: 1, max: 1 }])).toBe(block('test "plugin"', "  expect shout(sum) = 1"));
  });

  it("follows a field in a change line", () => {
    const source = block('test "change"', "  change total", "  expect total visible");
    expect(renamed(source, "total", "sum")).toBe(block('test "change"', "  change sum", "  expect sum visible"));
  });

  it("keeps the block's other keys", () => {
    const input = { scenarios: [{ id: "test-1", source: block('test "t"', "  expect a visible") }] };
    const result = renameInTests(input, "a", "b", [])!;
    expect(result).not.toBe(input);
    expect(input.scenarios[0]!.source).toContain("expect a visible");
    expect(result.scenarios[0]!.source).toContain("expect b visible");
  });
});

// Pages and journeys: the same parser spans, other ref kinds. A page id is not a
// value path, so a page rename never reaches a field of the same name, and the exit of
// `path ends at` is the journey's own and is left alone.

function renamedKind(source: string, from: string, to: string, kind: "path" | "page" | "journey"): string | undefined {
  return renameInTests(tests(source), from, to, [], { kind })?.scenarios[0]!.source;
}

describe("a page", () => {
  it("is renamed in go to, expect page, expect path, on path and not on path", () => {
    const source = block(
      'test "pages"',
      "  go to about",
      "  expect page = about",
      "  expect path = (home, about, review)",
      "  expect about on path",
      "  expect review off path"
    );
    expect(renamedKind(source, "about", "who-we-are", "page")).toBe(
      block(
        'test "pages"',
        "  go to who-we-are",
        "  expect page = who-we-are",
        "  expect path = (home, who-we-are, review)",
        "  expect who-we-are on path",
        "  expect review off path"
      )
    );
    expect(renamedKind(source, "review", "check", "page")).toContain("expect check off path");
  });

  it("leaves the exit of path ends at alone, and renames the same id on another line", () => {
    const source = block('test "exit"', "  expect path ends at stop", "  expect page = stop", "  expect path = (home, stop)");
    expect(renamedKind(source, "stop", "done", "page")).toBe(
      block('test "exit"', "  expect path ends at stop", "  expect page = done", "  expect path = (home, done)")
    );
    expect(renamedKind(block('test "exit"', "  expect path ends at stop", "  expect path ends"), "stop", "done", "page")).toBeUndefined();
  });

  it("never touches a field that has the page's id", () => {
    const source = block(
      'test "same id"',
      "  set about = 1",
      "  expect about visible",
      "  expect about = 1",
      "  expect page = about",
      "  expect about on path",
      "  go to about"
    );
    expect(renamedKind(source, "about", "who", "page")).toBe(
      block('test "same id"', "  set about = 1", "  expect about visible", "  expect about = 1", "  expect page = who", "  expect who on path", "  go to who")
    );
  });

  it("is not renamed by a path rename, and a path rename leaves page ids alone", () => {
    const source = block('test "t"', "  set about = 1", "  go to about", "  expect page = about");
    expect(renamed(source, "about", "who")).toBe(block('test "t"', "  set who = 1", "  go to about", "  expect page = about"));
    expect(renameInTests(tests(source), "about", "who", [], { kind: "path" })?.scenarios[0]!.source).toBe(renamed(source, "about", "who"));
  });

  it("matches a whole id only: a longer page id and a segment of a dotted one stay", () => {
    const source = block('test "ids"', "  go to about_us", "  go to about", "  expect path = (about.us, about)");
    expect(renamedKind(source, "about", "who", "page")).toBe(block('test "ids"', "  go to about_us", "  go to who", "  expect path = (about.us, who)"));
  });

  it("leaves a given journey alone and keeps strings, comments and layouts", () => {
    const source = block(
      'test "t"',
      "  given journey = about",
      '  set note = "about"   # about',
      "  expect layout = about"
    );
    expect(renamedKind(source, "about", "who", "page")).toBeUndefined();
  });

  it("renames every occurrence on a line, back to front, whatever the lengths", () => {
    const source = block('test "t"', "  expect path = (a, a, a)", "  go to a");
    expect(renamedKind(source, "a", "long-page-name", "page")).toBe(block('test "t"', "  expect path = (long-page-name, long-page-name, long-page-name)", "  go to long-page-name"));
  });

  it("leaves tests alone when the new id could not be read back as one token", () => {
    const source = block('test "t"', "  go to about");
    expect(renamedKind(source, "about", "who we are", "page")).toBeUndefined();
    expect(renamedKind(source, "about", '"who"', "page")).toBeUndefined();
  });

  it("leaves a quoted id (which the language does not read) and an unparsable source alone", () => {
    expect(renamedKind(block('test "q"', '  go to "about"'), "about", "who", "page")).toBeUndefined();
    const bad = block('test "bad"', "  go to about", "  frobnicate");
    const good = block('test "good"', "  go to about");
    const result = renameInTests(tests(bad, good), "about", "who", [], { kind: "page" })!;
    expect(result.scenarios[0]!.source).toBe(bad);
    expect(result.scenarios[1]!.source).toBe(block('test "good"', "  go to who"));
  });

  it("keeps the other entries of the block as they were", () => {
    const one = block('test "one"', "  go to about");
    const two = block('test "two"', "  go to home");
    const result = renameInTests(tests(one, two), "about", "who", [], { kind: "page" })!;
    expect(result.scenarios.map((entry) => entry.id)).toEqual(["test-1", "test-2"]);
    expect(result.scenarios[1]!.source).toBe(two);
    expect(renameInTests(tests(two), "about", "who", [], { kind: "page" })).toBeUndefined();
    expect(renameInTests(undefined, "about", "who", [], { kind: "page" })).toBeUndefined();
    expect(renameInTests(tests(one), "about", "about", [], { kind: "page" })).toBeUndefined();
  });

  it("follows a page only in the scenarios that run its journey, when the journey is named", () => {
    const adult = block('test "adult"', "  given journey = adult", "  go to details", "  expect page = details");
    const child = block('test "child"', "  given journey = child", "  go to details", "  expect page = details");
    const plain = block('test "default"', "  go to details");
    const none = block('test "none"', "  given journey = none", "  go to details");
    const options = { kind: "page" as const, journeyId: "adult", defaultJourneyId: "adult" };
    const result = renameInTests(tests(adult, child, plain, none), "details", "adult_details", [], options)!;
    expect(result.scenarios.map((entry) => entry.source)).toEqual([
      block('test "adult"', "  given journey = adult", "  go to adult_details", "  expect page = adult_details"),
      child,
      block('test "default"', "  go to adult_details"),
      none
    ]);
    // Another journey's default: the scenario with no given journey runs that one, so it stays.
    expect(renameInTests(tests(plain), "details", "adult_details", [], { ...options, defaultJourneyId: "child" })).toBeUndefined();
    // No default known: such a scenario follows, as it did before the journey was named.
    expect(renameInTests(tests(plain), "details", "adult_details", [], { kind: "page", journeyId: "adult" })!.scenarios[0]!.source).toBe(block('test "default"', "  go to adult_details"));
  });
});

describe("a journey", () => {
  it("is renamed in given journey and nowhere else", () => {
    const source = block('test "j"', "  given journey = main", "  go to main", "  set main = 1", "  expect page = main");
    expect(renamedKind(source, "main", "primary", "journey")).toBe(
      block('test "j"', "  given journey = primary", "  go to main", "  set main = 1", "  expect page = main")
    );
  });

  it("leaves given journey = none (the whole form) and another journey alone", () => {
    expect(renamedKind(block('test "j"', "  given journey = none"), "none", "x", "journey")).toBeUndefined();
    expect(renamedKind(block('test "j"', "  given journey = other"), "main", "primary", "journey")).toBeUndefined();
  });

  it("is not followed by a page rename or a path rename", () => {
    const source = block('test "j"', "  given journey = main");
    expect(renamedKind(source, "main", "primary", "page")).toBeUndefined();
    expect(renamed(source, "main", "primary")).toBeUndefined();
  });
});
