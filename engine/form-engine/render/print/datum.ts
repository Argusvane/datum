import { DATUM_TOKENS } from "../live/datum/default-tokens.js";
import type { PrintTheme } from "./theme.js";

/**
 * The Datum theme on paper: the basic theme's markup (it draws no node kind of its own) in Datum's
 * face, ink and shapes, read from the Datum binding's light token set, so a form printed from the
 * Datum theme reads as the form on screen. Paper is light whatever the page's colour scheme: the
 * dark set never reaches print. Like the basic theme it needs nothing from the host.
 */

const token = (name: string, fallback: string): string => DATUM_TOKENS[name] ?? fallback;

const ink = token("color-text", "#16171a");
const muted = token("color-muted", "#4e525b");
const line = token("color-border", "#9aa2ad");
const inputLine = token("color-input-border", "#7b828c");
const sunken = token("color-panel-header", "#eceef1");
const accent = token("color-accent", "#2f4bd6");
const mark = token("color-choice-mark", "#16171a");
const success = token("color-success", "#1e6b3a");
const info = token("color-info", "#1c6e8c");
const warning = token("color-warning", "#8a4b00");
const error = token("color-error", "#b42318");
const face = token("font-family", 'system-ui, -apple-system, "Segoe UI", sans-serif');

export const datumPrintTheme: PrintTheme = Object.freeze({
  id: "datum",
  label: "Datum",
  renditions: ["answers", "blank", "filled"] as const,
  marginBox: `font: 8.5pt/1.2 ${face}; color: ${muted};`,
  css: `
.datum-print { font: 10.5pt/1.45 ${face}; color: ${ink}; }
.dp-title { font-size: 17pt; font-weight: 600; margin: 0 0 14pt; letter-spacing: -0.01em; }
.dp-label { font-size: 9.75pt; font-weight: 500; }
.dp-hint, .dp-date__part { color: ${muted}; font-size: 9.75pt; }
.dp-answer { border: 1px solid ${inputLine}; border-radius: 6pt; padding: 4pt 7pt; min-height: 1.3em; overflow-wrap: anywhere; }
.dp-empty { color: ${muted}; }
.dp-answer.dp-empty { border-style: dashed; }
.dp-lines { border: 1px solid ${inputLine}; border-radius: 6pt; padding: 0 7pt; }
.dp-line { border-bottom-color: ${line}; }
.dp-line:last-child { border-bottom: 0; }
.dp-line--filled { padding: 4pt 0; }
.dp-box { border-color: ${inputLine}; border-radius: 6pt; }
.dp-box--filled { padding: 3pt 6pt; }
.dp-mark { border-color: ${inputLine}; }
.dp-mark--box { border-radius: 3pt; }
.is-chosen .dp-mark { border-color: ${mark}; }
.is-chosen .dp-mark--circle::after { background: ${mark}; }
.is-chosen .dp-mark--box::after { border-color: ${mark}; }
.dp-group { border: 1px solid ${line}; border-radius: 10pt; padding: 8pt 10pt 2pt; }
.dp-heading { font-size: 12pt; font-weight: 600; }
/* A panel's look: the basic theme's boxes in Datum's line, sunken surface and corner. Plain is the group above, unchanged; Datum's group already carries a line, so outlined is the same box under its own name. */
.dp-group--outlined { border: 1px solid ${line}; }
.dp-group--shaded { border: 0; background: ${sunken}; border-radius: 10pt; padding: 8pt 10pt 2pt; }
.dp-group--card { border-color: ${line}; }
.dp-group--card > .dp-heading { background: ${sunken}; border-bottom: 1px solid ${line}; border-radius: 9pt 9pt 0 0; }
.dp-section { border-top: 2px solid ${accent}; padding-top: 8pt; }
.dp-grid th, .dp-grid td { border-color: ${line}; }
.dp-grid th { background: ${sunken}; font-weight: 500; }
.dp-notice { border: 1px solid ${line}; border-inline-start: 4pt solid ${success}; border-radius: 6pt; }
.dp-notice--info { border-inline-start-color: ${info}; }
.dp-notice--warning { border-inline-start-color: ${warning}; }
.dp-notice--error { border-inline-start-color: ${error}; }
`,
  draw: {}
});
