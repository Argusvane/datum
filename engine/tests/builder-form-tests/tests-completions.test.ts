/**
 * The test editor's lists and its slot at the caret: pure, so
 * neither needs a document or a layout. The fixture form is the shared one of the form-tests
 * build; a small inline form adds what it lacks (a button, static HTML, a data key under a
 * container, a data grid).
 */
import { describe, expect, it } from "vitest";

import type { ComponentNode, FormDefinition } from "../../form-engine/core/schema/types.js";
import { createTestsCompletions, liftCompletions, testsSlotAt } from "../../form-engine/builder/form-tests/tests-completions.js";
import { FORM_TESTS_FIXTURE } from "../form-tests/fixtures/form-tests-fixture.js";

const fixture = createTestsCompletions(
  () => FORM_TESTS_FIXTURE.root,
  () => FORM_TESTS_FIXTURE,
  () => ["server.refused", "required"]
);

describe("the lists the editor offers", () => {
  it("lists every field by its value path with its label and type", () => {
    const fields = fixture.fields();
    const byPath = new Map(fields.map((field) => [field.path, field]));
    expect(byPath.get("applicant_name")).toMatchObject({ label: "Name", type: "text" });
    expect(byPath.get("age")).toMatchObject({ label: "Age", type: "number" });
    expect(byPath.get("topics")).toMatchObject({ label: "Topics", type: "checkboxes" });
    expect(byPath.get("province")).toMatchObject({ type: "select" });
    expect(fields.map((field) => field.path).slice(0, 3)).toEqual(["applicant_name", "age", "age_next_year"]);
  });

  it("offers a row field as items[0].qty with its collection, and the section itself", () => {
    const fields = fixture.fields();
    expect(fields.find((field) => field.path === "items")).toMatchObject({ label: "Items", type: "repeatingSection" });
    expect(fields.find((field) => field.path === "items[0].qty")).toMatchObject({ label: "Quantity", collection: "items" });
    expect(fields.find((field) => field.path === "qty")).toBeUndefined();
    expect(fixture.isCollection("items")).toBe(true);
    expect(fixture.isCollection("age")).toBe(false);
  });

  it("leaves out what carries no answer: buttons, static HTML and grouping containers", () => {
    const root: ComponentNode = {
      id: "form",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "go", type: "button", configuration: { label: "Go" } },
          { id: "intro_text", type: "html", configuration: { content: "<p>Hi</p>" } },
          { id: "panel1", type: "panel", configuration: { label: "A panel" }, children: { content: [{ id: "city", type: "text", configuration: { label: "City" } }] } }
        ]
      }
    } as unknown as ComponentNode;
    const lists = createTestsCompletions(() => root, () => undefined, () => []);
    expect(lists.fields().map((field) => field.path)).toEqual(["city"]);
  });

  it("follows data keys and data-scoping containers to the path the language reads", () => {
    const root: ComponentNode = {
      id: "form",
      type: "form",
      configuration: {},
      children: {
        content: [
          {
            id: "billing_box",
            type: "container",
            configuration: { dataKey: "billing", label: "Billing" },
            children: { content: [{ id: "billing_street", type: "text", configuration: { label: "Street", dataKey: "street" } }] }
          },
          {
            id: "lines",
            type: "dataGrid",
            configuration: { label: "Lines" },
            collection: { collectionPath: "order_lines" },
            children: { content: [{ id: "sku", type: "text", configuration: { label: "SKU" } }] }
          }
        ]
      }
    } as unknown as ComponentNode;
    const lists = createTestsCompletions(() => root, () => undefined, () => []);
    const paths = lists.fields().map((field) => field.path);
    expect(paths).toContain("billing.street");
    expect(paths).toContain("order_lines");
    expect(paths).toContain("order_lines[0].sku");
    expect(lists.isCollection("order_lines")).toBe(true);
  });

  it("lists the pages of every journey with the journey, titled by the page or by its first field", () => {
    const pages = fixture.pages();
    expect(pages.map((page) => page.id)).toEqual(["intro", "contact", "details", "review", "stop"]);
    expect(pages.every((page) => page.journey === "main")).toBe(true);
    expect(pages.find((page) => page.id === "stop")?.label).toBe("Not eligible");
    expect(pages.find((page) => page.id === "intro")?.label).toBe("Name");
    expect(pages.find((page) => page.id === "contact")?.label).toBe("How to reach you");
  });

  it("lists the journeys and the PDF layouts by name, else id", () => {
    expect(fixture.journeys()).toEqual([{ id: "main", label: "main" }]);
    expect(fixture.layouts()).toEqual([{ id: "standard", label: "standard" }, { id: "pets", label: "pets" }]);
    const named = {
      ...FORM_TESTS_FIXTURE,
      journey: { journeys: [{ id: "j", name: "Intake", pages: [{ id: "p1", title: "First page", components: [] }] }] },
      pdf: { layouts: [{ id: "l1", kind: "generated", name: { default: "Applicant copy" }, root: { id: "d", type: "pdf-document", configuration: {} } }] }
    } as unknown as FormDefinition;
    const lists = createTestsCompletions(() => named.root, () => named, () => []);
    expect(lists.journeys()).toEqual([{ id: "j", label: "Intake" }]);
    expect(lists.pages()).toEqual([{ id: "p1", label: "First page", journey: "j" }]);
    expect(lists.layouts()).toEqual([{ id: "l1", label: "Applicant copy" }]);
  });

  it("offers no pages, journeys or layouts while the shell has no whole definition", () => {
    const lists = createTestsCompletions(() => FORM_TESTS_FIXTURE.root, () => undefined, () => []);
    expect(lists.pages()).toEqual([]);
    expect(lists.journeys()).toEqual([]);
    expect(lists.layouts()).toEqual([]);
  });

  it("lists the engine's codes, then the host's, each once", () => {
    const codes = fixture.codes().map((entry) => entry.code);
    for (const code of ["required", "rule", "number", "date", "dateIncomplete", "pattern", "minLength", "maxLength", "rows.min", "rows.max", "option.notAllowed", "fileType", "maxFileSize"]) {
      expect(codes, code).toContain(code);
    }
    expect(codes).toContain("server.refused");
    expect(codes.filter((code) => code === "required")).toHaveLength(1);
    expect(codes.indexOf("server.refused")).toBeGreaterThan(codes.indexOf("option.notAllowed"));
    expect(fixture.codes().find((entry) => entry.code === "required")?.label).toBeTruthy();
  });

  it("gives a choice field's options, and the kind a value takes", () => {
    expect(fixture.optionsOf("topics").map((option) => option.value)).toEqual(["news", "offers", "events"]);
    expect(fixture.optionsOf("contact_method")).toEqual([{ value: "email", label: "Email" }, { value: "phone", label: "Phone" }]);
    expect(fixture.optionsOf("age")).toEqual([]);
    expect(fixture.optionsOf("nope")).toEqual([]);
    expect(fixture.kindOf("age")).toBe("number");
    expect(fixture.kindOf("has_pet")).toBe("boolean");
    expect(fixture.kindOf("topics")).toBe("flags");
    expect(fixture.kindOf("items")).toBe("list");
    expect(fixture.kindOf("nope")).toBeUndefined();
  });

  it("reads a tree that changed since the last call", () => {
    let root: ComponentNode = { id: "form", type: "form", configuration: {}, children: { content: [{ id: "a", type: "text", configuration: {} }] } } as unknown as ComponentNode;
    const lists = createTestsCompletions(() => root, () => undefined, () => []);
    expect(lists.fields().map((field) => field.path)).toEqual(["a"]);
    root = { ...root, children: { content: [...(root.children?.content ?? []), { id: "b", type: "text", configuration: { label: "Bee" } } as unknown as ComponentNode] } };
    expect(lists.fields().map((field) => field.label)).toEqual(["a", "Bee"]);
  });

  it("lifts a bare contract with the extras worked out from its fields", () => {
    const bare = {
      fields: () => [{ path: "items", label: "Items", type: "repeatingSection" }, { path: "items[0].q", label: "Q", type: "number", collection: "items" }],
      pages: () => [],
      journeys: () => [],
      layouts: () => [],
      codes: () => []
    };
    const lifted = liftCompletions(bare);
    expect(lifted.isCollection("items")).toBe(true);
    expect(lifted.isCollection("items[0].q")).toBe(false);
    expect(lifted.kindOf("items[0].q")).toBe("number");
    expect(lifted.optionsOf("items")).toEqual([]);
    expect(liftCompletions(fixture)).toBe(fixture);
  });
});

describe("the slot at the caret", () => {
  const wants = (before: string): string[] => testsSlotAt(before).wants;
  const words = (before: string): string[] => testsSlotAt(before).words.map((word) => word.text);

  it("offers the statements at a line's start, filtered by what is typed", () => {
    expect(wants("")).toEqual(["statement"]);
    expect(wants("  ")).toEqual(["statement"]);
    expect(words("")).toEqual(expect.arrayContaining(["set", "expect", "add row to", "go to", "change", "submit", "given"]));
    const typed = testsSlotAt("  ex");
    expect(typed.partial).toBe("ex");
    expect(typed.wants).toEqual(["statement"]);
  });

  it("offers fields after set, clear and the expect forms that name one", () => {
    expect(wants("set ")).toEqual(["field"]);
    expect(wants("set app")).toEqual(["field"]);
    expect(testsSlotAt("set app").partial).toBe("app");
    expect(wants("clear ")).toEqual(["field"]);
    expect(wants("expect error on ")).toEqual(["field"]);
    expect(wants("expect no error on ")).toEqual(["field"]);
    expect(wants("expect message on ")).toEqual(["field"]);
    expect(wants("expect submitted ")).toEqual(["field"]);
    expect(wants("given options for ")).toEqual(["field"]);
  });

  it("offers collections after rows of, add row to and remove row n of", () => {
    expect(wants("expect rows of ")).toEqual(["collection"]);
    expect(wants("add row to ")).toEqual(["collection"]);
    expect(wants("remove row 0 of ")).toEqual(["collection"]);
    expect(words("add row to items ")).toEqual(["with"]);
  });

  it("offers the row's own keys after with, and a value for the key it follows", () => {
    expect(testsSlotAt("add row to items with ")).toMatchObject({ wants: ["rowKey"], collection: "items" });
    expect(words("add row to items with qty ")).toEqual(["="]);
    expect(testsSlotAt("add row to items with qty = ")).toMatchObject({ wants: ["value"], field: "items[0].qty" });
    expect(testsSlotAt("add row to items with qty = 2, ")).toMatchObject({ wants: ["rowKey"], collection: "items" });
    expect(testsSlotAt("add row to items with qty = 2, price = ")).toMatchObject({ wants: ["value"], field: "items[0].price" });
  });

  it("walks the words of the multi-word forms", () => {
    expect(words("add ")).toEqual(["row"]);
    expect(words("add row ")).toEqual(["to"]);
    expect(words("remove ")).toEqual(["row"]);
    expect(words("remove row 1 ")).toEqual(["of"]);
    expect(words("go ")).toEqual(["to"]);
    expect(wants("go to ")).toEqual(["page"]);
    expect(wants("change ")).toEqual(["field"]);
    expect(words("expect error ")).toEqual(["on"]);
    expect(words("expect no ")).toEqual(["error", "errors"]);
    expect(words("expect rows ")).toEqual(["of"]);
    expect(words("given options ")).toEqual(["for"]);
  });

  it("offers error codes after the colon of an error line", () => {
    expect(words("expect error on email ")).toEqual([":"]);
    expect(wants("expect error on email:")).toEqual(["code"]);
    expect(wants("expect error on email: ")).toEqual(["code"]);
    const typed = testsSlotAt("expect error on email: req");
    expect(typed.wants).toEqual(["code"]);
    expect(typed.partial).toBe("req");
  });

  it("offers pages, journeys and layouts after their equals sign", () => {
    expect(wants("expect page = ")).toEqual(["page"]);
    expect(wants("expect layout = ")).toEqual(["layout"]);
    expect(wants("given journey = ")).toEqual(["journey"]);
    expect(words("given journey = ")).toEqual(["none"]);
    expect(wants("expect path ends at ")).toEqual(["page"]);
    expect(words("expect path ")).toEqual(["=", "ends"]);
  });

  it("offers a page for each place of a path list, and the list's punctuation between", () => {
    expect(words("expect path = ")).toEqual(["("]);
    expect(wants("expect path = (")).toEqual(["page"]);
    expect(wants("expect path = (intro, ")).toEqual(["page"]);
    expect(words("expect path = (intro")).toEqual([]);
    expect(words("expect path = (intro ")).toEqual([",", ")"]);
    expect(wants("expect path = (intro)")).toEqual([]);
  });

  it("offers the states, equals and the page forms after the first word of an expect", () => {
    const after = testsSlotAt("expect applicant_name ");
    expect(after.wants).toEqual(["state"]);
    expect(after.subject).toBe("applicant_name");
    expect(after.words.map((word) => word.text)).toEqual(expect.arrayContaining(["=", "!=", "withheld", "on path", "off path"]));
    expect(after.words.find((word) => word.text === "on path")?.after).toBe("page");
    expect(words("expect applicant_name not ")).toEqual(["empty"]);
    expect(words("expect intro on ")).toEqual(["path"]);
  });

  it("starts an expect with its leads, fields and pages", () => {
    const lead = testsSlotAt("expect ");
    expect(lead.wants).toEqual(["field", "page"]);
    expect(lead.subject).toBe("");
    expect(lead.words.map((word) => word.text)).toEqual(expect.arrayContaining(["error on", "no errors", "accepted", "refused", "rows of", "layout =", "page ="]));
    expect(wants("expect accepted ")).toEqual([]);
    expect(testsSlotAt("expect accepted").partial).toBe("accepted");
  });

  it("asks for a value for the field an equals sign follows", () => {
    expect(testsSlotAt("set age = ")).toMatchObject({ wants: ["value"], field: "age" });
    expect(testsSlotAt("expect age = ")).toMatchObject({ wants: ["value"], field: "age" });
    expect(testsSlotAt("expect age != ")).toMatchObject({ wants: ["value"], field: "age" });
    expect(testsSlotAt("expect submitted age = ")).toMatchObject({ wants: ["value"], field: "age" });
    expect(testsSlotAt("set topics = (")).toMatchObject({ wants: ["value"], field: "topics", list: true });
    expect(testsSlotAt('set topics = ("news", ')).toMatchObject({ wants: ["value"], field: "topics", list: true });
    expect(wants('set age = 5 ')).toEqual([]);
    expect(testsSlotAt('set age = 5')).toMatchObject({ wants: ['value'], partial: '5' });
    expect(wants('set topics = ("news")')).toEqual([]);
  });

  it("asks for the right value after each given", () => {
    expect(wants("given ")).toEqual(["given"]);
    expect(words("given ")).toEqual(["today", "locale", "journey", "host.", "options for"]);
    expect(testsSlotAt("given today = ")).toMatchObject({ wants: ["value"], given: "today" });
    expect(testsSlotAt("given locale = ")).toMatchObject({ wants: ["value"], given: "locale" });
    expect(testsSlotAt("given host.role = ")).toMatchObject({ wants: ["value"] });
    expect(testsSlotAt("given options for province = ")).toMatchObject({ wants: ["value"], field: "province", given: "options" });
  });

  it("completes inside a string only where a value can be, and never in a comment", () => {
    expect(wants('test "Some na')).toEqual([]);
    expect(wants('expect message on email = "The two')).toEqual([]);
    const inString = testsSlotAt('set province = "O');
    expect(inString).toMatchObject({ wants: ["value"], field: "province", partial: "O", quote: '"' });
    expect(wants("set age = 5 # a note")).toEqual([]);
    expect(wants("# set ")).toEqual([]);
    expect(wants('set note = "has # inside" ')).toEqual([]);
  });

  it("takes the keywords in any case and ignores unknown statements", () => {
    expect(wants("SET ")).toEqual(["field"]);
    expect(wants("Expect Error On ")).toEqual(["field"]);
    expect(wants("frobnicate ")).toEqual([]);
    expect(wants("test ")).toEqual([]);
    expect(wants("skip ")).toEqual([]);
    expect(wants("submit ")).toEqual([]);
  });
});
