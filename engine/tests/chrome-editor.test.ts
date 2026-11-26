import { describe, expect, it } from "vitest";

import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { BuilderPreviewRuntime } from "../form-engine/builder/preview/builder-preview-runtime.js";
import { buildInspectorModel } from "../form-engine/builder/property-editor/inspector-model.js";
import { chromeRegionEditorHtml } from "../form-engine/builder/web-component/builder-chrome-panel.js";
import {
  CHROME_PART_TYPE_LABELS,
  chromeListAt,
  chromePartAt,
  chromePartIds,
  chromePartPath,
  createChromePart,
  nextChromePartId,
  propertiesPanelHtml
} from "../form-engine/builder/web-component/builder-shared.js";
import { buildNestedTreeView } from "../form-engine/builder/tree-editor/nested-tree-view.js";
import { FORM_CHROME_PART_TYPES, type FormChromePart } from "../form-engine/core/schema/form-chrome.js";
import type { ComponentNode, LocalizationConfiguration } from "../form-engine/core/schema/types.js";

// Every authored part carries an id, unique across the header and the footer.
const PARTS: FormChromePart[] = [
  {
    id: "top",
    type: "group",
    parts: [
      { id: "logo", type: "image", src: "/logo-en.svg", alt: "Acme" },
      { id: "switcher", type: "language-switcher", label: "Language" }
    ]
  },
  { id: "title", type: "form-title" },
  { id: "intro", type: "html", html: "<p>Fill in <b>every</b> field.</p>", align: "center" }
];

const ROOT: ComponentNode = {
  id: "root",
  type: "form",
  configuration: { title: "Intake", chrome: { header: PARTS, footer: [{ id: "contact", type: "text", text: "Contact us" }] } },
  children: { content: [] }
};

describe("inspector model — the form root's header and footer", () => {
  it("gives the root a Header & footer section with a chrome row per region, parts normalised", () => {
    const model = buildInspectorModel(ROOT);
    const section = model.sections.find((entry) => entry.id === "chrome");
    expect(section?.title).toBe("Header & footer");
    expect(section?.fields.map((field) => [field.propertyPath, field.control, field.label])).toEqual([
      ["chrome.frame", "select", "Frame"],
      ["chrome.header", "chrome", "Header"],
      ["chrome.footer", "chrome", "Footer"]
    ]);
    // The Frame picker: Not set first, the default when the form names no frame, then
    // the built-ins, or the theme's own when the host passes them.
    expect(section?.fields[0]?.value).toBe("");
    expect(section?.fields[0]?.choices.map((choice) => choice.value)).toEqual(["", "seamless", "outlined", "paper"]);
    expect(section?.fields[0]?.choices[0]?.label).toBe("Not set (the host's frame)");
    expect(section?.fields[0]?.description).toContain("Not set leaves it to the application showing the form");
    const framed = buildInspectorModel({ ...ROOT, configuration: { chrome: { frame: "paper" } } });
    expect(framed.sections.find((entry) => entry.id === "chrome")?.fields[0]?.value).toBe("paper");
    const themed = buildInspectorModel(ROOT, [], undefined, "en", {
      frameOptions: [
        { id: "seamless", label: "Seamless (no frame)" },
        { id: "outlined", label: "Outlined" },
        { id: "paper", label: "Card" },
        { id: "notepad", label: "Notepad" }
      ]
    });
    expect(themed.sections.find((entry) => entry.id === "chrome")?.fields[0]?.choices.map((choice) => choice.label)).toEqual([
      "Not set (the host's frame)",
      "Seamless (no frame)",
      "Outlined",
      "Card",
      "Notepad"
    ]);
    expect(section?.fields[1]?.chromeEditor).toEqual({ region: "header", parts: PARTS });
    expect(section?.fields[2]?.chromeEditor?.parts).toEqual([{ id: "contact", type: "text", text: "Contact us" }]);
    // A root with no chrome still offers the rows, empty.
    const bare = buildInspectorModel({ id: "root", type: "form", configuration: {} });
    expect(bare.sections.find((entry) => entry.id === "chrome")?.fields.slice(1).map((field) => field.chromeEditor?.parts)).toEqual([[], []]);
  });

  it("draws each region's row as a summary and a button that opens the Header & footer panel on it", () => {
    const model = buildInspectorModel(ROOT);
    const html = propertiesPanelHtml(model, ROOT, {
      tab: "properties",
      treeView: buildNestedTreeView(ROOT),
      hiddenIds: new Set<string>(),
      idError: undefined,
      idEditable: true,
      isRoot: true
    });
    expect(html).toContain("<span data-chrome-count>Group (Image, Language switcher), Form title, HTML</span>");
    expect(html).toContain('data-chrome-open="header" title="Open the Header &amp; footer panel">Edit header…</button>');
    expect(html).toContain("<span data-chrome-count>Text</span>");
    expect(html).toContain('data-chrome-open="footer" title="Open the Header &amp; footer panel">Edit footer…</button>');
    // Nothing edits the parts here any more: the dialog is gone with its protocol.
    expect(html).not.toContain("data-chrome-edit");
    expect(html).not.toContain("data-chrome-dialog");
  });

});

describe("chrome parts editor — working copy helpers", () => {
  it("finds a part by its row key, groups walked", () => {
    expect(chromePartAt(PARTS, "1")).toEqual({ id: "title", type: "form-title" });
    expect(chromePartAt(PARTS, "0.1")?.type).toBe("language-switcher");
    expect(chromeListAt(PARTS, "0.1")).toEqual({ list: (PARTS[0] as { parts: FormChromePart[] }).parts, index: 1 });
    expect(chromePartAt(PARTS, "1.0")).toBeUndefined();
    expect(chromePartAt(PARTS, "9")).toBeUndefined();
    expect(chromePartAt(PARTS, "x")).toBeUndefined();
    expect(chromePartPath("chrome.header", "0.1")).toBe("chrome.header.0.parts.1");
    expect(chromePartPath("chrome.footer", "2")).toBe("chrome.footer.2");
  });

  it("creates an empty part of every type the picker offers", () => {
    expect(CHROME_PART_TYPE_LABELS.map((entry) => entry.value).sort()).toEqual([...FORM_CHROME_PART_TYPES].sort());
    expect(createChromePart("image")).toEqual({ id: "part_1", type: "image", src: "" });
    expect(createChromePart("group")).toEqual({ id: "part_1", type: "group", parts: [] });
    expect(createChromePart("form-title")).toEqual({ id: "part_1", type: "form-title" });
    expect(createChromePart("heading")).toEqual({ id: "part_1", type: "heading", text: "" });
  });

  it("names a new part in the part_1 style, free across the header and the footer, groups walked", () => {
    expect(nextChromePartId([])).toBe("part_1");
    expect(nextChromePartId(["part_1", "part_3"])).toBe("part_2");
    expect(chromePartIds(PARTS)).toEqual(["top", "logo", "switcher", "title", "intro"]);
    const taken = [...chromePartIds(PARTS), "part_1"];
    expect(createChromePart("text", taken).id).toBe("part_2");
    expect(createChromePart("text", taken)).toEqual({ id: "part_2", type: "text", text: "" });
  });
});

describe("Header & footer panel — a region's editor markup", () => {
  it("draws a block per part with its type, place, boxes, order and remove, groups indented with their own Add, inside the region's section", () => {
    const html = chromeRegionEditorHtml("header", PARTS);
    // The section names its region: the same row keys serve both regions, and the section
    // around a control is what tells the header's first part from the footer's.
    expect(html).toContain('<section class="db-chrome-region" data-chrome-region="header" aria-labelledby="chrome-header-title">');
    expect(html).toContain('<h4 class="db-chrome-region__title" id="chrome-header-title">Header</h4>');
    // The group: its own boxes, then its parts nested with keys under it.
    expect(html).toContain('data-chrome-part-row="0"');
    expect(html).toContain('<select data-chrome-row="0" data-chrome-field="type" aria-label="Part"><option value="form-title">');
    expect(html).toContain('<option value="group" selected>Group (parts side by side)</option>');
    expect(html).toContain('data-chrome-row="0" data-chrome-field="justify"');
    expect(html).toContain('data-chrome-list="0"');
    expect(html).toContain('data-chrome-part-row="0.0"');
    expect(html).toContain('data-chrome-row="0.0" data-chrome-field="src" aria-label="Image URL" value="/logo-en.svg"');
    // The image address and the switcher's label are plain strings: a language's own wording is Languages'.
    expect(html).toContain('data-chrome-row="0.1" data-chrome-field="label" aria-label="Label (default: Language)" value="Language"');
    // A nested part has no place of its own (the group spreads its parts) and cannot be a group.
    expect(html).not.toContain('data-chrome-row="0.0" data-chrome-field="align"');
    expect(html).toMatch(/data-chrome-row="0\.0" data-chrome-field="type" aria-label="Part">(?:(?!value="group").)*<\/select>/);
    expect(html).toContain('data-chrome-add-type="0"');
    expect(html).toContain('data-chrome-add="0">Add to group</button>');
    // Top-level parts: place, order, remove; the first cannot move up, the last cannot move down.
    expect(html).toContain('data-chrome-row="2" data-chrome-field="align"');
    expect(html).toContain('<option value="center" selected>Center</option>');
    expect(html).toContain('data-chrome-move="0:-1" aria-label="Move part 1 up" data-tip="Move up" data-tip-side="top" disabled');
    expect(html).toContain('data-chrome-move="2:1" aria-label="Move part 3 down" data-tip="Move down" data-tip-side="top" disabled');
    expect(html).toContain('data-chrome-remove="1"');
    // The html part's box escapes its markup; the form-title part offers a level.
    expect(html).toContain('<textarea data-chrome-row="2" data-chrome-field="html" aria-label="HTML" rows="3">&lt;p&gt;Fill in &lt;b&gt;every&lt;/b&gt; field.&lt;/p&gt;</textarea>');
    expect(html).toContain('data-chrome-row="1" data-chrome-field="level" aria-label="Level"><option value="" selected>Default (h1)</option>');
    expect(html).toContain('data-chrome-add-type=""');
    expect(html).toContain('data-chrome-add="">Add part</button>');
    // No dialog, no Apply: the parts go to the draft as they are edited.
    expect(html).not.toContain("<dialog");
    expect(html).not.toContain("data-chrome-apply");
  });

  it("says when the region is empty", () => {
    const html = chromeRegionEditorHtml("footer", []);
    expect(html).toContain('data-chrome-region="footer"');
    expect(html).toContain(">Footer</h4>");
    expect(html).toContain("Nothing in the footer yet. Add a part below.");
    expect(html).not.toContain("data-chrome-part-row");
    expect(html).toContain('data-chrome-add="">Add part</button>');
  });
});

describe("builder preview runtime — the form's locales for the canvas's chrome", () => {
  it("answers the renderer's localization() from the option, so an authored switcher previews", () => {
    let locales: LocalizationConfiguration | undefined = { supportedLocales: [{ code: "en", label: "English" }, { code: "fr-CA", label: "Français" }] };
    const preview = new BuilderPreviewRuntime(ROOT, { localization: () => locales });
    expect(preview.localization()).toEqual(locales);
    // Read when asked, not copied at construction: the Form panel's Save changes the block.
    locales = undefined;
    expect(preview.localization()).toBeUndefined();
    expect(new BuilderPreviewRuntime(ROOT).localization()).toBeUndefined();
  });
});

function controllerFor(root: ComponentNode): BuilderController {
  return new BuilderController({
    componentTypes: [{ type: "text", label: "Text" }],
    initialRoot: root,
    componentDefinitions: [
      {
        type: "form",
        version: "1.0.0",
        capabilities: [],
        createDefault: () => ({ id: "root", type: "form", configuration: {} }),
        children: { slots: [{ id: "content", multiple: true }] }
      },
      { type: "text", version: "1.0.0", capabilities: [], createDefault: () => ({ id: "text", type: "text", configuration: {} }) }
    ]
  });
}

describe("builder controller — the Frame picker's Not set", () => {
  it("takes chrome.frame out of the definition, and chrome with it when nothing else is in it", () => {
    const ctrl = controllerFor({ id: "root", type: "form", configuration: { title: "Intake" }, children: { content: [] } });
    ctrl.setDraftProperty("root", "chrome.frame", "outlined");
    expect(ctrl.commitDraft("root")).toBe(true);
    expect(ctrl.snapshot().configuration).toEqual({ title: "Intake", chrome: { frame: "outlined" } });

    // Not set is the select's "": the key goes rather than an empty value being written.
    ctrl.setDraftProperty("root", "chrome.frame", "");
    expect(ctrl.draftProperty("root", "chrome.frame")).toBeUndefined();
    expect(ctrl.commitDraft("root")).toBe(true);
    const configuration = ctrl.snapshot().configuration as Record<string, unknown>;
    expect(configuration).toEqual({ title: "Intake" });
    expect("chrome" in configuration).toBe(false);
    expect(JSON.stringify(ctrl.snapshot())).not.toContain("frame");
  });

  it("keeps the header and footer when only the frame goes", () => {
    const ctrl = controllerFor({ ...ROOT, configuration: { ...(ROOT.configuration as object), chrome: { header: PARTS, frame: "paper" } } });
    ctrl.setDraftProperty("root", "chrome.frame", "");
    ctrl.commitDraft("root");
    const chrome = (ctrl.snapshot().configuration as { chrome?: Record<string, unknown> }).chrome;
    expect(chrome).toEqual({ header: PARTS });
    expect(chrome && "frame" in chrome).toBe(false);
  });

  it("writes \"\" as it is for any other property that holds a value; over an unset one it is no edit", () => {
    const ctrl = controllerFor({ id: "root", type: "form", configuration: { title: "Intake" }, children: { content: [] } });
    ctrl.setDraftProperty("root", "title", "");
    expect(ctrl.draftProperty("root", "title")).toBe("");
    const unset = controllerFor({ id: "root", type: "form", configuration: {}, children: { content: [] } });
    unset.setDraftProperty("root", "title", "");
    expect(unset.draftProperty("root", "title")).toBeUndefined();
    expect(unset.hasPendingChanges("root")).toBe(false);
  });
});

describe("builder controller — draft paths into lists", () => {
  it("reads and writes a chrome text by its indexed path without clobbering the list", () => {
    const ctrl = new BuilderController({
      componentTypes: [{ type: "text", label: "Text" }],
      initialRoot: ROOT,
      componentDefinitions: [
        {
          type: "form",
          version: "1.0.0",
          capabilities: [],
          createDefault: () => ({ id: "root", type: "form", configuration: {} }),
          children: { slots: [{ id: "content", multiple: true }] }
        },
        { type: "text", version: "1.0.0", capabilities: [], createDefault: () => ({ id: "text", type: "text", configuration: {} }) }
      ]
    });
    expect(ctrl.draftProperty("root", "chrome.header.0.parts.0.alt")).toBe("Acme");
    ctrl.setDraftProperty("root", "chrome.header.0.parts.0.alt", "Acmé");
    expect(ctrl.draftProperty("root", "chrome.header.0.parts.0.alt")).toBe("Acmé");
    const header = ctrl.draftProperty("root", "chrome.header") as FormChromePart[];
    expect(Array.isArray(header)).toBe(true);
    expect(header).toHaveLength(3);
    expect(ctrl.draftProperty("root", "chrome.footer.0.text")).toBe("Contact us");
    expect(ctrl.draftProperty("root", "chrome.footer.5.text")).toBeUndefined();
  });
});
