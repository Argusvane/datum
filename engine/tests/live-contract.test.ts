import { describe, expect, it } from "vitest";

import {
  behaviourOf,
  capabilityAnswers,
  capabilityOf,
  extendBinding,
  fieldCapabilitiesOf,
  lookupBaseOf,
  resolveAdapter,
  type FieldAdapter,
  type GroupAdapter,
  type LiveBinding,
  type TabsAdapter
} from "../form-engine/render/live/contract.js";

/**
 * The binding contract's pure half (render/live/contract.ts): the adapter lookup
 * chain binding[type] -> binding[base] -> datum[type] -> datum[base], the adapter kinds that keep
 * a field adapter and a container adapter apart under one type, `when` selection, capabilities
 * as data, and `extendBinding`'s wrap/patch overrides. No DOM: templates are never called.
 */

const field = (name: string, extra: Partial<FieldAdapter> = {}): FieldAdapter => ({ kind: "field", name, template: () => undefined as never, ...extra });
const group = (name: string): GroupAdapter => ({ kind: "group", name, template: () => undefined as never });
const tabs = (name: string): TabsAdapter => ({ kind: "tabs", name, template: () => undefined as never });

const DATUM: LiveBinding = {
  id: "datum",
  label: "Datum",
  components: { text: field("datum-text"), date: field("datum-date"), radio: field("datum-radio"), fieldset: group("datum-fieldset"), tabs: tabs("datum-tabs") }
};

const DS: LiveBinding = {
  id: "ds",
  label: "DS",
  components: { text: field("ds-text"), "ds-date": field("ds-date"), radio: group("not-a-field") }
};

const nameOf = (resolved: ReturnType<typeof resolveAdapter> | undefined) => (resolved ? `${resolved.from}:${resolved.via}:${resolved.adapter.name}` : undefined);

describe("the adapter lookup chain", () => {
  it("goes binding[type], binding[base], datum[type], datum[base]", () => {
    expect(nameOf(resolveAdapter(DS, DATUM, "field", "ds-date", "date"))).toBe("binding:ds-date:ds-date");
    expect(nameOf(resolveAdapter(DS, DATUM, "field", "text", "text"))).toBe("binding:text:ds-text");
    // A tier-2 type the binding draws through its base.
    expect(nameOf(resolveAdapter(DS, DATUM, "field", "acme-text", "text"))).toBe("binding-base:text:ds-text");
    // Datum's own adapter for the type, then for its base.
    const withOwn: LiveBinding = { ...DATUM, components: { ...DATUM.components, "acme-date": field("datum-acme-date") } };
    expect(nameOf(resolveAdapter(DS, withOwn, "field", "acme-date", "date"))).toBe("datum:acme-date:datum-acme-date");
    expect(nameOf(resolveAdapter(DS, DATUM, "field", "acme-date", "date"))).toBe("datum-base:date:datum-date");
    expect(resolveAdapter(DS, DATUM, "field", "mystery", "mystery")).toBeUndefined();
  });

  it("skips an entry of another kind: a container adapter never draws a field of the same type", () => {
    // The DS registers a group under "radio": the field falls through to Datum's radio.
    expect(nameOf(resolveAdapter(DS, DATUM, "field", "radio", "radio"))).toBe("datum:radio:datum-radio");
    expect(nameOf(resolveAdapter(DS, DATUM, "group", "radio", "radio"))).toBe("binding:radio:not-a-field");
  });

  it("finds a container type mapped to a container base under that base", () => {
    const kinds = { "gcds-tabs": "tabs", "gcds-date": "date" };
    expect(lookupBaseOf("tabs", "gcds-tabs", kinds)).toBe("tabs");
    expect(lookupBaseOf("field", "gcds-tabs", kinds)).toBe("gcds-tabs");
    expect(lookupBaseOf("field", "gcds-date", kinds)).toBe("date");
    const gcds: LiveBinding = { id: "gcds", label: "GCDS", components: { "gcds-tabs": tabs("gcds-tabs") } };
    expect(nameOf(resolveAdapter(gcds, DATUM, "tabs", "gcds-tabs", lookupBaseOf("tabs", "gcds-tabs", kinds)))).toBe("binding:gcds-tabs:gcds-tabs");
    // Under another binding the tier-2 type draws its base, Datum's tabs.
    expect(nameOf(resolveAdapter(DS, DATUM, "tabs", "gcds-tabs", lookupBaseOf("tabs", "gcds-tabs", kinds)))).toBe("datum-base:tabs:datum-tabs");
  });

  it("picks the first adapter whose `when` holds, else the one without `when`, else the next step", () => {
    const short = field("short", { when: (state) => (state as { value: string }).value.length < 3 });
    const fallback = field("default");
    const picky: LiveBinding = { id: "picky", label: "Picky", components: { text: [short, fallback], date: [field("only-when", { when: () => false })] } };
    expect(nameOf(resolveAdapter(picky, DATUM, "field", "text", "text", { value: "ab" }))).toBe("binding:text:short");
    expect(nameOf(resolveAdapter(picky, DATUM, "field", "text", "text", { value: "abcd" }))).toBe("binding:text:default");
    // No state (the inspector's question): the default.
    expect(nameOf(resolveAdapter(picky, DATUM, "field", "text", "text"))).toBe("binding:text:default");
    // Every adapter has a `when` and none holds: on to Datum's.
    expect(nameOf(resolveAdapter(picky, DATUM, "field", "date", "date", { value: "" }))).toBe("datum:date:datum-date");
  });

  it("asks the Datum binding once when it draws as itself, and reads own entries only", () => {
    expect(nameOf(resolveAdapter(DATUM, DATUM, "field", "acme-date", "date"))).toBe("binding-base:date:datum-date");
    expect(nameOf(resolveAdapter(DATUM, undefined, "field", "text", "text"))).toBe("binding:text:datum-text");
    expect(resolveAdapter(DS, DATUM, "field", "constructor", "constructor")).toBeUndefined();
    expect(resolveAdapter(DS, DATUM, "field", "toString", "text")?.via).toBe("text");
  });
});

describe("capabilities as data", () => {
  const adapter = field("x", { capabilities: { tooltip: "degraded", notice: "drawn", prefix: "none" }, behaviour: { countsCharacters: "component" } });

  it("answers every capability the registry asks of a kind, `none` where the adapter says nothing", () => {
    expect(capabilityOf(adapter, "tooltip")).toBe("degraded");
    expect(capabilityOf(adapter, "pending")).toBe("none");
    expect(capabilityOf(undefined, "notice")).toBe("none");
    const text = capabilityAnswers(adapter, "text");
    expect(text).toMatchObject({ notice: "drawn", tooltip: "degraded", prefix: "none", pending: "none", characterCount: "none" });
    // rowNumbers is a collection's, never asked of a text field; characterCount is a text field's alone.
    expect("rowNumbers" in text).toBe(false);
    expect("characterCount" in capabilityAnswers(adapter, "date")).toBe(false);
  });

  it("fills the behaviour flags it leaves out", () => {
    expect(behaviourOf(adapter)).toEqual({ keyboard: "renderer", countsCharacters: "component" });
    expect(behaviourOf(undefined).keyboard).toBe("renderer");
  });

  it("tells the inspector what a binding answers for a type, through the lookup chain", () => {
    const binding: LiveBinding = { id: "b", label: "B", components: { date: field("b-date", { capabilities: { notice: "degraded" } }) } };
    expect(fieldCapabilitiesOf(binding, DATUM, "gcds-date", { "gcds-date": "date" })).toMatchObject({ kind: "date", from: "binding-base", answers: { notice: "degraded", tooltip: "none" } });
    expect(fieldCapabilitiesOf(binding, DATUM, "text")).toMatchObject({ kind: "text", from: "datum" });
    // A type that holds no answer, or that nothing knows, has no field capabilities.
    expect(fieldCapabilitiesOf(binding, DATUM, "html")).toBeUndefined();
    expect(fieldCapabilitiesOf(binding, DATUM, "mystery")).toBeUndefined();
  });
});

describe("extendBinding", () => {
  it("replaces one adapter, wraps another around the binding's own, and leaves the rest shared", () => {
    const replaced = field("replaced");
    const extended = extendBinding(DS, {
      label: "DS, extended",
      components: {
        text: replaced,
        "ds-date": (base) => ({ ...(base as FieldAdapter), name: `wrapped ${(base as FieldAdapter).name}` })
      }
    });
    expect(extended.label).toBe("DS, extended");
    expect(extended.components["text"]).toBe(replaced);
    expect((extended.components["ds-date"] as FieldAdapter).name).toBe("wrapped ds-date");
    expect(extended.components["radio"]).toBe(DS.components["radio"]);
    // The binding handed in is left as it was.
    expect((DS.components["text"] as FieldAdapter).name).toBe("ds-text");
  });
});
