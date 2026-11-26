import {
  cssClassCapability,
  isSafeUrl,
  resolveLocalizedText,
  type ComponentAdapterFactory,
  type ComponentDefinition,
  type FormPlugin,
  type LocalizedText
} from "@argusvane/datum-engine";

/**
 * A fixture component plugin for this package's own tests: what a component library package
 * hands the plugin registry, made up, so a test of the elements, the builder or the
 * registry has plugin types to draw, list and filter without depending on a real library.
 *
 * Three types, all in one palette group, each drawn by its definition's adapter and
 * each with its own css. The adapters are factories, `(lit) => adapter`, as a plugin
 * package built apart from the engine writes them: it draws with the renderer's lit, never its own.
 * - `acme-notice`: a container with a `content` slot and a `noticeTitle`;
 * - `acme-card`: a container with a `cardTitle` and an `href` on its title link;
 * - `acme-link`: a leaf with a `text` and an `href`.
 * Every href is held to the engine's own rule (`isSafeUrl`): a `javascript:` URL is drawn as "#".
 */

export const ACME_COMPONENTS_PLUGIN_ID = "datum-acme-components";
export const ACME_COMPONENTS_VERSION = "1.0.0";
export const ACME_PALETTE_GROUP = "Acme components";
export const ACME_NOTICE_TYPE = "acme-notice";
export const ACME_CARD_TYPE = "acme-card";
export const ACME_LINK_TYPE = "acme-link";

export const ACME_NOTICE_CSS = [
  ".acme-notice { border-left: 4px solid #0b3d91; padding: 8px 12px; }",
  ".acme-notice__title { margin: 0 0 4px; font-size: 1.125rem; }"
];
export const ACME_CARD_CSS = [".acme-card { border: 1px solid #ccc; padding: 12px; }"];
export const ACME_LINK_CSS = [".acme-link { text-decoration: underline; }"];

function config(model: { node: { configuration?: unknown } } | undefined): Record<string, unknown> {
  const value = model?.node.configuration;
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** A configuration text in the form's language: a plain string, or a localized one. */
function text(value: unknown, locale: string): string {
  return typeof value === "string" ? value : value && typeof value === "object" ? (resolveLocalizedText(value as LocalizedText, locale) ?? "") : "";
}

function safeHref(value: unknown): string {
  const href = typeof value === "string" ? value.trim() : "";
  return href !== "" && isSafeUrl(href) ? href : "#";
}

const noticeAdapter: ComponentAdapterFactory = ({ html }) => ({
  kind: "group",
  name: "acme-notice",
  template: (state, children) =>
    html`<section class="acme-notice"><h2 class="acme-notice__title">${text(config(state.model)["noticeTitle"], state.locale)}</h2><div class="acme-notice__body">${children}</div></section>`
});

const cardAdapter: ComponentAdapterFactory = ({ html }) => ({
  kind: "group",
  name: "acme-card",
  template: (state, children) => {
    const own = config(state.model);
    return html`<div class="acme-card"><a class="acme-card__title" href=${safeHref(own["href"])}>${text(own["cardTitle"], state.locale)}</a><div class="acme-card__body">${children}</div></div>`;
  }
});

const linkAdapter: ComponentAdapterFactory = ({ html }) => ({
  kind: "field",
  name: "acme-link",
  template: (state) => {
    const own = config(state.model);
    return html`<a class="acme-link" href=${safeHref(own["href"])}>${text(own["text"], state.locale)}</a>`;
  }
});

export const acmeNoticeDefinition: ComponentDefinition = {
  type: ACME_NOTICE_TYPE,
  version: ACME_COMPONENTS_VERSION,
  createDefault: () => ({ id: ACME_NOTICE_TYPE, type: ACME_NOTICE_TYPE, configuration: { noticeTitle: "Notice" }, children: { content: [] } }),
  capabilities: [cssClassCapability],
  palette: { label: "Notice", group: ACME_PALETTE_GROUP },
  css: ACME_NOTICE_CSS,
  children: { slots: [{ id: "content", multiple: true }] },
  adapter: noticeAdapter,
  propertyEditor: { mode: "extend", fields: [{ id: "noticeTitle", type: "localized-text", propertyPath: "noticeTitle", label: "Title" }] }
};

export const acmeCardDefinition: ComponentDefinition = {
  type: ACME_CARD_TYPE,
  version: ACME_COMPONENTS_VERSION,
  createDefault: () => ({ id: ACME_CARD_TYPE, type: ACME_CARD_TYPE, configuration: { cardTitle: "Card", href: "#" }, children: { content: [] } }),
  capabilities: [cssClassCapability],
  palette: { label: "Card", group: ACME_PALETTE_GROUP },
  css: ACME_CARD_CSS,
  children: { slots: [{ id: "content", multiple: true }] },
  adapter: cardAdapter,
  propertyEditor: {
    mode: "extend",
    fields: [
      { id: "cardTitle", type: "localized-text", propertyPath: "cardTitle", label: "Title" },
      { id: "href", type: "text", propertyPath: "href", label: "URL" }
    ]
  }
};

export const acmeLinkDefinition: ComponentDefinition = {
  type: ACME_LINK_TYPE,
  version: ACME_COMPONENTS_VERSION,
  createDefault: () => ({ id: ACME_LINK_TYPE, type: ACME_LINK_TYPE, configuration: { text: "Link", href: "#" } }),
  capabilities: [cssClassCapability],
  palette: { label: "Link", group: ACME_PALETTE_GROUP },
  css: ACME_LINK_CSS,
  adapter: linkAdapter,
  propertyEditor: {
    mode: "extend",
    fields: [
      { id: "text", type: "localized-text", propertyPath: "text", label: "Link text" },
      { id: "href", type: "text", propertyPath: "href", label: "URL" }
    ]
  }
};

export const acmeComponentsPlugin: FormPlugin = {
  id: ACME_COMPONENTS_PLUGIN_ID,
  version: ACME_COMPONENTS_VERSION,
  components: [acmeNoticeDefinition, acmeCardDefinition, acmeLinkDefinition]
};
