import { resolveLocalizedText } from "../../../core/localization/localized-text.js";
import { SEAMLESS_FRAME_ID } from "../../../core/schema/form-chrome.js";
import type { LocalizedText } from "../../../core/schema/contracts.js";

/**
 * Form frames: the look drawn *around* the form — seamless in the page, an outlined
 * panel, paper hovering over the page. A frame is a preset id chosen through `chrome.frame` (the
 * author's in the definition, the host's as a default or fixed); what an id looks like is the
 * binding's business, the way every colour is. The Datum binding draws three built-ins from its
 * tokens (their rules live in its stylesheet); `createDatumBinding({ frame })` names more, or
 * restyles a built-in. A frame id nothing draws falls back to the seamless default.
 */

/** One frame: how a picker names it, and the rules that draw it. */
export interface FormFrameDefinition {
  label: LocalizedText;
  css?: string;
}

export const BUILTIN_FRAMES: Record<"seamless" | "outlined" | "paper", FormFrameDefinition> = {
  seamless: { label: { default: "Seamless (no frame)" } },
  outlined: { label: { default: "Outlined" } },
  paper: { label: { default: "Paper" } }
};

export const BUILTIN_FRAME_IDS: readonly string[] = Object.keys(BUILTIN_FRAMES);

/** The class the root carries for a frame; none for `seamless`, so an unframed form's markup is unchanged. */
export function frameClassName(id: string): string {
  return `datum-form--frame-${id}`;
}

export interface FrameOption {
  id: string;
  label: string;
}

/**
 * Whether `id` names a frame anyone draws: `seamless`, a built-in, or one of `own` (the frames a
 * binding adds, `DatumBinding.frames`). A definition may name a frame only a binding that is no
 * longer mounted drew; the form is then drawn in the default frame.
 */
export function isKnownFrame(id: string, ...own: ReadonlyArray<Readonly<Record<string, unknown>> | undefined>): boolean {
  return id === SEAMLESS_FRAME_ID || BUILTIN_FRAME_IDS.includes(id) || own.some((frames) => frames !== undefined && Object.hasOwn(frames, id));
}

/**
 * The frames a picker offers, labelled for `locale`: the built-ins in their order (a frame under
 * a built-in id relabels it in place), then `own` — the frames a binding adds.
 */
export function frameOptions(own: Readonly<Record<string, FormFrameDefinition>> | undefined, locale = "en"): FrameOption[] {
  const frames = own ?? {};
  const label = (id: string, definition: FormFrameDefinition): FrameOption => ({ id, label: resolveLocalizedText(definition.label, locale) ?? id });
  const builtins = BUILTIN_FRAME_IDS.map((id) => label(id, frames[id] ?? BUILTIN_FRAMES[id as keyof typeof BUILTIN_FRAMES]));
  const extra = Object.entries(frames)
    .filter(([id]) => !BUILTIN_FRAME_IDS.includes(id))
    .map(([id, definition]) => label(id, definition));
  return [...builtins, ...extra];
}
