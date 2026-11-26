/**
 * A populated-form layout's tree: the template's own fields and the areas drawn on
 * its pages as `ComponentDefinition`s, so the PDF designer over a template is the builder over
 * an ordinary registry — selection, drafts, Save and Cancel, undo, the outline — the way a
 * custom layout already is. The root carries the PDF and the fill options; a
 * `pdf-widget` is one of the PDF's own fields, listed from the file and never added or removed
 * by hand; a `pdf-area` is a rectangle the author draws on a page. What fills a
 * widget or an area — a form component, text with placeholders, a fixed value — is edited as
 * properties on the node, and `pdf-template-designer.ts` folds the tree back into the layout.
 */
import type {
  CapabilityDefinition,
  ComponentDefinition,
  LocalizedText,
  PropertyEditorAssetChoice,
  PropertyEditorChoice,
  PropertyEditorField,
  PropertyEditorSection,
  PropertyEditorValueMap
} from "../../core/schema/contracts.js";
import type { ComponentNode } from "../../core/schema/types.js";
import { DEFAULT_PDF_ATTACHMENT_NAME, DEFAULT_PDF_AREA_DRAW, PDF_BUILTIN_PROFILES, builtinProfileSource } from "../../core/schema/pdf-layout.js";
import type { PdfProfileOption, PdfTemplateOption } from "./pdf-provider.js";
import { PDF_ICC_ACCEPT, type PdfBindableComponent, type PdfComponentTypeEntry } from "./pdf-components.js";
import {
  PDF_AREA_COMPONENT_TYPE,
  PDF_TEMPLATE_ACCEPT,
  PDF_TEMPLATE_AREAS_SLOT,
  PDF_TEMPLATE_COMPONENT_TYPE,
  PDF_TEMPLATE_PALETTE_GROUP,
  PDF_TEMPLATE_WIDGETS_SLOT,
  PDF_WIDGET_COMPONENT_TYPE
} from "./pdf-template-constants.js";

export {
  PDF_AREA_COMPONENT_TYPE,
  PDF_TEMPLATE_ACCEPT,
  PDF_TEMPLATE_AREAS_SLOT,
  PDF_TEMPLATE_COMPONENT_TYPE,
  PDF_TEMPLATE_PALETTE_GROUP,
  PDF_TEMPLATE_WIDGETS_SLOT,
  PDF_WIDGET_COMPONENT_TYPE
} from "./pdf-template-constants.js";

/**
 * The English of the words the populated-form root shows an author (its property labels, hints and
 * choices). Like `PDF_COMPONENT_TEXT_EN`, the builder's catalog spreads this table
 * (`builder/pdf-designer/pdf-texts-en.ts`), so a host translates them with the rest of the builder.
 */
export const PDF_TEMPLATE_TEXT_EN = {
  "pdfTemplate.section.template": "Template",
  "pdfTemplate.name": "Layout name",
  "pdfTemplate.file": "PDF file",
  "pdfTemplate.file.description": "The PDF this layout fills. Uploaded, it travels with the form; one of the host's stays where the host keeps it. Choosing another re-reads its fields.",
  "pdfTemplate.host": "From the host",
  "pdfTemplate.section.fill": "Fill options",
  "pdfTemplate.flatten": "Flatten",
  "pdfTemplate.flatten.description": "Write the answers as page content: the output has no fillable fields.",
  "pdfTemplate.readOnly": "Read-only fields",
  "pdfTemplate.readOnly.description": "Keep the fields, but mark them read-only.",
  "pdfTemplate.appearances": "Field appearances",
  "pdfTemplate.appearances.regenerate": "Regenerate (the kernel draws the values)",
  "pdfTemplate.appearances.viewer": "Viewer (the reader's viewer draws them)",
  "pdfTemplate.section.archival": "Archival (PDF/A)",
  "pdfTemplate.pdfa": "PDF/A",
  "pdfTemplate.pdfa.description": "The archival level the filled document keeps. A template that is not PDF/A cannot become one by filling.",
  "pdfTemplate.outputIntent": "Output condition (ICC profile)",
  "pdfTemplate.outputIntent.description": "The output condition the PDF/A file declares. None: the template's own, else sRGB IEC61966-2.1.",
  "pdfTemplate.attachData": "Attach the submission data (PDF/A-3)",
  "pdfTemplate.attachData.description": "Embed the answers as a JSON file the reader lists beside the pages. Part 3 only.",
  "pdfTemplate.attachment.name": "Attachment file name",
  "pdfTemplate.attachment.name.description": "Empty uses {name}.",
  "pdfTemplate.attachment.description": "Attachment description",
  "pdfTemplate.section.signature": "Signature",
  "pdfTemplate.signature.field": "Signature field",
  "pdfTemplate.signature.field.description": "The template's signature field the server signs into.",
  "pdfTemplate.signature.field.typed.description": "The template's signature field (its name) the server signs into; empty, a signature block of its own.",
  "pdfTemplate.signature.none": "A signature block of its own",
  "pdfTemplate.signature.required": "Require the server's signature",
  "pdfTemplate.signature.required.description": "A document rendered without the host's certificates is refused instead of produced unsigned.",
  "pdfTemplate.signature.reason": "Signature reason",
  "pdfTemplate.pdfa.off": "Off — an ordinary PDF",
  "pdfTemplate.pdfa.2u": "PDF/A-2u (Unicode)",
  "pdfTemplate.pdfa.2a": "PDF/A-2a (accessible: Unicode and tagged)",
  "pdfTemplate.pdfa.3b": "PDF/A-3b (attachments allowed)",
  "pdfTemplate.pdfa.3u": "PDF/A-3u (Unicode, attachments allowed)",
  "pdfTemplate.pdfa.3a": "PDF/A-3a (accessible, attachments allowed)",
  "pdfTemplate.profile.builtIn": "Built in",
  "pdfTemplate.choose": "— choose —",
  "pdfTemplate.section.mapping": "Mapping",
  "pdfTemplate.source.kind": "Filled from",
  "pdfTemplate.source.kind.description": "What goes into it: an answer from the form, text with {{placeholders}} for answers, or a value written as is.",
  "pdfTemplate.source.none": "Nothing",
  "pdfTemplate.source.component": "Form component",
  "pdfTemplate.source.component.description": "The answer written here, when filled from a form component.",
  "pdfTemplate.source.template": "Text with {{placeholders}}",
  "pdfTemplate.source.text": "Text",
  "pdfTemplate.source.text.description": "Written when filled from text; {{fieldId}} inserts an answer.",
  "pdfTemplate.source.literal": "Fixed value",
  "pdfTemplate.source.literal.description": "Written as is, when filled from a fixed value.",
  "pdfTemplate.source.path": "Value path",
  "pdfTemplate.source.path.description": "The saved value written here, by the path it is stored under (the Data workspace lists them). Another path may be typed.",
  "pdfTemplate.source.expression": "Formula",
  "pdfTemplate.source.expression.description": "Worked out from the answers and written here, when filled from a formula.",
  "pdfTemplate.checkedWhen": "Checked when",
  "pdfTemplate.checkedWhen.description": "For a check box, a radio group or a check mark: the answer that means checked, or the option to select.",
  "pdfTemplate.section.values": "Values",
  "pdfTemplate.values": "Values written to the PDF",
  "pdfTemplate.values.description": "A PDF names the options of a radio group, dropdown or list by export value — often 1, 2, 3 while the page shows words. Choose the value written for each answer; an answer left at Same value is written as it is.",
  "pdfTemplate.values.same": "Same value",
  "pdfTemplate.values.byOrder": "Match by order",
  "pdfTemplate.values.byOrder.hint": "Pair the first answer with the field's first option, the second with the second, and so on.",
  "pdfTemplate.values.yes": "Yes",
  "pdfTemplate.values.no": "No",
  "pdfTemplate.values.unmatched": "Not matched to an option of this PDF field: {names}. Such an answer is written as it is, and the field stays empty.",
  "pdfTemplate.values.removeStale": "Remove stale entries",
  "pdfTemplate.values.removeStale.hint": "Delete the entries for options the form no longer has and for values this PDF field does not list. The rest stay.",
  "pdfTemplate.values.staleKeys": "Entries for options this form no longer has: {names}. They translate nothing now.",
  "pdfTemplate.values.staleTargets.one": "{names} is not an export value of this PDF field, so the entry fills nothing.",
  "pdfTemplate.values.staleTargets.other": "{names} are not export values of this PDF field, so their entries fill nothing.",
  "pdfTemplate.values.staleLayout.one": "{count} field has value-map entries that no longer match: {names}.",
  "pdfTemplate.values.staleLayout.other": "{count} fields have value-map entries that no longer match: {names}.",
  "pdfTemplate.format": "Format",
  "pdfTemplate.format.asIs": "As is",
  "pdfTemplate.format.text": "Text",
  "pdfTemplate.format.number": "Number",
  "pdfTemplate.format.date": "Date",
  "pdfTemplate.format.boolean": "Yes / no",
  "pdfTemplate.format.pattern": "Format pattern",
  "pdfTemplate.format.pattern.description": "Decimals for a number, a date pattern, yes|no texts for yes / no.",
  "pdfTemplate.area": "Area",
  "pdfTemplate.area.label": "Name",
  "pdfTemplate.area.label.description": "What the outline calls the area; also the fillable field's name and tooltip unless set below.",
  "pdfTemplate.area.page": "Page",
  "pdfTemplate.area.x": "X (pt)",
  "pdfTemplate.area.y": "Y (pt)",
  "pdfTemplate.area.y.description": "From the page's top edge.",
  "pdfTemplate.area.width": "Width (pt)",
  "pdfTemplate.area.height": "Height (pt)",
  "pdfTemplate.section.drawing": "Drawing",
  "pdfTemplate.draw.kind": "Drawn as",
  "pdfTemplate.draw.text": "Text",
  "pdfTemplate.draw.check": "Check mark",
  "pdfTemplate.draw.fontSize": "Font size (pt)",
  "pdfTemplate.draw.align": "Align",
  "pdfTemplate.draw.align.start": "Left",
  "pdfTemplate.draw.align.center": "Centre",
  "pdfTemplate.draw.align.end": "Right",
  "pdfTemplate.draw.valign": "Vertical align",
  "pdfTemplate.draw.valign.top": "Top",
  "pdfTemplate.draw.valign.middle": "Middle",
  "pdfTemplate.draw.valign.bottom": "Bottom",
  "pdfTemplate.draw.padding": "Padding (pt)",
  "pdfTemplate.draw.wrap": "Wrap long text",
  "pdfTemplate.draw.bold": "Bold",
  "pdfTemplate.draw.color": "Colour",
  "pdfTemplate.draw.color.description": "#rrggbb; empty, the kernel's text colour.",
  "pdfTemplate.section.field": "Fillable field",
  "pdfTemplate.field.enabled": "Fillable field",
  "pdfTemplate.field.enabled.description": "Write a form field the reader can fill instead of page content: a text field, or a check box for a check mark.",
  "pdfTemplate.field.name": "Field name",
  "pdfTemplate.field.name.description": "The AcroForm field name; empty, the area's name. Two areas of one name share one field.",
  "pdfTemplate.field.required": "Required",
  "pdfTemplate.field.readOnly": "Read-only",
  "pdfTemplate.field.tooltip": "Tooltip",
  "pdfTemplate.field.tooltip.description": "Empty, the area's name."
} as const;

/** The keys of the words the populated-form root shows, in the builder's catalog. */
export type PdfTemplateTextKey = keyof typeof PDF_TEMPLATE_TEXT_EN;

/** The words for those keys, a `{name}` slot filled from `params`; the builder passes its own catalog's, English when absent. */
export type PdfTemplateText = (key: PdfTemplateTextKey, params?: Record<string, string | number>) => string;

const englishPdfTemplateText: PdfTemplateText = (key, params) =>
  PDF_TEMPLATE_TEXT_EN[key].replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (whole, name: string) => (params !== undefined && name in params ? String(params[name]) : whole));

export interface PdfTemplateComponentDefinitionOptions {
  /** The words of the root's labels, in the builder's locale; English when absent. */
  texts?: PdfTemplateText | undefined;
  /** The form's components a widget or an area may be filled from. */
  formComponents?: readonly PdfBindableComponent[] | undefined;
  /** The PDFs the host offers authors, for the root's PDF picker beside uploading. */
  hostTemplates?: readonly PdfTemplateOption[] | undefined;
  /** The ICC profiles the host offers as PDF/A output conditions. */
  outputIntentProfiles?: readonly PdfProfileOption[] | undefined;
  /** The template's signature fields, for the root's "signature field" choice; none, a free name. */
  signatureFields?: readonly string[] | undefined;
  /**
   * What a widget's Values section translates: the answers of the component it is
   * filled from and the options of the PDF field, for the widget `node`; `undefined` where the
   * field or the source offers none, and the section is not drawn.
   */
  valueMapFor?: ((node: ComponentNode) => PropertyEditorValueMap | undefined) | undefined;
  locale?: string | undefined;
}

/** What the designer's palette offers over a template: an area to draw. The widgets come from the PDF. */
export function pdfTemplateComponentTypes(texts: PdfTemplateText = englishPdfTemplateText): PdfComponentTypeEntry[] {
  return [{ type: PDF_AREA_COMPONENT_TYPE, label: texts("pdfTemplate.area"), icon: "▭", group: PDF_TEMPLATE_PALETTE_GROUP }];
}

/** The `source.kind` choices: a saved value path and a formula (an `expression`) are authored here too. */
function sourceKindChoices(t: PdfTemplateText): PropertyEditorChoice[] {
  return [
    { value: "", label: t("pdfTemplate.source.none") },
    { value: "component", label: t("pdfTemplate.source.component") },
    { value: "template", label: t("pdfTemplate.source.template") },
    { value: "literal", label: t("pdfTemplate.source.literal") },
    { value: "path", label: t("pdfTemplate.source.path") },
    { value: "expression", label: t("pdfTemplate.source.expression") }
  ];
}
export const PDF_SOURCE_KIND_CHOICES: PropertyEditorChoice[] = sourceKindChoices(englishPdfTemplateText);

function formatKindChoices(t: PdfTemplateText): PropertyEditorChoice[] {
  return [
    { value: "", label: t("pdfTemplate.format.asIs") },
    { value: "text", label: t("pdfTemplate.format.text") },
    { value: "number", label: t("pdfTemplate.format.number") },
    { value: "date", label: t("pdfTemplate.format.date") },
    { value: "boolean", label: t("pdfTemplate.format.boolean") }
  ];
}

function drawKindChoices(t: PdfTemplateText): PropertyEditorChoice[] {
  return [
    { value: "text", label: t("pdfTemplate.draw.text") },
    { value: "check", label: t("pdfTemplate.draw.check") }
  ];
}
function alignChoices(t: PdfTemplateText): PropertyEditorChoice[] {
  return [
    { value: "start", label: t("pdfTemplate.draw.align.start") },
    { value: "center", label: t("pdfTemplate.draw.align.center") },
    { value: "end", label: t("pdfTemplate.draw.align.end") }
  ];
}
function valignChoices(t: PdfTemplateText): PropertyEditorChoice[] {
  return [
    { value: "top", label: t("pdfTemplate.draw.valign.top") },
    { value: "middle", label: t("pdfTemplate.draw.valign.middle") },
    { value: "bottom", label: t("pdfTemplate.draw.valign.bottom") }
  ];
}

/** The archival levels a layout may declare, worded by `t`; the empty choice is an ordinary PDF. The level ids are standards names. */
function pdfAChoices(t: PdfTemplateText): PropertyEditorChoice[] {
  return [
    { value: "", label: t("pdfTemplate.pdfa.off") },
    { value: "2b", label: "PDF/A-2b" },
    { value: "2u", label: t("pdfTemplate.pdfa.2u") },
    { value: "2a", label: t("pdfTemplate.pdfa.2a") },
    { value: "3b", label: t("pdfTemplate.pdfa.3b") },
    { value: "3u", label: t("pdfTemplate.pdfa.3u") },
    { value: "3a", label: t("pdfTemplate.pdfa.3a") }
  ];
}

/** The output-intent picker: the kernel's built-in profiles, then the host's, each under its group's name. */
function outputIntentChoices(hostProfiles: readonly PdfProfileOption[], t: PdfTemplateText): PropertyEditorAssetChoice[] {
  return [
    ...PDF_BUILTIN_PROFILES.map((profile) => ({ id: `builtin:${profile.id}`, label: profile.label, group: t("pdfTemplate.profile.builtIn"), source: builtinProfileSource(profile.id) })),
    ...hostProfiles.map((profile) => ({ id: `host:${profile.id}`, label: profile.label, group: t("pdfTemplate.host"), source: profile.source }))
  ];
}

function text(id: string, propertyPath: string, label: string, extra: Partial<PropertyEditorField> = {}): PropertyEditorField {
  return { id, type: "text", propertyPath, label, ...extra };
}
function number(id: string, propertyPath: string, label: string, extra: Partial<PropertyEditorField> = {}): PropertyEditorField {
  return { id, type: "number", propertyPath, label, ...extra };
}
function boolean(id: string, propertyPath: string, label: string, extra: Partial<PropertyEditorField> = {}): PropertyEditorField {
  return { id, type: "boolean", propertyPath, label, ...extra };
}
function select(id: string, propertyPath: string, label: string, choices: PropertyEditorChoice[], extra: Partial<PropertyEditorField> = {}): PropertyEditorField {
  return { id, type: "select", propertyPath, label, choices, ...extra };
}
function localized(id: string, propertyPath: string, label: string, extra: Partial<PropertyEditorField> = {}): PropertyEditorField {
  return { id, type: "localized-text", propertyPath, label, ...extra };
}

function section(id: string, title: LocalizedText, fields: PropertyEditorField[]): { section: PropertyEditorSection; fields: PropertyEditorField[] } {
  return { section: { id, title, fieldIds: fields.map((field) => field.id) }, fields };
}

/** The fields a widget and an area share: what fills it, the checked value, the format. */
function mappingFields(options: PdfTemplateComponentDefinitionOptions): PropertyEditorField[] {
  const t = options.texts ?? englishPdfTemplateText;
  const components = (options.formComponents ?? []).filter((component) => !component.container);
  const componentChoices: PropertyEditorChoice[] = [
    { value: "", label: t("pdfTemplate.choose") },
    ...components.map((component) => ({ value: component.id, label: `${component.label} (${component.id})` }))
  ];
  return [
    select("source-kind", "source.kind", t("pdfTemplate.source.kind"), sourceKindChoices(t), {
      defaultValue: "",
      description: t("pdfTemplate.source.kind.description")
    }),
    select("source-component", "source.componentId", t("pdfTemplate.source.component"), componentChoices, { description: t("pdfTemplate.source.component.description") }),
    localized("source-text", "source.text", t("pdfTemplate.source.text"), { description: t("pdfTemplate.source.text.description") }),
    text("source-value", "source.value", t("pdfTemplate.source.literal"), { description: t("pdfTemplate.source.literal.description") }),
    {
      id: "source-path",
      type: "path",
      propertyPath: "source.path",
      label: t("pdfTemplate.source.path"),
      description: t("pdfTemplate.source.path.description"),
      visibleWhen: { propertyPath: "source.kind", equals: "path" }
    },
    {
      id: "source-expression",
      type: "formula",
      propertyPath: "source.expression",
      label: t("pdfTemplate.source.expression"),
      description: t("pdfTemplate.source.expression.description"),
      visibleWhen: { propertyPath: "source.kind", equals: "expression" }
    },
    text("checkedValue", "checkedValue", t("pdfTemplate.checkedWhen"), {
      description: t("pdfTemplate.checkedWhen.description")
    }),
    select("format-kind", "format.kind", t("pdfTemplate.format"), formatKindChoices(t), { defaultValue: "" }),
    text("format-pattern", "format.pattern", t("pdfTemplate.format.pattern"), { description: t("pdfTemplate.format.pattern.description") })
  ];
}

function templateRootDefinition(options: PdfTemplateComponentDefinitionOptions): ComponentDefinition {
  const t = options.texts ?? englishPdfTemplateText;
  const hostChoices: PropertyEditorAssetChoice[] = (options.hostTemplates ?? []).map((option) => ({
    id: `host:${option.id}`,
    label: option.label,
    group: t("pdfTemplate.host"),
    source: option.source
  }));
  const appearanceChoices: PropertyEditorChoice[] = [
    { value: "", label: t("pdfTemplate.appearances.regenerate") },
    { value: "viewer", label: t("pdfTemplate.appearances.viewer") }
  ];
  const signatureChoices: PropertyEditorChoice[] = [
    { value: "", label: t("pdfTemplate.signature.none") },
    ...(options.signatureFields ?? []).map((name) => ({ value: name, label: name }))
  ];
  const template = section("template", t("pdfTemplate.section.template"), [
    localized("name", "name", t("pdfTemplate.name")),
    {
      id: "template",
      type: "file",
      propertyPath: "template",
      label: t("pdfTemplate.file"),
      description: t("pdfTemplate.file.description"),
      accept: PDF_TEMPLATE_ACCEPT,
      ...(hostChoices.length > 0 ? { assetChoices: hostChoices } : {})
    }
  ]);
  const fill = section("fill", t("pdfTemplate.section.fill"), [
    boolean("flatten", "options.flatten", t("pdfTemplate.flatten"), { description: t("pdfTemplate.flatten.description") }),
    boolean("readOnly", "options.readOnly", t("pdfTemplate.readOnly"), { description: t("pdfTemplate.readOnly.description") }),
    select("appearances", "options.appearances", t("pdfTemplate.appearances"), appearanceChoices, { defaultValue: "" })
  ]);
  const archival = section("archival", t("pdfTemplate.section.archival"), [
    select("pdfa", "conformance.pdfa", t("pdfTemplate.pdfa"), pdfAChoices(t), {
      defaultValue: "",
      description: t("pdfTemplate.pdfa.description")
    }),
    {
      id: "output-intent-profile",
      type: "file",
      propertyPath: "conformance.outputIntent.profile",
      label: t("pdfTemplate.outputIntent"),
      accept: PDF_ICC_ACCEPT,
      assetChoices: outputIntentChoices(options.outputIntentProfiles ?? [], t),
      description: t("pdfTemplate.outputIntent.description")
    },
    boolean("attach-data", "conformance.attachData", t("pdfTemplate.attachData"), {
      description: t("pdfTemplate.attachData.description")
    }),
    text("attachment-name", "conformance.attachment.name", t("pdfTemplate.attachment.name"), {
      description: t("pdfTemplate.attachment.name.description", { name: DEFAULT_PDF_ATTACHMENT_NAME })
    }),
    localized("attachment-description", "conformance.attachment.description", t("pdfTemplate.attachment.description"))
  ]);
  const signature = section("signature", t("pdfTemplate.section.signature"), [
    options.signatureFields && options.signatureFields.length > 0
      ? select("signature-field", "signature.field", t("pdfTemplate.signature.field"), signatureChoices, {
          defaultValue: "",
          description: t("pdfTemplate.signature.field.description")
        })
      : text("signature-field", "signature.field", t("pdfTemplate.signature.field"), {
          description: t("pdfTemplate.signature.field.typed.description")
        }),
    boolean("signature-required", "signature.required", t("pdfTemplate.signature.required"), {
      description: t("pdfTemplate.signature.required.description")
    }),
    localized("signature-reason", "signature.reason", t("pdfTemplate.signature.reason"))
  ]);
  const groups = [template, fill, archival, signature];
  return {
    type: PDF_TEMPLATE_COMPONENT_TYPE,
    version: "1.0.0",
    createDefault: () => ({
      id: "template",
      type: PDF_TEMPLATE_COMPONENT_TYPE,
      configuration: {},
      children: { [PDF_TEMPLATE_WIDGETS_SLOT]: [], [PDF_TEMPLATE_AREAS_SLOT]: [] }
    }),
    capabilities: [],
    children: {
      slots: [
        // The PDF's own fields: nothing is added by hand (the palette lists no widget type).
        { id: PDF_TEMPLATE_WIDGETS_SLOT, multiple: true, allowedTypes: [PDF_WIDGET_COMPONENT_TYPE], allowReorder: false },
        { id: PDF_TEMPLATE_AREAS_SLOT, multiple: true, allowedTypes: [PDF_AREA_COMPONENT_TYPE] }
      ]
    },
    propertyEditor: {
      mode: "replace",
      fields: groups.flatMap((group) => group.fields),
      sections: groups.map((group) => group.section)
    }
  };
}

/** `equals` no source id can hold: the Values field is declared but never shown. */
const VALUES_HIDDEN = "\u0000";

/**
 * The Values field of a widget. Its rows and targets depend on the widget being
 * edited — the component it is filled from, the PDF field's options — so a capability adds it
 * per node: drawn only for a field with options filled from a component with answers to
 * translate, and declared, hidden, otherwise. Declared either way so the panel repaints when
 * the source component changes (`visibleWhen` names `source.componentId`).
 */
function valuesCapability(options: PdfTemplateComponentDefinitionOptions): CapabilityDefinition {
  const t = options.texts ?? englishPdfTemplateText;
  return {
    id: "pdf-widget-values",
    version: "1.0.0",
    apply: (component) => component,
    configureEditor: ({ component }) => {
      const config = (component.configuration ?? {}) as Record<string, unknown>;
      const source = (config.source ?? {}) as Record<string, unknown>;
      const spec = source.kind === "component" ? options.valueMapFor?.(component) : undefined;
      const field: PropertyEditorField = {
        id: "values",
        type: "value-map",
        propertyPath: "values",
        label: t("pdfTemplate.values"),
        description: t("pdfTemplate.values.description"),
        visibleWhen: { propertyPath: "source.componentId", equals: spec && typeof source.componentId === "string" ? source.componentId : VALUES_HIDDEN },
        ...(spec ? { valueMap: spec } : {})
      };
      return { fields: [field] };
    }
  };
}

function widgetDefinition(options: PdfTemplateComponentDefinitionOptions): ComponentDefinition {
  const t = options.texts ?? englishPdfTemplateText;
  const mapping = section("mapping", t("pdfTemplate.section.mapping"), mappingFields(options));
  // The Values section holds the capability's field; it is declared here so it follows Mapping.
  const values: PropertyEditorSection = { id: "values", title: t("pdfTemplate.section.values"), fieldIds: ["values"], hideWhenEmpty: true };
  return {
    type: PDF_WIDGET_COMPONENT_TYPE,
    version: "1.0.0",
    fixed: true,
    createDefault: () => ({ id: "widget", type: PDF_WIDGET_COMPONENT_TYPE, configuration: { pdfField: "", label: "" } }),
    capabilities: [valuesCapability(options)],
    propertyEditor: { mode: "extend", fields: mapping.fields, sections: [mapping.section, values] }
  };
}

function areaDefinition(options: PdfTemplateComponentDefinitionOptions): ComponentDefinition {
  const t = options.texts ?? englishPdfTemplateText;
  const area = section("area", t("pdfTemplate.area"), [
    text("label", "label", t("pdfTemplate.area.label"), { description: t("pdfTemplate.area.label.description") }),
    number("page", "page", t("pdfTemplate.area.page"), { min: 1, step: 1, defaultValue: 1 }),
    number("rect-x", "rect.x", t("pdfTemplate.area.x"), { min: 0, step: 0.5 }),
    number("rect-y", "rect.y", t("pdfTemplate.area.y"), { min: 0, step: 0.5, description: t("pdfTemplate.area.y.description") }),
    number("rect-width", "rect.width", t("pdfTemplate.area.width"), { min: 4, step: 0.5 }),
    number("rect-height", "rect.height", t("pdfTemplate.area.height"), { min: 4, step: 0.5 })
  ]);
  const mapping = section("mapping", t("pdfTemplate.section.mapping"), mappingFields(options));
  const drawing = section("drawing", t("pdfTemplate.section.drawing"), [
    select("draw-kind", "draw.kind", t("pdfTemplate.draw.kind"), drawKindChoices(t), { defaultValue: DEFAULT_PDF_AREA_DRAW.kind }),
    number("draw-fontSize", "draw.fontSize", t("pdfTemplate.draw.fontSize"), { min: 1, step: 0.5, defaultValue: DEFAULT_PDF_AREA_DRAW.fontSize }),
    select("draw-align", "draw.align", t("pdfTemplate.draw.align"), alignChoices(t), { defaultValue: DEFAULT_PDF_AREA_DRAW.align }),
    select("draw-valign", "draw.valign", t("pdfTemplate.draw.valign"), valignChoices(t), { defaultValue: DEFAULT_PDF_AREA_DRAW.valign }),
    number("draw-padding", "draw.padding", t("pdfTemplate.draw.padding"), { min: 0, step: 0.5, defaultValue: DEFAULT_PDF_AREA_DRAW.padding }),
    boolean("draw-wrap", "draw.wrap", t("pdfTemplate.draw.wrap"), { defaultValue: DEFAULT_PDF_AREA_DRAW.wrap }),
    boolean("draw-bold", "draw.bold", t("pdfTemplate.draw.bold"), { defaultValue: DEFAULT_PDF_AREA_DRAW.bold }),
    text("draw-color", "draw.color", t("pdfTemplate.draw.color"), { description: t("pdfTemplate.draw.color.description") })
  ]);
  const field = section("field", t("pdfTemplate.section.field"), [
    boolean("field-enabled", "field.enabled", t("pdfTemplate.field.enabled"), {
      description: t("pdfTemplate.field.enabled.description")
    }),
    text("field-name", "field.name", t("pdfTemplate.field.name"), { description: t("pdfTemplate.field.name.description") }),
    boolean("field-required", "field.required", t("pdfTemplate.field.required")),
    boolean("field-readOnly", "field.readOnly", t("pdfTemplate.field.readOnly")),
    text("field-tooltip", "field.tooltip", t("pdfTemplate.field.tooltip"), { description: t("pdfTemplate.field.tooltip.description") })
  ]);
  const groups = [area, mapping, drawing, field];
  return {
    type: PDF_AREA_COMPONENT_TYPE,
    version: "1.0.0",
    createDefault: () => ({
      id: "area",
      type: PDF_AREA_COMPONENT_TYPE,
      // A fresh area near the top of the first page; the author drags it where it goes.
      configuration: { page: 1, rect: { x: 72, y: 72, width: 144, height: 18 }, source: { kind: "" } }
    }),
    capabilities: [],
    propertyEditor: {
      mode: "replace",
      fields: groups.flatMap((group) => group.fields),
      sections: groups.map((group) => group.section)
    }
  };
}

/** The three definitions a template layout's tree is edited with. */
export function pdfTemplateComponentDefinitions(options: PdfTemplateComponentDefinitionOptions = {}): ComponentDefinition[] {
  return [templateRootDefinition(options), widgetDefinition(options), areaDefinition(options)];
}

/** A fresh template root with no widgets or areas. */
export function createEmptyPdfTemplateRoot(id = "template"): ComponentNode {
  const root = templateRootDefinition({}).createDefault();
  return { ...root, id };
}
