/**
 * The lines around the fields that belong to the host and the form's state: the host's receipt
 * after a delivered submission (`FormNotice`), the line that says a submission is in
 * flight, and the note explaining the required marker. A {@link LiveFeature} the host lists in
 * `features`.
 *
 * - Receipt: the host's notice (`notice()`, read at every draw) at the ends its `placement` names
 *   (the top by default). Listed at both ends, the top copy is the status region and the bottom
 *   one its echo, hidden from assistive technology so the receipt is read once. Its texts are the
 *   host's `LocalizedText`, resolved for the form's locale, so the receipt follows the language
 *   switcher. An error receipt is an alert on the draw that first shows that notice and a status
 *   on every later draw of it (a new alert node would be announced again each time).
 *   `focusNotice()` moves focus to the region, as the host does after a delivered submission.
 * - Status: drawn while the form is submitting, at the ends `submittingPlacement()` names.
 * - Required note: the `requiredNote` text, only when the form words it and a drawn field is
 *   required.
 *
 * The status and the receipt sit in the `summary-top` and `summary-bottom` regions, in `features`
 * order: list this feature before the summary to put the status above it. The required note sits
 * in `page-header`, under a journey page's heading when this feature is listed after the page's.
 *
 * While a submission is in flight the form element wears `datum-form--submitting` (the Datum
 * stylesheet dims what the person could act on; the chrome regions are `inert` already).
 *
 * Their look is the binding's (`notice`, `status`, `requiredNote`), else Datum's, else the
 * standard drawing in `datum/notice.ts`; a hook that throws falls back to it.
 */
import { resolveLocalizedText } from "../../core/localization/localized-text.js";
import type { FormTextKey } from "../../core/localization/form-texts.js";
import type { FormNotice, FormNoticeDetail, FormNoticeKind, FormNoticePlacement } from "../../core/submission/form-notice.js";
import type { LocalizedText } from "../../core/schema/contracts.js";
import { scalarText } from "../core/scalar-text.js";
import type { FormNoticeState, FormStatusState, RequiredNoteState, View } from "./contract.js";
import { datumNotice, datumRequiredNote, datumStatus } from "./datum/notice.js";
import { html, nothing } from "./lit.js";
import type { DrawContext, FormDecor, FormRegion, LiveContext, LiveFeature } from "./mount.js";

/** What the host gives the feature; each is read at every draw, so a later change shows on the next one. */
export interface FormNoticesOptions {
  /** The host's receipt, or nothing. */
  notice?: () => FormNotice | undefined;
  /** The ends the in-flight line goes at (`["top"]` when missing or empty). */
  submittingPlacement?: () => readonly FormNoticePlacement[] | undefined;
  /** The form's own heading level (its place in the page's outline); the receipt's title is one under it. 1 when left out. */
  headingLevel?: () => number;
}

/** A form-notices feature: the feature, and the move of focus to the receipt. */
export interface FormNoticesFeature extends LiveFeature {
  /** Focuses the receipt's region; `false` when none is drawn. */
  focusNotice(): boolean;
}

const KINDS: readonly FormNoticeKind[] = ["success", "info", "warning", "error"];

const KIND_WORDS: Readonly<Record<FormNoticeKind, FormTextKey>> = {
  success: "noticeSuccess",
  info: "noticeInfo",
  warning: "noticeWarning",
  error: "noticeError"
};

/** The ends a placement names: `["top"]` for none, repeats and unknown names dropped. */
function placesOf(placement: unknown): readonly FormNoticePlacement[] {
  const list = Array.isArray(placement) ? placement.filter((place): place is FormNoticePlacement => place === "top" || place === "bottom") : [];
  return list.length > 0 ? list : ["top"];
}

/** The receipt as a state for one end, or nothing when the notice does not go there. */
function noticeState(notice: FormNotice | undefined, position: FormNoticePlacement, fresh: boolean, draw: DrawContext, headingLevel: number): FormNoticeState | undefined {
  if (!notice || typeof notice !== "object") {
    return undefined;
  }
  // The notice is the host's, often a server response passed through: read it the way a part's
  // configuration is read, arrays as arrays and records as records, and draw what is usable.
  const places = placesOf(notice.placement);
  if (!places.includes(position)) {
    return undefined;
  }
  const locale = draw.form.locale;
  const text = (value: LocalizedText | undefined): string | undefined => {
    const resolved = value === null || value === undefined ? undefined : resolveLocalizedText(value, locale);
    return typeof resolved === "string" ? resolved : undefined;
  };
  const kind: FormNoticeKind = KINDS.includes(notice.kind as FormNoticeKind) ? (notice.kind as FormNoticeKind) : "success";
  const title = text(notice.title);
  const message = text(notice.message);
  const details = (Array.isArray(notice.details) ? notice.details : [])
    .filter((detail): detail is FormNoticeDetail => typeof detail === "object" && detail !== null && !Array.isArray(detail))
    .map((detail) => ({ label: text(detail.label) ?? "", value: scalarText(detail.value) }));
  // A notice that carries only its `data` (the receipt a printed form's header reads) draws nothing.
  if (!title && !message && details.length === 0) {
    return undefined;
  }
  const echo = position === "bottom" && places.includes("top");
  const kindKey = KIND_WORDS[kind];
  const word = draw.words(kindKey);
  return {
    kind,
    ...(title ? { title } : {}),
    ...(message ? { message } : {}),
    details,
    echo,
    assertive: kind === "error" && fresh,
    headingLevel,
    // A key nobody worded resolves to itself: say nothing.
    kindWord: word === kindKey ? "" : word.trimEnd(),
    words: draw.words
  };
}

/** What the binding's own hook drew; else Datum's drawing, tinted by the binding's `fallbackTokens` (`DrawContext.fallback`). */
function ownOrDatum(draw: DrawContext, own: boolean, drawn: View | undefined, datumView: () => View): View {
  return own && drawn !== undefined ? drawn : draw.fallback(drawn ?? datumView());
}

export function createFormNoticesFeature(options: FormNoticesOptions = {}): FormNoticesFeature {
  let context: LiveContext | undefined;
  /** The notice the last draw showed, to tell the draw that first shows one. */
  let shown: FormNotice | undefined;

  const notice = (draw: DrawContext, position: FormNoticePlacement, fresh: boolean): View => {
    const given = options.notice?.();
    const state = noticeState(given, position, fresh, draw, (options.headingLevel?.() ?? 1) + 1);
    if (state === undefined) {
      return nothing;
    }
    const { binding, datum } = draw.live;
    const custom = binding.notice ?? datum.notice;
    return ownOrDatum(draw, binding.notice !== undefined, custom ? draw.live.call("notice", undefined, () => custom.call(binding, state)) : undefined, () => datumNotice(state));
  };

  const status = (draw: DrawContext, position: FormNoticePlacement): View => {
    if (draw.form.busy !== "submitting") {
      return nothing;
    }
    const given = options.submittingPlacement?.();
    const places = placesOf(given);
    if (!places.includes(position)) {
      return nothing;
    }
    const state: FormStatusState = { message: draw.words("submitting"), echo: position === "bottom" && places.includes("top"), words: draw.words };
    const { binding, datum } = draw.live;
    const custom = binding.status ?? datum.status;
    return ownOrDatum(draw, binding.status !== undefined, custom ? draw.live.call("status", undefined, () => custom.call(binding, state)) : undefined, () => datumStatus(state));
  };

  const requiredNote = (draw: DrawContext): View => {
    const note = draw.words("requiredNote");
    if (note === "" || note === "requiredNote" || !draw.tree.fields.some((field) => field.model.visible && field.model.accessibility.required)) {
      return nothing;
    }
    const state: RequiredNoteState = { note, words: draw.words };
    const { binding, datum } = draw.live;
    const custom = binding.requiredNote ?? datum.requiredNote;
    return ownOrDatum(draw, binding.requiredNote !== undefined, custom ? draw.live.call("requiredNote", undefined, () => custom.call(binding, state)) : undefined, () => datumRequiredNote(state));
  };

  return {
    id: "form-notices",

    start(live: LiveContext) {
      context = live;
      return () => {
        context = undefined;
        shown = undefined;
      };
    },

    // The regions around the fields dim and stop taking input while a submission is in flight.
    formDecor(draw: DrawContext): FormDecor | undefined {
      return draw.form.busy === "submitting" ? { classes: ["datum-form--submitting"] } : undefined;
    },

    region(region: FormRegion, draw: DrawContext): View | undefined {
      if (region === "page-header") {
        return requiredNote(draw);
      }
      if (region !== "summary-top" && region !== "summary-bottom") {
        return undefined;
      }
      const position: FormNoticePlacement = region === "summary-top" ? "top" : "bottom";
      // A notice is fresh on the draw that first shows it: every end of that draw sees it so, and
      // the last end drawn (the bottom one when it goes there) records it as shown.
      const given = options.notice?.();
      const views = html`${status(draw, position)}${notice(draw, position, given !== shown)}`;
      if (position === (placesOf(given?.placement).includes("bottom") ? "bottom" : "top")) {
        shown = given;
      }
      return views;
    },

    focusNotice(): boolean {
      const live = context;
      const region = live?.root.querySelector<HTMLElement>(".datum-form__notice[tabindex]");
      return live !== undefined && region !== null && region !== undefined && live.focusElement(region);
    }
  };
}
