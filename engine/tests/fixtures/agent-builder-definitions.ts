/**
 * The component types the builder catalogue's tests run over. The engine cannot import the packages/datum standard set, so this declares the
 * types the tools meet, the way the standard set and `builder-move-to.test.ts` do: slots,
 * palette entries, `createDefault` and the field capabilities (so the inspector, Required and
 * Data key answer as they do on a real page).
 *
 * The data grid is `dataGrid` (DATA_GRID_COMPONENT_TYPE), the engine's id; the tools' prose
 * says "data-grid".
 *
 * The rest of the `contact-request` fixture's
 * world is here: its languages (`en` + `fr-CA`), its data source (`provinces`), one journey `intake`
 * ("Intake", the default, `opensAs: "journey"`), a generated PDF layout `summary` (the default)
 * and a template layout `cra-t2125`, and the one fillable PDF the site offers as a template.
 */
import type { BuilderComponentType } from "../../form-engine/builder/controller/builder-controller.js";
import type { ComponentDefinition } from "../../form-engine/core/schema/contracts.js";
import type { SlotDefinition } from "../../form-engine/core/schema/types.js";
import { DATA_GRID_COMPONENT_TYPE } from "../../form-engine/core/schema/data-grid.js";
import type { JourneyConfiguration } from "../../form-engine/core/schema/journey.js";
import type { LocalizationConfiguration } from "../../form-engine/core/schema/types.js";
import type { PdfConfiguration, PdfTemplateSource } from "../../form-engine/core/schema/pdf-layout.js";
import { createDataSourceCapability } from "../../form-engine/core/schema/data-source-capability.js";
import { createInlineOptionsCapability } from "../../form-engine/core/schema/inline-options.js";
import { descriptionCapability, labelCapability, standardFieldCapabilities } from "../../form-engine/registry/capabilities/field-capabilities.js";

type Capabilities = ComponentDefinition["capabilities"];

const leaf = (type: string, label: string, capabilities: Capabilities, configuration: Record<string, unknown> = { label }): ComponentDefinition => ({
  type,
  version: "1.0.0",
  createDefault: () => ({ id: type, type, configuration: structuredClone(configuration) }),
  capabilities
});

const container = (
  type: string,
  slots: SlotDefinition[],
  configuration: Record<string, unknown>,
  children: Record<string, never[]> = Object.fromEntries(slots.map((slot) => [slot.id, []])),
  capabilities: Capabilities = [labelCapability, descriptionCapability]
): ComponentDefinition => ({
  type,
  version: "1.0.0",
  createDefault: () => ({ id: type, type, configuration: structuredClone(configuration), children: structuredClone(children) }),
  capabilities,
  children: { slots }
});

const choice = (type: string, label: string): ComponentDefinition =>
  leaf(type, label, [...standardFieldCapabilities(), createInlineOptionsCapability(), createDataSourceCapability()], {
    label,
    options: [
      { value: "option_1", label: "Option 1" },
      { value: "option_2", label: "Option 2" }
    ]
  });

/** The leaf types a data grid takes as columns. */
export const DATA_GRID_COLUMNS = ["text", "number", "select", "date", "checkbox"];

export const AGENT_BUILDER_DEFINITIONS: ComponentDefinition[] = [
  container("form", [{ id: "content", multiple: true }], {}, { content: [] }, []),
  container("fieldset", [{ id: "content", multiple: true }], { label: "Group" }),
  container("panel", [{ id: "content", multiple: true }], { label: "Panel" }),
  container("steps", [{ id: "content", multiple: true, allowedTypes: ["step"] }], { label: "Steps" }),
  container("step", [{ id: "content", multiple: true }], { label: "Step" }),
  // Slots from configuration.tabs: the definition declares none (configuredSlotIds).
  {
    ...container("tabs", [], {
      label: "Tabs",
      tabs: [
        { id: "tab_1", label: "Tab 1" },
        { id: "tab_2", label: "Tab 2" }
      ]
    }),
    createDefault: () => ({
      id: "tabs",
      type: "tabs",
      configuration: { label: "Tabs", tabs: [{ id: "tab_1", label: "Tab 1" }, { id: "tab_2", label: "Tab 2" }] },
      children: { tab_1: [], tab_2: [] }
    })
  },
  // Columns from configuration.columns: column_1..column_N (gridColumnSlotIds).
  {
    ...container("grid", [], { columns: 2 }),
    createDefault: () => ({ id: "grid", type: "grid", configuration: { columns: 2 }, children: { column_1: [], column_2: [] } })
  },
  {
    ...container(DATA_GRID_COMPONENT_TYPE, [{ id: "content", multiple: true, allowedTypes: DATA_GRID_COLUMNS }], { label: "Table" }),
    createDefault: () => ({
      id: DATA_GRID_COMPONENT_TYPE,
      type: DATA_GRID_COMPONENT_TYPE,
      configuration: { label: "Table" },
      collection: {},
      children: { content: [] }
    })
  },
  container("button-group", [{ id: "content", multiple: true, allowedTypes: ["button"] }], {}),
  leaf("text", "Text", standardFieldCapabilities({ pattern: true, length: true })),
  leaf("number", "Number", standardFieldCapabilities({ affix: true })),
  choice("select", "Select"),
  choice("radio", "Radio"),
  leaf("checkbox", "Checkbox", standardFieldCapabilities({ placeholder: false })),
  choice("checkboxes", "Checkboxes"),
  leaf("textarea", "Long answer", standardFieldCapabilities({ rows: true })),
  leaf("date", "Date", standardFieldCapabilities()),
  leaf("button", "Button", standardFieldCapabilities({ required: false, placeholder: false }), { label: "Button", action: "button" })
];

/** The palette the person sees, grouped (step and form are not on it). */
export const AGENT_BUILDER_PALETTE: BuilderComponentType[] = [
  { type: "text", label: "Short answer", group: "Fields" },
  { type: "number", label: "Number", group: "Fields" },
  { type: "textarea", label: "Long answer", group: "Fields" },
  { type: "date", label: "Date", group: "Fields" },
  { type: "select", label: "Dropdown", group: "Choices" },
  { type: "radio", label: "Radio buttons", group: "Choices" },
  { type: "checkbox", label: "Checkbox", group: "Choices" },
  { type: "checkboxes", label: "Checkboxes", group: "Choices" },
  { type: "fieldset", label: "Group", group: "Layout" },
  { type: "panel", label: "Panel", group: "Layout" },
  { type: "tabs", label: "Tabs", group: "Layout" },
  { type: "steps", label: "Steps", group: "Layout" },
  { type: "grid", label: "Grid", group: "Layout" },
  { type: DATA_GRID_COMPONENT_TYPE, label: "Table", group: "Layout" },
  { type: "button", label: "Button", group: "Actions" },
  { type: "button-group", label: "Button group", group: "Actions" }
];

/** The fixture's languages. */
export const AGENT_BUILDER_LOCALES: LocalizationConfiguration = {
  defaultLocale: "en",
  supportedLocales: [
    { code: "en", label: "English" },
    { code: "fr-CA", label: "Français (Canada)" }
  ]
};

/** The host's data source ids. */
export const AGENT_BUILDER_DATA_SOURCE_IDS: readonly string[] = ["provinces"];

/** One journey, `intake`: the default, and the form opens as it. */
export const AGENT_BUILDER_JOURNEYS: JourneyConfiguration = {
  journeys: [
    {
      id: "intake",
      name: "Intake",
      pages: [
        { id: "contact", title: "Contact", components: ["full_name", "email"] },
        { id: "request", title: "Request", components: ["topic", "details"] }
      ]
    }
  ],
  defaultJourneyId: "intake",
  opensAs: "journey"
};

/** A fillable PDF as a template layout's source (no bytes: the fakes never read it). */
export const CRA_T2125_SOURCE: PdfTemplateSource = { storage: "host", name: "t2125-fill-25e.pdf", type: "application/pdf", size: 412_000 };

/** Two layouts: the generated `summary` (the default) and the template `cra-t2125`. */
export const AGENT_BUILDER_PDF: PdfConfiguration = {
  layouts: [
    { id: "summary", kind: "generated", name: "Summary", root: { id: "root", type: "pdf-document", configuration: {}, children: { content: [] } } },
    { id: "cra-t2125", kind: "template", name: "CRA T2125", template: CRA_T2125_SOURCE, fields: [] }
  ],
  defaultLayoutId: "summary"
};

/** The site's template list (`wrapper.pdfTemplates.list()`). */
export const AGENT_BUILDER_TEMPLATES: Array<{ templateId: string; label: string; source: PdfTemplateSource }> = [
  { templateId: "t2125-2026", label: "T2125 Statement of business activities (2026)", source: CRA_T2125_SOURCE }
];
