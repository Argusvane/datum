/**
 * Small drawing helpers the Datum adapters for buttons, files, signatures, content blocks,
 * chrome parts and the form-level lines share: a class list, a heading of a level, and the
 * reading of what a state does not carry from the engine's model.
 */
import type { FieldState, View } from "../contract.js";
import { html, nothing, type TemplateResult } from "../lit.js";

/** A class list from names, skipping empty ones. */
export function classes(...names: ReadonlyArray<string | false | undefined>): string {
  return names.filter((name): name is string => typeof name === "string" && name !== "").join(" ");
}

/** The heading level clamped to what HTML has. */
function clamp(level: number): 1 | 2 | 3 | 4 | 5 | 6 {
  return Math.min(6, Math.max(1, Math.round(Number.isFinite(level) ? level : 2))) as 1 | 2 | 3 | 4 | 5 | 6;
}

/**
 * A heading element of `level` (clamped to what HTML has: a form nested deep still gets a real
 * heading), with the class and, when given, the part marker the chrome finds it by and the id a
 * `aria-labelledby` or a focus move names.
 */
export function headingOf(level: number, className: string, content: View | string, part?: string, id?: string): TemplateResult {
  const marker = part ?? nothing;
  const identity = id ?? nothing;
  switch (clamp(level)) {
    case 1:
      return html`<h1 id=${identity} class=${className} data-chrome-part=${marker}>${content}</h1>`;
    case 2:
      return html`<h2 id=${identity} class=${className} data-chrome-part=${marker}>${content}</h2>`;
    case 3:
      return html`<h3 id=${identity} class=${className} data-chrome-part=${marker}>${content}</h3>`;
    case 4:
      return html`<h4 id=${identity} class=${className} data-chrome-part=${marker}>${content}</h4>`;
    case 5:
      return html`<h5 id=${identity} class=${className} data-chrome-part=${marker}>${content}</h5>`;
    default:
      return html`<h6 id=${identity} class=${className} data-chrome-part=${marker}>${content}</h6>`;
  }
}

/** The component's configuration as a plain record. */
export function configurationOf(state: Pick<FieldState, "model">): Readonly<Record<string, unknown>> {
  const configuration = state.model.node.configuration;
  return configuration !== null && typeof configuration === "object" && !Array.isArray(configuration) ? (configuration as Record<string, unknown>) : {};
}
