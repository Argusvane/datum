/**
 * Datum's file field: a native file picker, the list of what the field holds, and the status
 * line a removal is said in.
 *
 * - The picker and the list are the control together. The adapter reads the picked files into an
 *   array, hands them to `on.files` and clears the input (so picking the same file again is
 *   heard); where they are stored, and what is announced, is the renderer's files module.
 * - Each stored attachment is a row: its name (a button that hands the bytes back as a download
 *   when they are embedded, `FileItem.downloadable`; plain text otherwise), its size, and a Remove
 *   button that names the file for assistive technology. A read-only field shows the list alone
 *   (a review is not the place to pick a file), or the "none" line; a disabled one takes no pick
 *   and offers no removal.
 * - The polite status region (`data-file-status`) is where a pick and a removal are announced.
 *   It carries `data-file-announce`: the input is cleared after each pick, so the browser's own
 *   control no longer names the file, and the new row appearing in the list is silent.
 * - Drag and drop is the wrapper's; the stylesheet draws `data-file-drag`.
 *
 * Capabilities: notices, the help mark and a hidden label are drawn; a running check is a word
 * folded into the hint by the renderer.
 */
import { formatFileSize } from "../../../core/schema/file-upload.js";
import type { FieldAdapter, FileFieldState, FileItem } from "../contract.js";
import { html, ifDefined, nothing, type TemplateResult } from "../lit.js";
import {
  ariaStates,
  assembleParts,
  controlClassNames,
  describedByAttr,
  descriptionView,
  errorView,
  fieldClassNames,
  marksView,
  resolveFieldOptions,
  tooltipMark,
  tooltipTextOf,
  type DatumFieldOptions,
  type DatumFieldOptionsInput
} from "./field-scaffold.js";

/** The state of a file field with what the files module adds read back from the model when it did not. */
function figuresOf(state: FileFieldState): { files: readonly FileItem[]; multiple: boolean; accept: string | undefined } {
  const file = state.model.file;
  return {
    files: state.files ?? [],
    multiple: state.multiple ?? file?.multiple ?? false,
    accept: state.accept ?? (file !== undefined && file.accept.length > 0 ? file.accept.join(",") : undefined)
  };
}

/** The label: a `<label for>` of the picker, or a plain span when a read-only field has no picker. */
function labelOf(state: FileFieldState, options: DatumFieldOptions, picker: boolean): TemplateResult {
  const words = html`${state.label}${marksView(state, options.controls.ariaStates !== "marked", options.parts)}`;
  const tip = tooltipTextOf(state);
  const className = state.hideLabel ? "datum-form__label datum-form__visually-hidden" : "datum-form__label";
  // The help mark is a focusable button named "Help": the label's name stays the words alone.
  const content = tip === undefined ? words : html`<span id=${state.labelId}>${words}</span>${tooltipMark(state, tip, options.parts)}`;
  const id = tip === undefined ? state.labelId : undefined;
  return picker
    ? html`<label id=${ifDefined(id)} class=${className} for=${state.id}>${content}</label>`
    : html`<span id=${ifDefined(id)} class=${className}>${content}</span>`;
}

/** Datum's file field, drawn with the host's field options (the order of the parts, the ARIA choices). */
export function createDatumFileAdapter(input?: DatumFieldOptionsInput): FieldAdapter<FileFieldState> {
  const options = resolveFieldOptions(input);
  return {
    kind: "field",
    name: "datum file",
    capabilities: { notice: "drawn", workedOut: "drawn", tooltip: "drawn", hideLabel: "drawn", pending: "degraded" },
    template(state, on) {
      const { files, multiple, accept } = figuresOf(state);
      const locked = state.disabled || state.readOnly;
      const rows = files.map((item) => {
        const name = item.downloadable
          ? html`<button type="button" class="datum-form__file-name" title=${state.words("fileDownload", { name: item.name })} @click=${() => on.download?.(item.id)}>${item.name}</button>`
          : html`<span class="datum-form__file-name">${item.name}</span>`;
        const size = item.size !== undefined ? html` <span class="datum-form__file-size">${formatFileSize(item.size)}</span>` : nothing;
        const remove = locked
          ? nothing
          : html` <button type="button" class="datum-form__file-remove" aria-label=${state.words("fileRemoveFile", { name: item.name })} @click=${() => on.remove?.(item.id)}>${state.words("fileRemove")}</button>`;
        return html`<li class="datum-form__file-item">${name}${size}${remove}</li>`;
      });
      const list =
        rows.length > 0
          ? html`<ul class="datum-form__file-list">${rows}</ul>`
          : state.readOnly
            ? html`<span class="datum-form__file-empty">${state.words("fileNone")}</span>`
            : nothing;
      const aria = ariaStates(state, options);
      const picker = state.readOnly
        ? nothing
        : html`<input
              id=${state.id}
              class=${controlClassNames("file")}
              type="file"
              accept=${ifDefined(accept)}
              ?multiple=${multiple}
              ?disabled=${state.disabled}
              aria-labelledby=${ifDefined(tooltipTextOf(state) !== undefined ? state.labelId : undefined)}
              aria-invalid=${ifDefined(aria.invalid)}
              aria-required=${ifDefined(aria.required)}
              aria-describedby=${ifDefined(describedByAttr(state.describedBy))}
              @change=${(event: Event) => {
                const control = event.currentTarget as HTMLInputElement;
                const picked = Array.from(control.files ?? []);
                // Cleared so picking the same file again is heard.
                control.value = "";
                on.files?.(picked);
              }}
            /><span class="datum-form__file-status datum-form__visually-hidden" role="status" aria-live="polite" data-file-status data-file-announce></span>`;
      return html`<div class=${fieldClassNames(state, "file", "datum-form__field datum-form__file")}>${assembleParts(
        {
          label: labelOf(state, options, !state.readOnly),
          description: descriptionView(state),
          control: html`${picker}${list}`,
          error: errorView(state, options)
        },
        options.fieldOrder,
        state
      )}</div>`;
    }
  };
}

/** Datum's file field with the default options. */
export const datumFile: FieldAdapter<FileFieldState> = createDatumFileAdapter();
