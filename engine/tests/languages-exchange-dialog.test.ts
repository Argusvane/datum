// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { MAX_IMPORT_BYTES } from "../form-engine/builder/languages/exchange.js";
import { defineLanguagesSurface, DATUM_BUILDER_LANGUAGES_TAG, type DatumBuilderLanguagesElement } from "../form-engine/builder/languages/languages-surface.js";
import { addressOf, readTranslation, sourceHash } from "../form-engine/core/localization/translations.js";
import type { FormDefinition } from "../form-engine/core/schema/types.js";
import { languagesController } from "./fixtures/builder-languages.js";

/*
 * The Languages workspace's export and import dialogs, driven through the
 * surface's two buttons the way a person does. jsdom applies no shadow CSS and has no object
 * URLs, so the download is read from the stubbed `createObjectURL` and the anchor's click.
 */

defineLanguagesSurface();

interface Mounted {
  surface: DatumBuilderLanguagesElement;
  controller: BuilderController;
  root: ShadowRoot;
}

function mount(controller: BuilderController = languagesController()): Mounted {
  const surface = document.createElement(DATUM_BUILDER_LANGUAGES_TAG) as DatumBuilderLanguagesElement;
  surface.controller = controller;
  surface.definition = () => ({ id: "permit-form" }) as FormDefinition;
  document.body.append(surface);
  return { surface, controller, root: surface.shadowRoot! };
}

const q = <T extends Element = HTMLElement>(root: ParentNode, selector: string): T => {
  const found = root.querySelector<T>(selector);
  if (!found) {
    throw new Error(`nothing matches ${selector}`);
  }
  return found;
};

const dialogOf = (root: ShadowRoot, kind: "export" | "import"): HTMLDialogElement | null => root.querySelector<HTMLDialogElement>(`dialog[data-languages-exchange-dialog="${kind}"]`);

function click(el: Element): void {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
}

function change(el: Element): void {
  el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
}

function choose(select: HTMLSelectElement, value: string): void {
  select.value = value;
  change(select);
}

function escape(root: ShadowRoot, kind: "export" | "import"): void {
  q(root, `dialog[data-languages-exchange-dialog="${kind}"]`).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }));
}

/** The blobs a download made, by the anchor's file name (jsdom has no object URLs or navigation). */
const downloads: Array<{ name: string; blob: Blob }> = [];
const urlStatics = URL as unknown as { createObjectURL?: (blob: Blob) => string; revokeObjectURL?: (url: string) => void };
const blobs = new Map<string, Blob>();

function textOf(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

beforeEach(() => {
  downloads.length = 0;
  blobs.clear();
  let n = 0;
  urlStatics.createObjectURL = (blob) => {
    n += 1;
    const url = `blob:stub-${n}`;
    blobs.set(url, blob);
    return url;
  };
  // The revoke stays a no-op after the tests: the dialog revokes on a timer (memory note "jsdom download stubs").
  urlStatics.revokeObjectURL = () => undefined;
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push({ name: this.download, blob: blobs.get(this.href)! });
  });
});

afterEach(() => {
  delete urlStatics.createObjectURL;
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("opening and closing", () => {
  it("opens a labelled dialog from the Export and Import buttons and closes on Escape", () => {
    const { root } = mount();
    expect(root.querySelector("[data-languages-exchange]")).toBeNull();
    click(q(root, "[data-languages-export]"));
    const dialog = dialogOf(root, "export")!;
    expect(dialog).not.toBeNull();
    expect(dialog.hasAttribute("open")).toBe(true);
    const title = q(root, `#${dialog.getAttribute("aria-labelledby")}`);
    expect(title.textContent).toBe("Export texts");
    escape(root, "export");
    expect(dialogOf(root, "export")).toBeNull();

    click(q(root, "[data-languages-import]"));
    const imp = dialogOf(root, "import")!;
    expect(q(root, `#${imp.getAttribute("aria-labelledby")}`).textContent).toBe("Import translations");
    click(q(root, "[data-exchange-cancel]"));
    expect(dialogOf(root, "import")).toBeNull();
  });

  it("is not wiped by a repaint of the surface", () => {
    const { root, controller } = mount();
    click(q(root, "[data-languages-export]"));
    controller.localizationActions.addLocale("es", "");
    expect(dialogOf(root, "export")).not.toBeNull();
  });
});

describe("export", () => {
  it("switches the format and names the languages; XLIFF says it writes a file per language", () => {
    const { root } = mount();
    click(q(root, "[data-languages-export]"));
    expect(q<HTMLInputElement>(root, '[data-exchange-format="json"]').checked).toBe(true);
    expect(root.querySelector("[data-exchange-xliff-note]")).toBeNull();
    const xliff = q<HTMLInputElement>(root, '[data-exchange-format="xliff"]');
    xliff.checked = true;
    change(xliff);
    expect(q<HTMLInputElement>(root, '[data-exchange-format="xliff"]').checked).toBe(true);
    expect(root.querySelector("[data-exchange-xliff-note]")).not.toBeNull();
    // French is the one language besides the default; the scope offers a group the form has.
    expect(q<HTMLInputElement>(root, '[data-exchange-language="fr"]').checked).toBe(true);
    expect([...root.querySelectorAll("[data-exchange-scope] option")].map((o) => (o as HTMLOptionElement).value)).toContain("group:fields");
  });

  it("downloads JSON as <form>-translations.json with a JSON blob", async () => {
    const { root } = mount();
    click(q(root, "[data-languages-export]"));
    click(q(root, "[data-exchange-download]"));
    expect(downloads).toHaveLength(1);
    expect(downloads[0]!.name).toBe("permit-form-translations.json");
    expect(downloads[0]!.blob.type).toBe("application/json");
    const out = JSON.parse(await textOf(downloads[0]!.blob)) as { form: string; defaultLocale: string; locales: string[]; texts: Array<Record<string, string>> };
    expect(out).toMatchObject({ form: "permit-form", defaultLocale: "en", locales: ["fr"] });
    expect(out.texts.find((t) => t.kind === "components" && t.key === "name" && t.path === "label")).toMatchObject({ default: "Full name", fr: "Nom complet" });
  });

  it("downloads CSV with a CSV blob, and the scope narrows it to the missing texts", async () => {
    const { root } = mount();
    click(q(root, "[data-languages-export]"));
    const csv = q<HTMLInputElement>(root, '[data-exchange-format="csv"]');
    csv.checked = true;
    change(csv);
    choose(q<HTMLSelectElement>(root, "[data-exchange-scope]"), "needs");
    click(q(root, "[data-exchange-download]"));
    expect(downloads[0]!.name).toBe("permit-form-translations.csv");
    expect(downloads[0]!.blob.type).toBe("text/csv;charset=utf-8");
    const text = await textOf(downloads[0]!.blob);
    expect(text.startsWith("kind,key,path,where,default,source,lang:fr,status:fr\r\n")).toBe(true);
    // The file leads with a UTF-8 byte-order mark, so Excel does not read its accents as ANSI.
    const bytes = new Uint8Array(await downloads[0]!.blob.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    // "Full name" is translated, "Kind" is not: only the second is in a missing-or-stale export.
    expect(text).not.toContain("Nom complet");
    expect(text).toContain("components,kind,label,");
  });

  it("offers one XLIFF link per chosen language, named <form>-<locale>.xlf, and starts no download itself", async () => {
    const { root, controller } = mount();
    controller.localizationActions.addLocale("es", "");
    click(q(root, "[data-languages-export]"));
    const xliff = q<HTMLInputElement>(root, '[data-exchange-format="xliff"]');
    xliff.checked = true;
    change(xliff);
    click(q(root, "[data-exchange-download]"));
    // A browser lets one download follow a click: each file has its own link instead.
    expect(downloads).toEqual([]);
    const links = [...root.querySelectorAll<HTMLAnchorElement>("[data-exchange-link]")];
    expect(links.map((link) => link.getAttribute("download"))).toEqual(["permit-form-fr.xlf", "permit-form-es.xlf"]);
    expect(blobs.get(links[0]!.getAttribute("href")!)?.type).toBe("application/xliff+xml");
    expect(await textOf(blobs.get(links[0]!.getAttribute("href")!)!)).toContain('trgLang="fr"');
    expect(q(root, "[data-exchange-links]").getAttribute("aria-label")).toBe("Files ready to download");
    // Changing the choice withdraws the links; one language downloads at once.
    const es = q<HTMLInputElement>(root, '[data-exchange-language="es"]');
    es.checked = false;
    change(es);
    expect(root.querySelector("[data-exchange-links]")).toBeNull();
    click(q(root, "[data-exchange-download]"));
    expect(downloads.map((d) => d.name)).toEqual(["permit-form-fr.xlf"]);
  });

  it("words the in-dialog status from what was started: files ready for several, downloaded for one (the surface's region is outside the modal)", () => {
    const { root, controller } = mount();
    controller.localizationActions.addLocale("es", "");
    click(q(root, "[data-languages-export]"));
    const xliff = q<HTMLInputElement>(root, '[data-exchange-format="xliff"]');
    xliff.checked = true;
    change(xliff);
    click(q(root, "[data-exchange-download]"));
    expect(q(root, "[data-exchange-live]").textContent).toBe("2 files are ready. Use the links in the dialog to download each one.");
    expect(q(root, "[data-languages-live]").textContent).toBe("");
    const es = q<HTMLInputElement>(root, '[data-exchange-language="es"]');
    es.checked = false;
    change(es);
    click(q(root, "[data-exchange-download]"));
    expect(q(root, "[data-exchange-live]").textContent).toBe("Downloaded permit-form-fr.xlf.");
  });

  it("copies the prompt to the clipboard", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { root } = mount();
    click(q(root, "[data-languages-export]"));
    click(q(root, "[data-exchange-prompt-copy]"));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalled());
    const text = (writeText.mock.calls[0] as unknown as [string])[0];
    expect(text).toContain("kind,key,path,where,default,source,lang:fr");
    expect(text).toContain("Translate each text");
    // The pasted text is not a saved file: no byte-order mark.
    expect(text.charCodeAt(0)).not.toBe(0xfeff);
    await vi.waitFor(() => expect(q(root, "[data-exchange-status]").textContent).toContain("Copied"));
    expect(root.querySelector("[data-exchange-prompt]")).toBeNull();
  });

  it("shows the prompt to select when the clipboard is not there to write to", async () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    const { root } = mount();
    click(q(root, "[data-languages-export]"));
    click(q(root, "[data-exchange-prompt-copy]"));
    await vi.waitFor(() => expect(root.querySelector("[data-exchange-prompt]")).not.toBeNull());
    expect(q<HTMLTextAreaElement>(root, "[data-exchange-prompt]").value).toContain("kind,key,path,where,default,source,lang:fr");
    expect(q(root, "[data-exchange-copy-fallback]").textContent).toContain("cannot copy");
  });

  it("offers nothing to download for a form with only its default language", () => {
    const { root } = mount(languagesController(null));
    click(q(root, "[data-languages-export]"));
    expect(root.querySelector("[data-exchange-no-languages]")).not.toBeNull();
    expect(q<HTMLButtonElement>(root, "[data-exchange-download]").disabled).toBe(true);
  });
});

describe("import", () => {
  const HASH = sourceHash("Full name");
  const KIND_HASH = sourceHash("Kind");

  function tick(root: ShadowRoot, code: string): void {
    const box = q<HTMLInputElement>(root, `[data-exchange-add="${code}"]`);
    box.checked = true;
    change(box);
  }

  function pick(root: ShadowRoot, name: string, text: string, size?: number): File {
    const file = new File([text], name, { type: "text/csv" });
    if (size !== undefined) {
      Object.defineProperty(file, "size", { value: size });
    }
    const input = q<HTMLInputElement>(root, "[data-exchange-file]");
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    change(input);
    return file;
  }

  const CSV = [
    "kind,key,path,where,default,source,lang:fr,lang:es",
    // Changed (French exists), new in Spanish, and a source that no longer matches.
    `components,name,label,Name,Full name,${HASH},Nom entier,Nombre`,
    // New in French.
    `components,kind,label,Kind,Kind,${KIND_HASH},Genre,`,
    // Unknown text.
    "components,ghost,label,Ghost,Ghost,x,Fantome,",
    ""
  ].join("\r\n");

  it("previews the counts, the new language, the stale rows and a row-by-row table before anything changes", async () => {
    const { root, controller } = mount();
    click(q(root, "[data-languages-import]"));
    const before = JSON.stringify(controller.translations());
    pick(root, "t.csv", CSV.replace(`${HASH},Nom entier`, `${sourceHash("Old name")},Nom entier`));
    await vi.waitFor(() => expect(root.querySelector("[data-exchange-table]")).not.toBeNull());
    const count = (name: string): string => q(root, `[data-exchange-count="${name}"] strong`).textContent!;
    // A new language starts unticked, so the counts leave Spanish out until it is ticked.
    expect(q<HTMLInputElement>(root, '[data-exchange-add="es"]').checked).toBe(false);
    expect(count("new")).toBe("1");
    expect(count("stale")).toBe("1");
    tick(root, "es");
    expect(count("new")).toBe("2");
    expect(count("changed")).toBe("1");
    expect(count("unchanged")).toBe("0");
    expect(count("unknown")).toBe("1");
    // One row per language: the name text is stale in French and in Spanish.
    expect(count("stale")).toBe("2");
    expect([...root.querySelectorAll("[data-exchange-add]")].map((el) => el.getAttribute("data-exchange-add"))).toEqual(["es"]);
    const nameFr = q(root, '[data-exchange-row="components/name/label"][data-exchange-locale="fr"]');
    expect(nameFr.textContent).toContain("Nom complet");
    expect(nameFr.textContent).toContain("Nom entier");
    expect(nameFr.textContent).toContain("Source changed");
    expect(q(root, '[data-exchange-row="components/ghost/label"]').getAttribute("data-exchange-status")).toBe("unknown");
    // Nothing changed yet.
    expect(JSON.stringify(controller.translations())).toBe(before);
  });

  it("applies the edits as one undo step, adding the language the author kept", async () => {
    const { root, controller } = mount();
    click(q(root, "[data-languages-import]"));
    pick(root, "t.csv", CSV);
    await vi.waitFor(() => expect(root.querySelector("[data-exchange-table]")).not.toBeNull());
    // Nothing of Spanish is applied until the author ticks "Add es".
    expect(q(root, "[data-exchange-apply-count]").textContent).toContain("2");
    tick(root, "es");
    expect(q(root, "[data-exchange-apply-count]").textContent).toContain("3");
    click(q(root, "[data-exchange-apply]"));
    expect(dialogOf(root, "import")).toBeNull();
    const map = controller.translations();
    expect(readTranslation(map, "fr", addressOf.component("name", "label"))?.text).toBe("Nom entier");
    expect(readTranslation(map, "fr", addressOf.component("kind", "label"))?.text).toBe("Genre");
    expect(readTranslation(map, "es", addressOf.component("name", "label"))?.text).toBe("Nombre");
    expect(controller.localization()?.supportedLocales?.map((entry) => (typeof entry === "string" ? entry : entry.code))).toContain("es");
    // One undo takes the added language and every entry back together (the import is one step).
    controller.undo();
    const undone = controller.translations();
    expect(readTranslation(undone, "fr", addressOf.component("name", "label"))?.text).toBe("Nom complet");
    expect(readTranslation(undone, "fr", addressOf.component("kind", "label"))).toBeUndefined();
    expect(readTranslation(undone, "es", addressOf.component("name", "label"))).toBeUndefined();
    expect(controller.localization()?.supportedLocales?.map((entry) => (typeof entry === "string" ? entry : entry.code))).not.toContain("es");
    expect(controller.canUndo()).toBe(false);
    controller.redo();
    expect(controller.localization()?.supportedLocales?.map((entry) => (typeof entry === "string" ? entry : entry.code))).toContain("es");
    expect(readTranslation(controller.translations(), "es", addressOf.component("name", "label"))?.text).toBe("Nombre");
  });

  it("writes a row whose file fingerprint no longer matches the current default flagged stale, with the file's source", async () => {
    const { root, controller } = mount();
    click(q(root, "[data-languages-import]"));
    const older = sourceHash("Your name");
    pick(root, "t.csv", ["kind,key,path,where,default,source,lang:fr", `components,name,label,Name,Your name,${older},Nom entier`, `components,kind,label,Kind,Kind,${KIND_HASH},Genre`, ""].join("\r\n"));
    await vi.waitFor(() => expect(root.querySelector("[data-exchange-table]")).not.toBeNull());
    click(q(root, "[data-exchange-apply]"));
    const written = readTranslation(controller.translations(), "fr", addressOf.component("name", "label"));
    expect(written?.text).toBe("Nom entier");
    // The file was made against other wording than "Full name": the entry says so.
    expect(written?.source).toBe(older);
    expect(written?.source).not.toBe(HASH);
    // A row whose fingerprint is the current default's comes in current.
    expect(readTranslation(controller.translations(), "fr", addressOf.component("kind", "label"))?.source).toBe(KIND_HASH);
  });

  it("skips a language the author leaves unticked, and fills blanks only on request", async () => {
    const { root, controller } = mount();
    click(q(root, "[data-languages-import]"));
    pick(root, "t.csv", CSV);
    await vi.waitFor(() => expect(root.querySelector("[data-exchange-table]")).not.toBeNull());
    const fill = q<HTMLInputElement>(root, '[data-exchange-mode="fill"]');
    fill.checked = true;
    change(fill);
    // Only the new French text remains: the changed one is kept and Spanish is skipped.
    expect(q(root, "[data-exchange-apply-count]").textContent).toContain("1");
    expect(q(root, '[data-exchange-row="components/name/label"][data-exchange-locale="fr"]').textContent).toContain("Kept");
    expect(q(root, '[data-exchange-row="components/name/label"][data-exchange-locale="es"]').textContent).toContain("Language skipped");
    click(q(root, "[data-exchange-apply]"));
    const map = controller.translations();
    expect(readTranslation(map, "fr", addressOf.component("name", "label"))?.text).toBe("Nom complet");
    expect(readTranslation(map, "fr", addressOf.component("kind", "label"))?.text).toBe("Genre");
    expect(controller.localization()?.supportedLocales?.map((entry) => (typeof entry === "string" ? entry : entry.code))).not.toContain("es");
  });

  it("marks the Now and In the file cells with the row's language and direction", async () => {
    const { root } = mount();
    click(q(root, "[data-languages-import]"));
    pick(root, "t.csv", ["kind,key,path,lang:fr,lang:ar-EG", `components,name,label,Nom entier,اسم`, ""].join("\r\n"));
    await vi.waitFor(() => expect(root.querySelector("[data-exchange-table]")).not.toBeNull());
    const arabic = [...q(root, '[data-exchange-row="components/name/label"][data-exchange-locale="ar-EG"]').querySelectorAll("td[lang]")];
    expect(arabic.map((td) => [td.getAttribute("lang"), td.getAttribute("dir")])).toEqual([
      ["ar-EG", "rtl"],
      ["ar-EG", "rtl"]
    ]);
    const french = [...q(root, '[data-exchange-row="components/name/label"][data-exchange-locale="fr"]').querySelectorAll("td[lang]")];
    expect(french.map((td) => [td.getAttribute("lang"), td.getAttribute("dir")])).toEqual([
      ["fr", "ltr"],
      ["fr", "ltr"]
    ]);
  });

  it("refuses a file over the size cap without reading it", async () => {
    const { root, controller } = mount();
    click(q(root, "[data-languages-import]"));
    const read = vi.spyOn(FileReader.prototype, "readAsText");
    const file = pick(root, "big.csv", "x", MAX_IMPORT_BYTES + 1);
    Object.defineProperty(file, "arrayBuffer", { value: () => Promise.reject(new Error("must not be read")) });
    await vi.waitFor(() => expect(root.querySelector('[data-exchange-problem="tooLarge"]')).not.toBeNull());
    expect(read).not.toHaveBeenCalled();
    expect(q<HTMLButtonElement>(root, "[data-exchange-apply]").disabled).toBe(true);
    expect(controller.canUndo()).toBe(false);
  });

  it("reports an unreadable file as a problem and leaves Apply off", async () => {
    const { root } = mount();
    click(q(root, "[data-languages-import]"));
    pick(root, "bad.json", "{ not json");
    await vi.waitFor(() => expect(root.querySelector("[data-exchange-problem]")).not.toBeNull());
    expect(q(root, "[data-exchange-problem]").textContent).toContain("not valid JSON");
    expect(q<HTMLButtonElement>(root, "[data-exchange-apply]").disabled).toBe(true);
  });
});

describe("rows the grid has no cell for, and cells the page words", () => {
  it("leaves the built-in texts of a language they have no cell in out of its needs-translation export", async () => {
    // English is the engine words' own language, so a French-default form has no `en` cell for them.
    const { root } = mount(languagesController({ supportedLocales: [{ code: "fr" }, { code: "en" }], defaultLocale: "fr" }));
    click(q(root, "[data-languages-export]"));
    choose(q<HTMLSelectElement>(root, "[data-exchange-scope]"), "needs");
    click(q(root, "[data-exchange-download]"));
    const out = JSON.parse(await textOf(downloads[0]!.blob)) as { texts: Array<{ kind: string; status: Record<string, string> }> };
    // They are asked for in French, the default language, and never in English.
    const needed = out.texts.filter((row) => row.kind === "texts");
    expect(needed.length).toBeGreaterThan(0);
    expect(needed.every((row) => row.status.en === undefined && row.status.fr === "missing")).toBe(true);
    // The all-texts export still lists them, so a translator sees them, with nothing asked of English.
    choose(q<HTMLSelectElement>(root, "[data-exchange-scope]"), "all");
    click(q(root, "[data-exchange-download]"));
    const all = JSON.parse(await textOf(downloads[1]!.blob)) as { texts: Array<{ kind: string; status: Record<string, string> }> };
    const engine = all.texts.filter((row) => row.kind === "texts");
    expect(engine.length).toBeGreaterThan(0);
    expect(engine.every((row) => row.status.en === undefined)).toBe(true);
  });

  it("does not ask for a translation of a cell the page's catalog words", async () => {
    const controller = languagesController();
    const surface = document.createElement(DATUM_BUILDER_LANGUAGES_TAG) as DatumBuilderLanguagesElement;
    surface.translationCatalog = { fr: { components: { kind: { label: "Genre (page)" } } } };
    surface.controller = controller;
    surface.definition = () => ({ id: "permit-form" }) as FormDefinition;
    document.body.append(surface);
    const root = surface.shadowRoot!;
    click(q(root, "[data-languages-export]"));
    const csv = q<HTMLInputElement>(root, '[data-exchange-format="csv"]');
    csv.checked = true;
    change(csv);
    choose(q<HTMLSelectElement>(root, "[data-exchange-scope]"), "needs");
    click(q(root, "[data-exchange-download]"));
    const text = await textOf(downloads[0]!.blob);
    expect(text).not.toContain("components,kind,label,");
    expect(text).toContain("components,name,description,");
  });
});

describe("the engine's words in a non-English default language", () => {
  const FRENCH = { supportedLocales: [{ code: "fr" }, { code: "en" }], defaultLocale: "fr" };

  it("offers the default language as a column, holding the engine's own words and nothing else", async () => {
    const { root } = mount(languagesController(FRENCH));
    click(q(root, "[data-languages-export]"));
    expect(q<HTMLInputElement>(root, '[data-exchange-language="fr"]').checked).toBe(true);
    click(q(root, "[data-exchange-download]"));
    const out = JSON.parse(await textOf(downloads[0]!.blob)) as { locales: string[]; texts: Array<{ kind: string; fr?: string; status: Record<string, string> }> };
    expect(out.locales).toEqual(["fr", "en"]);
    expect(out.texts.filter((row) => row.status.fr !== undefined).every((row) => row.kind === "texts")).toBe(true);
    expect(out.texts.filter((row) => row.kind === "texts").every((row) => row.status.fr !== undefined)).toBe(true);
  });

  it("names English as the source of the default language's XLIFF file", async () => {
    const { root } = mount(languagesController(FRENCH));
    click(q(root, "[data-languages-export]"));
    const xliff = q<HTMLInputElement>(root, '[data-exchange-format="xliff"]');
    xliff.checked = true;
    change(xliff);
    click(q(root, "[data-exchange-download]"));
    const link = q<HTMLAnchorElement>(root, '[data-exchange-link][download="permit-form-fr.xlf"]');
    expect(await textOf(blobs.get(link.getAttribute("href")!)!)).toContain('srcLang="en" trgLang="fr"');
  });
});

describe("import dialog behaviour", () => {
  const CSV = ["kind,key,path,lang:fr", "components,name,label,Nom entier", ""].join("\r\n");

  function file(name: string, text: string | Uint8Array, readBytes?: () => Promise<ArrayBuffer>): File {
    const made = new File([text as BlobPart], name, { type: "text/csv" });
    if (readBytes) {
      Object.defineProperty(made, "arrayBuffer", { value: readBytes });
    }
    return made;
  }

  function choosing(root: ShadowRoot, picked: File): void {
    const input = q<HTMLInputElement>(root, "[data-exchange-file]");
    Object.defineProperty(input, "files", { value: [picked], configurable: true });
    change(input);
  }

  it("keeps the preview of the file picked last when an earlier, slower read finishes after it", async () => {
    const { root } = mount();
    click(q(root, "[data-languages-import]"));
    let finishA!: (bytes: ArrayBuffer) => void;
    choosing(root, file("a.csv", "", () => new Promise<ArrayBuffer>((resolve) => (finishA = resolve))));
    choosing(root, file("b.csv", CSV));
    await vi.waitFor(() => expect(q(root, "[data-exchange-file-name]").textContent).toBe("Read: b.csv"));
    finishA(new TextEncoder().encode(CSV.replace("Nom entier", "Autre")).buffer as ArrayBuffer);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(q(root, "[data-exchange-file-name]").textContent).toBe("Read: b.csv");
    expect(q(root, '[data-exchange-row="components/name/label"]').textContent).toContain("Nom entier");
  });

  it("puts the focus back on the Import button after an applied import repainted the page under it", async () => {
    const { root } = mount();
    const opener = q<HTMLButtonElement>(root, "[data-languages-import]");
    opener.focus();
    click(opener);
    choosing(root, file("t.csv", CSV));
    await vi.waitFor(() => expect(root.querySelector("[data-exchange-table]")).not.toBeNull());
    click(q(root, "[data-exchange-apply]"));
    expect(dialogOf(root, "import")).toBeNull();
    const now = q<HTMLButtonElement>(root, "[data-languages-import]");
    expect(now.isConnected).toBe(true);
    expect(root.activeElement).toBe(now);
  });

  it("takes a file dropped anywhere on the dialog and cancels the drag so the browser does not open it", async () => {
    const { root } = mount();
    click(q(root, "[data-languages-import]"));
    const dropped = file("t.csv", CSV);
    const drag = (type: string, target: Element): Event => {
      const event = new Event(type, { bubbles: true, cancelable: true, composed: true });
      Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files: [dropped] } });
      target.dispatchEvent(event);
      return event;
    };
    const outside = q(root, 'dialog[data-languages-exchange-dialog="import"] h2');
    expect(q(root, "[data-exchange-drop]").contains(outside)).toBe(false);
    expect(drag("dragover", outside).defaultPrevented).toBe(true);
    expect(drag("drop", outside).defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(q(root, "[data-exchange-file-name]").textContent).toBe("Read: t.csv"));
    // A drag that carries no file is left alone.
    const text = new Event("dragover", { bubbles: true, cancelable: true, composed: true });
    Object.defineProperty(text, "dataTransfer", { value: { types: ["text/plain"], files: [] } });
    outside.dispatchEvent(text);
    expect(text.defaultPrevented).toBe(false);
  });

  it("shows a refused addition inside the dialog, as an alert, rather than in the surface's region the modal hides", async () => {
    const { root, controller } = mount();
    click(q(root, "[data-languages-import]"));
    choosing(root, file("t.csv", ["kind,key,path,lang:fr,lang:es", "components,name,label,Nom entier,Nombre", ""].join("\r\n")));
    await vi.waitFor(() => expect(root.querySelector("[data-exchange-add]")).not.toBeNull());
    const box = q<HTMLInputElement>(root, '[data-exchange-add="es"]');
    box.checked = true;
    change(box);
    // The language is added another way while the dialog is open: the form now refuses it.
    controller.localizationActions.addLocale("es", "");
    click(q(root, "[data-exchange-apply]"));
    const refused = q(root, "[data-exchange-refused]");
    expect(refused.getAttribute("role")).toBe("alert");
    expect(refused.textContent).toContain("es");
    expect(q(root, "[data-languages-live]").textContent).toBe("");
    expect(dialogOf(root, "import")).not.toBeNull();
  });

  it("refuses a file that is not UTF-8 with a worded problem, and changes nothing", async () => {
    const { root, controller } = mount();
    click(q(root, "[data-languages-import]"));
    // "Résumé" saved as Windows-1252: the bytes 0xE9 are no UTF-8.
    const bytes = new Uint8Array([...new TextEncoder().encode("kind,key,path,lang:fr\r\ncomponents,name,label,R"), 0xe9, ...new TextEncoder().encode("sum"), 0xe9, 0x0d, 0x0a]);
    choosing(root, file("cp1252.csv", bytes));
    await vi.waitFor(() => expect(root.querySelector('[data-exchange-problem="notUtf8"]')).not.toBeNull());
    expect(q(root, '[data-exchange-problem="notUtf8"]').textContent).toContain("not UTF-8");
    expect(root.querySelector("[data-exchange-table]")).toBeNull();
    expect(q<HTMLButtonElement>(root, "[data-exchange-apply]").disabled).toBe(true);
    expect(controller.canUndo()).toBe(false);
  });

  it("reads a UTF-8 file that leads with a byte-order mark, as Excel saves it", async () => {
    const { root } = mount();
    click(q(root, "[data-languages-import]"));
    const body = new TextEncoder().encode(CSV.replace("Nom entier", "Prénom entier"));
    choosing(root, file("bom.csv", new Uint8Array([0xef, 0xbb, 0xbf, ...body])));
    await vi.waitFor(() => expect(root.querySelector("[data-exchange-table]")).not.toBeNull());
    expect(root.querySelector('[data-exchange-problem="notUtf8"]')).toBeNull();
    expect(q(root, '[data-exchange-row="components/name/label"]').textContent).toContain("Prénom entier");
  });

  it("words a cell the page words, and a language with no cell, apart from an unknown text", async () => {
    const controller = languagesController({ supportedLocales: [{ code: "fr" }, { code: "en" }], defaultLocale: "fr" });
    const surface = document.createElement(DATUM_BUILDER_LANGUAGES_TAG) as DatumBuilderLanguagesElement;
    surface.translationCatalog = { en: { components: { kind: { label: "Kind (page)" } } } };
    surface.controller = controller;
    surface.definition = () => ({ id: "permit-form" }) as FormDefinition;
    document.body.append(surface);
    const root = surface.shadowRoot!;
    click(q(root, "[data-languages-import]"));
    choosing(
      root,
      file("t.csv", ["kind,key,path,lang:en", "components,kind,label,Kind", "texts,form,summaryHeading,Summary", "components,ghost,label,Ghost", ""].join("\r\n"))
    );
    await vi.waitFor(() => expect(root.querySelector("[data-exchange-table]")).not.toBeNull());
    const status = (key: string): string => q(root, `[data-exchange-row="${key}"]`).querySelector("td:last-child")!.textContent!;
    expect(q(root, '[data-exchange-row="components/kind/label"]').getAttribute("data-exchange-status")).toBe("pageWorded");
    expect(status("components/kind/label")).toBe("The page's catalog words this text, skipped");
    expect(q(root, '[data-exchange-row="texts/form/summaryHeading"]').getAttribute("data-exchange-status")).toBe("noCell");
    expect(status("texts/form/summaryHeading")).toBe("This language has no text of its own here, skipped");
    expect(status("components/ghost/label")).toBe("Unknown text, skipped");
    expect(q(root, '[data-exchange-count="skipped"] strong').textContent).toBe("2");
    expect(q(root, '[data-exchange-count="unknown"] strong').textContent).toBe("1");
  });

  it("applies the default language's column for an engine word, in one undo step", async () => {
    const { root, controller } = mount(languagesController({ supportedLocales: [{ code: "fr" }, { code: "en" }], defaultLocale: "fr" }));
    click(q(root, "[data-languages-import]"));
    choosing(root, file("t.csv", ["kind,key,path,lang:fr", "texts,form,summaryHeading,Sommaire des erreurs", ""].join("\r\n")));
    await vi.waitFor(() => expect(root.querySelector("[data-exchange-table]")).not.toBeNull());
    click(q(root, "[data-exchange-apply]"));
    expect(readTranslation(controller.translations(), "fr", addressOf.formText("summaryHeading"))?.text).toBe("Sommaire des erreurs");
    controller.undo();
    expect(readTranslation(controller.translations(), "fr", addressOf.formText("summaryHeading"))).toBeUndefined();
  });
});
