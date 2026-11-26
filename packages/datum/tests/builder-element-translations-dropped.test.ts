import { afterEach, describe, expect, it, vi } from "vitest";

import "../src/builder.js";
import type { DatumFormBuilderElement } from "../src/builder.js";
import type { DatumWarningDetail } from "../src/support.js";
import { until } from "./helpers.js";

/*
 * Translation entries the builder cannot keep (a text that is not text, an entry without its
 * source, an unknown kind, a key that cannot be a property) are left out when a form loads. The
 * form still loads; the page hears it once as `datum-warning` with the count and the first
 * addresses; Save writes the entries that were kept.
 */

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const formWith = (translations: unknown) => ({
  id: "t",
  version: "1.0.0",
  schemaVersion: "1",
  localization: { defaultLocale: "en", supportedLocales: [{ code: "en" }, { code: "fr" }] },
  translations,
  root: { id: "root", type: "form", configuration: {}, children: { content: [{ id: "name", type: "text", configuration: { label: "Name" } }] } }
});

function listen(el: HTMLElement): { warnings: DatumWarningDetail[]; errors: string[] } {
  const warnings: DatumWarningDetail[] = [];
  const errors: string[] = [];
  el.addEventListener("datum-warning", (event) => warnings.push((event as CustomEvent<DatumWarningDetail>).detail));
  el.addEventListener("datum-error", (event) => errors.push((event as CustomEvent<{ message: string }>).detail.message));
  return { warnings, errors };
}

async function builder(): Promise<DatumFormBuilderElement> {
  const el = document.createElement("datum-form-builder") as DatumFormBuilderElement;
  document.body.append(el);
  await until(() => el.controller);
  return el;
}

describe("translation entries left out at load", () => {
  it("are told once as datum-warning with the count and the first addresses; the form loads and keeps the rest", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const el = await builder();
    const { warnings, errors } = listen(el);
    el.definition = formWith({
      fr: {
        components: {
          name: { label: { text: "Nom", source: "abc" }, description: { text: 5, source: "x" }, placeholder: { text: "Votre nom" } }
        },
        sideways: { name: { label: { text: "x", source: "y" } } }
      }
    }) as never;
    await until(() => warnings.length > 0);
    expect(errors).toEqual([]);
    expect(warnings).toHaveLength(1);
    const warning = warnings[0]!;
    expect(warning.code).toBe("translations.dropped");
    expect(warning.count).toBe(3);
    expect(warning.addresses).toEqual(expect.arrayContaining(["fr.components.name.description", "fr.components.name.placeholder", "fr.sideways"]));
    expect(warning.message).toMatch(/3 translation entries/);
    expect(warning.message).toContain("fr.components.name.description");
    await until(() => el.definition.translations !== undefined);
    expect(el.definition.translations).toEqual({ fr: { components: { name: { label: { text: "Nom", source: "abc" } } } } });
    expect(el.controller?.snapshot().children?.content?.map((child) => child.id)).toEqual(["name"]);
  });

  it("are told for a file the Open action loads", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const el = await builder();
    const { warnings } = listen(el);
    const apply = el.fileActions.open!({ name: "t.json", text: JSON.stringify(formWith({ fr: { components: { name: { label: { text: 1, source: "a" } } } } })) }) as () => void;
    apply();
    await until(() => warnings.length > 0);
    expect(warnings[0]!.count).toBe(1);
    expect(warnings[0]!.addresses).toEqual(["fr.components.name.label"]);
  });

  it("are not told for a form the builder then refuses; the form that stays says nothing either", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const el = await builder();
    // The inner builder refuses a tree holding "refuse-me" when it is seeded, past the element's own checks.
    const inner = el.builder as unknown as Record<string, unknown>;
    let proto = Object.getPrototypeOf(inner) as object | null;
    let options: PropertyDescriptor | undefined;
    while (proto && !(options = Object.getOwnPropertyDescriptor(proto, "options"))) {
      proto = Object.getPrototypeOf(proto) as object | null;
    }
    Object.defineProperty(inner, "options", {
      configurable: true,
      get() {
        return options!.get!.call(this);
      },
      set(value: unknown) {
        if (JSON.stringify(value).includes("refuse-me")) {
          throw new Error("The builder could not take the form: refused here");
        }
        options!.set!.call(this, value);
      }
    });
    const { warnings, errors } = listen(el);
    const refused = formWith({ fr: { components: { name: { label: { text: 1, source: "a" } } } } }) as ReturnType<typeof formWith> & { root: { children: { content: Array<{ id: string }> } } };
    refused.root.children.content[0]!.id = "refuse-me";
    el.definition = refused as never;
    await until(() => errors.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(errors[0]).toMatch(/refused here/);
    expect(warnings).toEqual([]);
    expect(el.controller?.snapshot().children?.content?.map((child) => child.id)).not.toContain("refuse-me");
    // Open goes the same way: the refusal is thrown to the builder, and no warning precedes it.
    const apply = el.fileActions.open!({ name: "t.json", text: JSON.stringify(refused) }) as () => void;
    expect(() => apply()).toThrow(/refused here/);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(warnings).toEqual([]);
  }, 20000);

  it("say nothing for a map the builder keeps whole, or for no map", async () => {
    const el = await builder();
    const { warnings, errors } = listen(el);
    el.definition = formWith({ fr: { components: { name: { label: { text: "Nom", source: "abc" } } } } }) as never;
    await until(() => el.definition.translations !== undefined);
    el.definition = formWith(undefined) as never;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(warnings).toEqual([]);
    expect(errors).toEqual([]);
  });
});
