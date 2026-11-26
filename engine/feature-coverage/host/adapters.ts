/*
 * Adapters a scenario puts over Datum's by name (`LoadOptions.adapters`), for a renderer module
 * whose marks the Datum binding never draws: a design system's markup is what writes them, and
 * the module must still do its part whatever binding drew the control.
 *
 *   `media-label`  the `text` adapter: a box whose name follows the viewport (media-labels.ts):
 *                  `data-label-media="(min-width: 700px)"`, "Where you live (wide)" when it
 *                  matches, "Where you live (narrow)" otherwise.
 *   `fc-registered` the `text` adapter wrapped: Datum's own drawing inside a `data-drawn-by`
 *                  marker, answering `placeholder` as not drawn, so a form drawn by a binding
 *                  registered with it can be told from one Datum draws (the element settings).
 */
import type { FieldAdapter, TextFieldState } from "../../form-engine/render/live/contract.js";
import { html, live } from "../../form-engine/render/live/lit.js";
import type { DatumBindingOptions } from "../../form-engine/render/live/renderer.js";

/** The query the `media-label` box's name follows. */
export const MEDIA_LABEL_QUERY = "(min-width: 700px)";

const mediaLabelText: FieldAdapter<TextFieldState> = {
  kind: "field",
  name: "feature-coverage media-label text",
  template: (s, on) => html`<label id=${s.labelId} for=${s.id}>${s.label}</label
    ><input
      id=${s.id}
      type="text"
      .value=${live(s.value)}
      data-label-media=${MEDIA_LABEL_QUERY}
      data-label-matches=${`${s.label} (wide)`}
      data-label-otherwise=${`${s.label} (narrow)`}
      @input=${(event: Event) => on.input((event.target as HTMLInputElement).value, { interim: true })}
      @change=${() => on.commit()}
    />`
};

/** Datum's `text` adapter inside a marker, with its `placeholder` answer taken back: a registered binding's text. */
const registeredText = (base: unknown): FieldAdapter => {
  const datum = base as FieldAdapter<TextFieldState>;
  return {
    ...datum,
    name: "feature-coverage registered text",
    capabilities: { ...datum.capabilities, placeholder: "none" },
    template: (s, on) => html`<div data-drawn-by="fc-registered">${datum.template(s, on)}</div>`
  } as FieldAdapter;
};

const ADAPTERS: Readonly<Record<string, NonNullable<DatumBindingOptions["renderers"]>>> = {
  "media-label": { text: mediaLabelText as FieldAdapter },
  "fc-registered": { text: registeredText }
};

/** The renderer overrides the named adapters make, merged; an unknown name throws. */
export function adapterOverrides(names: readonly string[] | undefined): DatumBindingOptions["renderers"] {
  if (!names || names.length === 0) return undefined;
  const out: Record<string, NonNullable<DatumBindingOptions["renderers"]>[string]> = {};
  for (const name of names) {
    const set = ADAPTERS[name];
    if (!set) throw new Error(`Unknown adapter set "${name}"; known: ${Object.keys(ADAPTERS).join(", ")}`);
    Object.assign(out, set);
  }
  return out;
}
