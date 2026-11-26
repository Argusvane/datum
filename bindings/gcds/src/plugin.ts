/**
 * The GC Design System FormPlugin: the component types only this design system has,
 * each drawn with the real `gcds-*` element. Registered beside the binding by a host that draws
 * with it (`plugins.register(gcdsPlugin)`). The builder lists the types only while the GCDS
 * binding draws the canvas (`palette.binding`); the types draw under any binding, but the elements
 * exist only on a page that loads the design system's components.
 *
 * - `gcds-date`: tier 2, base `date`. The official `<gcds-date-input>` where its behaviour fits;
 *   the definition carries `base: "date"`, so the builder writes `kinds: { "gcds-date": "date" }`
 *   into a saved form and validation, the sandbox and the PDF read it as a date without this code.
 * - `gcds-header`, `gcds-card`, `gcds-link`, `gcds-details`, `gcds-notice`, `gcds-icon`: content
 *   that holds no answer (a base is for answers), so none is declared.
 *
 * The adapters are factories `(lit, datum) => adapter`: the host passes the renderer's one lit and
 * Datum's binding, so this file imports neither (type imports only). A configuration text an
 * author words in the form's language (a card's title) is read with `state.text(property)`, which
 * layers the form's translations and the host catalog; other settings (a link's
 * address, a notice's role) are read from the configuration as they are.
 */
import type { CapabilityDefinition, ComponentDefinition, FormPlugin, PropertyEditorField } from "../../../engine/form-engine/core/schema/contracts.js";
import type { ComponentNode } from "../../../engine/form-engine/core/schema/types.js";
import type { FieldAdapter, FieldState } from "../../../engine/form-engine/render/live/contract.js";
import { createDate, GCDS_DATE_TYPE } from "./date.js";
import { isSafeAddress, languageOf, readyOf, type Lit } from "./shared.js";

export const GCDS_PLUGIN_ID = "gcds-components";

/** The palette heading the package's types are listed under. */
const GROUP = "GC Design System";

/** The binding the types belong to: the builder offers them only while it draws the canvas. */
const BINDING = "gcds";

/** Writes a capability's configuration onto a component: every one of these is a plain configuration key. */
function merge(component: ComponentNode, configuration: unknown): ComponentNode {
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) {
    return component;
  }
  const base = component.configuration && typeof component.configuration === "object" && !Array.isArray(component.configuration) ? (component.configuration as Record<string, unknown>) : {};
  return { ...component, configuration: { ...base, ...(configuration as Record<string, unknown>) } };
}

const property = (id: string, field: Omit<PropertyEditorField, "id" | "propertyPath"> & { propertyPath?: string }): CapabilityDefinition => ({
  id,
  version: "1.0.0",
  configureEditor: () => ({ fields: [{ id, propertyPath: id, ...field }] }),
  apply: merge
});

const text = (id: string, label: string, description?: string): CapabilityDefinition => property(id, { type: "text", label, ...(description !== undefined ? { description } : {}) });
const words = (id: string, label: string, description?: string): CapabilityDefinition => property(id, { type: "localized-text", label, ...(description !== undefined ? { description } : {}) });
const flag = (id: string, label: string, description?: string): CapabilityDefinition => property(id, { type: "boolean", label, ...(description !== undefined ? { description } : {}) });
const choice = (id: string, label: string, choices: ReadonlyArray<readonly [string, string]>, defaultValue: string): CapabilityDefinition =>
  property(id, { type: "select", label, defaultValue, choices: choices.map(([value, name]) => ({ value, label: name })) });

/** The usual editor set for a value-bearing field. */
const fieldCapabilities = (): CapabilityDefinition[] => [
  words("label", "Label"),
  words("description", "Description"),
  words("tooltip", "Tooltip", "Shown with the description, as GC Design System has no hover help."),
  flag("required", "Required"),
  flag("disabled", "Disabled", "Always disabled. Use a rule's “Enabled when” for a conditional one."),
  text("dataKey", "Data key", "The name this answer is stored under in the submitted data. Blank uses the ID."),
  text("cssClass", "CSS classes", "Space-separated class names, added to this component's element.")
];

/** A component's configuration as a record. */
const configurationOf = (state: FieldState): Readonly<Record<string, unknown>> => {
  const configuration = state.model.node.configuration;
  return configuration !== null && typeof configuration === "object" && !Array.isArray(configuration) ? (configuration as Record<string, unknown>) : {};
};

const stringOf = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value : undefined);
/** An address from the configuration, or none when it is blank or one a browser would run (`javascript:`); the caller's default stands in. */
const addressOf = (value: unknown): string | undefined => {
  const address = stringOf(value);
  return address !== undefined && isSafeAddress(address) ? address : undefined;
};
const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => (typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback);

/** A content definition: no answer, no base, no editor beyond its own properties. */
const content = (type: string, label: string, icon: string, capabilities: CapabilityDefinition[], defaults: Record<string, unknown>, adapter: (lit: Lit) => FieldAdapter, id = type): ComponentDefinition => ({
  type,
  version: "1.0.0",
  createDefault: () => ({ id, type, configuration: { ...defaults } }),
  capabilities: [...capabilities, text("cssClass", "CSS classes", "Space-separated class names, added to this component's element.")],
  adapter: (lit: Lit) => adapter(lit),
  palette: { label, group: GROUP, icon, binding: BINDING }
});

const ICONS = ["arrow-down", "arrow-up", "arrow-up-down", "checkmark-circle", "chevron-down", "chevron-left", "chevron-right", "chevron-up", "close", "download", "email", "exclamation-circle", "external", "filter", "info-circle", "phone", "search", "sort", "tune", "warning-triangle"] as const;
const ROLES = ["info", "success", "warning", "danger"] as const;

const date: ComponentDefinition = {
  type: GCDS_DATE_TYPE,
  version: "1.0.0",
  base: "date",
  createDefault: () => ({ id: GCDS_DATE_TYPE, type: GCDS_DATE_TYPE, configuration: { label: "Date" } }),
  capabilities: fieldCapabilities(),
  adapter: (lit: Lit, datum: Parameters<typeof createDate>[1]) => createDate(lit, datum).gcdsDate,
  palette: { label: "GC date", group: GROUP, icon: "📅", binding: BINDING }
};

const header = content(
  "gcds-header",
  "GC header",
  "▭",
  [text("langHref", "Other-language page", "The address of this page in the other official language (the language toggle)."), text("skipToHref", "Skip link target", "The address the hidden skip link jumps to, usually #main-content."), flag("signatureHasLink", "Signature links to Canada.ca")],
  { langHref: "#", skipToHref: "#main-content", signatureHasLink: true },
  ({ html }): FieldAdapter => ({
    kind: "field",
    name: "gcds-header",
    template: (s) => {
      const settings = configurationOf(s);
      return html`<gcds-header lang=${languageOf(s.locale)} lang-href=${addressOf(settings.langHref) ?? "#"} skip-to-href=${addressOf(settings.skipToHref) ?? "#main-content"} ?signature-has-link=${settings.signatureHasLink !== false}></gcds-header>`;
    },
    ready: readyOf("gcds-header")
  })
);

const card = content(
  "gcds-card",
  "GC card",
  "▢",
  [words("title", "Title"), words("description", "Description"), words("badge", "Badge", "At most 20 characters."), text("href", "Link address"), choice("titleTag", "Heading level", [["h3", "h3"], ["h4", "h4"], ["h5", "h5"], ["h6", "h6"]], "h3")],
  { title: "Card title", description: "What the card is about.", href: "#" },
  ({ html, ifDefined }): FieldAdapter => ({
    kind: "field",
    name: "gcds-card",
    template: (s) => {
      const settings = configurationOf(s);
      return html`<gcds-card
        card-title=${s.text("title") ?? ""}
        card-title-tag=${oneOf(settings.titleTag, ["h3", "h4", "h5", "h6"], "h3")}
        href=${addressOf(settings.href) ?? "#"}
        description=${ifDefined(s.text("description"))}
        badge=${ifDefined(s.text("badge"))}
        lang=${languageOf(s.locale)}
      ></gcds-card>`;
    },
    ready: readyOf("gcds-card")
  })
);

const link = content(
  "gcds-link",
  "GC link",
  "🔗",
  [words("text", "Text"), text("href", "Address"), flag("external", "Opens another site"), choice("size", "Size", [["regular", "Regular"], ["small", "Small"], ["inherit", "Inherit"]], "regular"), choice("display", "Display", [["inline", "Inline"], ["block", "Block"]], "inline")],
  { text: "A link", href: "#" },
  ({ html }): FieldAdapter => ({
    kind: "field",
    name: "gcds-link",
    template: (s) => {
      const settings = configurationOf(s);
      return html`<gcds-link
        href=${addressOf(settings.href) ?? "#"}
        size=${oneOf(settings.size, ["regular", "small", "inherit"], "regular")}
        display=${oneOf(settings.display, ["inline", "block"], "inline")}
        ?external=${settings.external === true}
        lang=${languageOf(s.locale)}
        >${s.text("text") ?? addressOf(settings.href) ?? "#"}</gcds-link
      >`;
    },
    ready: readyOf("gcds-link")
  })
);

const details = content(
  "gcds-details",
  "GC details",
  "▾",
  [words("title", "Title"), words("body", "Content"), flag("open", "Open to start")],
  { title: "More information", body: "The text that opens and closes." },
  ({ html }): FieldAdapter => ({
    kind: "field",
    name: "gcds-details",
    template: (s) => html`<gcds-details details-title=${s.text("title") ?? ""} ?open=${configurationOf(s).open === true}><gcds-text>${s.text("body") ?? ""}</gcds-text></gcds-details>`,
    ready: readyOf("gcds-details")
  })
);

const notice = content(
  "gcds-notice",
  "GC notice",
  "ℹ",
  [choice("role", "Kind", ROLES.map((role) => [role, role] as const), "info"), words("title", "Title"), words("body", "Content"), choice("titleTag", "Heading level", [["h2", "h2"], ["h3", "h3"], ["h4", "h4"], ["h5", "h5"]], "h2")],
  { role: "info", title: "Notice title", body: "What the person should know." },
  ({ html }): FieldAdapter => ({
    kind: "field",
    name: "gcds-notice",
    template: (s) => {
      const settings = configurationOf(s);
      return html`<gcds-notice
        notice-role=${oneOf(settings.role, ROLES, "info")}
        notice-title=${s.text("title") ?? ""}
        notice-title-tag=${oneOf(settings.titleTag, ["h2", "h3", "h4", "h5"], "h2")}
        lang=${languageOf(s.locale)}
        ><gcds-text margin-bottom="0">${s.text("body") ?? ""}</gcds-text></gcds-notice
      >`;
    },
    ready: readyOf("gcds-notice")
  })
);

const icon = content(
  "gcds-icon",
  "GC icon",
  "★",
  [choice("name", "Icon", ICONS.map((name) => [name, name] as const), "info-circle"), choice("size", "Size", [["inherit", "Inherit"], ["text-small", "Small text"], ["text", "Text"], ["h6", "h6"], ["h5", "h5"], ["h4", "h4"], ["h3", "h3"], ["h2", "h2"], ["h1", "h1"]], "text"), words("label", "Description", "Read out for the icon; blank leaves it decorative.")],
  { name: "info-circle", size: "text" },
  ({ html, ifDefined }): FieldAdapter => ({
    kind: "field",
    name: "gcds-icon",
    template: (s) => {
      const settings = configurationOf(s);
      return html`<gcds-icon name=${oneOf(settings.name, ICONS, "info-circle")} size=${oneOf(settings.size, ["inherit", "text-small", "text", "h6", "h5", "h4", "h3", "h2", "h1"], "text")} label=${ifDefined(s.text("label"))}></gcds-icon>`;
    },
    ready: readyOf("gcds-icon")
  })
);

export const gcdsPlugin: FormPlugin = {
  id: GCDS_PLUGIN_ID,
  version: "1.0.0",
  components: [date, header, card, link, details, notice, icon]
};
