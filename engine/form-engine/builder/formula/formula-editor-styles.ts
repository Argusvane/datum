/**
 * The formula editor's look, as one stylesheet string the hosts append to their own (the Logic
 * surface's sheet, the inspector's): the box, its tokens, the suggestions popover, the helper
 * row and its menus. Eager and dependency-free, so a host's sheet is complete before the
 * editor's chunk arrives and the textarea fallback already sits in the same frame.
 *
 * The box is a sentence, not code. Field references are chips with the label (`.f-field` on the shared
 * `.ref-chip`, which draws the accent wash at 24px), the menus the shared `.menu` and `.menu-item`
 * (these rules add the position, the size and the columns), keywords muted bold words (`.f-kw`),
 * numbers in the literal colour (`.f-num`), strings in the string colour (`.f-str`), operators and function names in the mono face (`.f-op`,
 * `.f-fn`), an unknown field a chip in the danger wash with a wavy line (`.f-field.unknown`).
 * Colours and faces come from the builder's `--db-*` tokens, so a builder theme restyles the
 * editor with the panels.
 *
 * CodeMirror injects its own base rules as an adopted sheet, which the root applies after the
 * host's `<style>`: every rule here that overrides one of those names the editor's root and
 * the box, so it outweighs the base's one-class selectors. No backticks inside this literal.
 */
export const FORMULA_EDITOR_STYLES = `
.formula-editor{display:flex;flex-direction:column;gap:8px;min-width:0;position:relative;font-family:var(--db-font, inherit)}
.formula-editor .formula.cm-editor{min-height:44px;border:var(--db-border-w, 1px) solid var(--db-line-input);border-radius:var(--db-radius-md);background:var(--db-surface);color:var(--db-ink);font-size:var(--db-text-md);line-height:28px}
.formula-editor .formula.cm-editor.cm-focused{outline:2px solid var(--db-focus);outline-offset:1px}
.formula-editor .formula.cm-editor.bad{border-color:var(--db-danger-line)}
.formula-editor .formula.cm-editor .cm-scroller{font-family:inherit;line-height:28px;overflow:visible}
.formula-editor .formula.cm-editor .cm-content{padding:8px 10px;min-height:44px;caret-color:var(--db-ink);white-space:pre-wrap;word-break:break-word}
.formula-editor .formula.cm-editor .cm-line{padding:0}
.formula-editor .formula.cm-editor .cm-cursor{border-left-color:var(--db-ink)}
.formula-editor .formula.cm-editor .cm-placeholder{color:var(--db-ink-subtle);font-size:var(--db-text-md);font-style:normal}
.formula-editor .formula.cm-editor .cm-selectionBackground,.formula-editor .formula.cm-editor.cm-focused .cm-selectionBackground{background:var(--db-accent-soft)}
.formula-editor .f-field{vertical-align:middle;white-space:nowrap}
.formula-editor .f-field.unknown{background:var(--db-danger-soft);color:var(--db-danger);text-decoration:underline wavy var(--db-danger);text-underline-offset:4px}
.formula-editor .f-kw{color:var(--db-ink-muted);font-weight:600}
.formula-editor .f-op{color:var(--db-ink);font-family:var(--db-font-mono, ui-monospace, Menlo, monospace)}
.formula-editor .f-num{color:var(--db-code-literal);font-family:var(--db-font-mono, ui-monospace, Menlo, monospace);font-weight:500}
.formula-editor .f-str{color:var(--db-code-string);font-family:var(--db-font-mono, ui-monospace, Menlo, monospace)}
.formula-editor .f-fn{color:var(--db-ink);font-family:var(--db-font-mono, ui-monospace, Menlo, monospace);font-weight:500}
.formula-editor .f-path{color:var(--db-accent-text);font-weight:500}
.formula-editor .f-bad{color:var(--db-danger);text-decoration:underline wavy var(--db-danger);text-underline-offset:4px}
.formula-editor .formula.cm-editor .cm-lintRange{background-image:none;background-repeat:no-repeat;padding-bottom:0}
.formula-editor .formula.cm-editor .cm-lintRange-error{text-decoration:underline wavy var(--db-danger);text-underline-offset:4px}
.formula-editor .formula.cm-editor .cm-lintRange-warning{text-decoration:underline wavy var(--db-warn-line);text-underline-offset:4px}
.formula-editor .formula.cm-editor .cm-lintPoint-error::after{border-bottom-color:var(--db-danger)}
.formula-editor .formula.cm-editor .cm-lintPoint-warning::after{border-bottom-color:var(--db-warn-line)}
.formula-editor .cm-tooltip{background:var(--db-surface);color:var(--db-ink);border:1px solid var(--db-line-card);border-radius:var(--db-radius-lg);box-shadow:var(--db-shadow-overlay, 0 24px 48px -20px rgba(0,0,0,.45));font-family:var(--db-font, inherit);font-size:var(--db-text-sm);z-index:var(--db-z-popover, 30)}
.formula-editor .cm-tooltip.cm-tooltip-autocomplete{padding:6px}
.formula-editor .cm-tooltip.cm-tooltip-autocomplete > ul{font-family:inherit;min-width:280px;max-width:420px;max-height:300px}
.formula-editor .cm-tooltip.cm-tooltip-autocomplete > ul > li{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:var(--db-radius-sm);line-height:1.3}
.formula-editor .cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]{background:var(--db-surface-hover);color:inherit}
.formula-editor .cm-tooltip.cm-tooltip-autocomplete > ul > li.f-opt-field .cm-completionLabel{display:inline-flex;align-items:center;height:24px;padding:0 8px;border-radius:var(--db-radius-xs);background:var(--db-accent-soft);color:var(--db-accent-text);font-weight:500}
.formula-editor .cm-tooltip.cm-tooltip-autocomplete > ul > li.f-opt-function .cm-completionLabel{font-family:var(--db-font-mono, ui-monospace, Menlo, monospace);font-weight:500}
.formula-editor .cm-tooltip.cm-tooltip-autocomplete > ul > li.f-opt-keyword .cm-completionLabel{color:var(--db-ink-muted);font-weight:600}
.formula-editor .cm-tooltip.cm-tooltip-autocomplete > ul > li.f-opt-option .cm-completionLabel{font-family:var(--db-font-mono, ui-monospace, Menlo, monospace);color:var(--db-code-string)}
.formula-editor .cm-tooltip.cm-tooltip-autocomplete > ul > li .cm-completionDetail{margin-inline-start:auto;font-style:normal;font-family:var(--db-font-mono, ui-monospace, Menlo, monospace);color:var(--db-ink-muted);font-size:var(--db-text-xs)}
.formula-editor .cm-tooltip.cm-tooltip-autocomplete > ul > li.f-opt-function .cm-completionDetail{margin-inline-start:0;font-family:inherit}
.formula-editor .cm-tooltip.cm-tooltip-autocomplete > ul > .cm-completionSection{font-size:var(--db-text-sm);font-weight:600;letter-spacing:.02em;color:var(--db-ink-muted);padding:8px 10px 2px}
.formula-editor .cm-tooltip.cm-tooltip-autocomplete .f-suggest-footer{padding:6px 10px 4px;font-size:var(--db-text-xs);color:var(--db-ink-subtle);border-block-start:1px solid var(--db-line-divider);margin-block-start:4px;display:var(--db-hint-display, block)}
.formula-editor .cm-tooltip.cm-completionInfo{padding:8px 10px;max-width:280px;color:var(--db-ink-muted);font-size:var(--db-text-xs)}
.formula-editor .cm-tooltip.cm-tooltip-lint{padding:6px 10px;font-size:var(--db-text-xs)}
.formula-editor .cm-tooltip.cm-tooltip-lint .cm-diagnostic{border-left:0;padding:2px 0}
.formula-editor .cm-tooltip.cm-tooltip-lint .cm-diagnosticAction{background:var(--db-accent-soft);color:var(--db-accent-text);border-radius:var(--db-radius-xs);padding:2px 6px;margin-inline-start:6px;cursor:pointer}
.formula-editor .f-help{display:flex;flex-wrap:wrap;gap:6px;align-items:center;position:relative}
.formula-editor .f-help .help{height:30px;padding:0 10px;border-radius:var(--db-radius-pill, 999px);border:1px solid var(--db-line-card);background:var(--db-surface);font:inherit;font-size:var(--db-text-xs);font-weight:500;display:inline-flex;align-items:center;gap:6px;cursor:pointer;color:var(--db-ink)}
.formula-editor .f-help .help:hover{background:var(--db-surface-hover)}
.formula-editor .f-help .help:focus-visible{outline:2px solid var(--db-focus);outline-offset:2px}
.formula-editor .f-help .help[aria-expanded="true"]{background:var(--db-selected);border-color:var(--db-selected);color:var(--db-selected-ink)}
.formula-editor .f-help .help .f-glyph{font-family:var(--db-font-mono, ui-monospace, Menlo, monospace);font-weight:600}
.formula-editor .f-help .help svg{width:12px;height:12px}
.formula-editor .f-help .f-spacer{flex:1}
.formula-editor .f-help .f-reference{font-size:var(--db-text-xs);color:var(--db-accent-text);text-decoration:none}
.formula-editor .f-help .f-reference:hover{text-decoration:underline}
.formula-editor .f-menu{position:absolute;inset-block-start:calc(100% + 4px);inset-inline-start:0;box-sizing:border-box;min-width:280px;max-width:100%;max-height:320px;overflow:auto}
.formula-editor .f-menu[hidden]{display:none}
.formula-editor .f-menu.f-menu-wide{display:grid;grid-template-columns:repeat(2, minmax(0, 1fr));gap:2px 12px;width:min(560px, 100%)}
.formula-editor .f-menu.f-menu-wide[hidden]{display:none}
.formula-editor .f-mh{font-size:var(--db-text-sm);font-weight:600;color:var(--db-ink-muted);padding:8px 10px 2px;grid-column:1 / -1}
.formula-editor .f-mi .f-sub{font-size:var(--db-text-xs);color:var(--db-ink-muted);margin-inline-start:auto;font-family:var(--db-font-mono, ui-monospace, Menlo, monospace);white-space:nowrap}
.formula-editor .f-mi .f-args{color:var(--db-ink-muted)}
.formula-editor .f-menu-empty{padding:8px 10px;font-size:var(--db-text-xs);color:var(--db-ink-muted)}
/* The phone: the helper row rides above the box so the suggestions popover never covers it, and every touch target in the editor measures 44px (24px at the least). */
:host([data-phone]) .formula-editor .f-help{order:-1}
:host([data-phone]) .formula-editor .f-help .help{min-height:44px;height:auto}
:host([data-phone]) .formula-editor .f-help .f-reference{display:inline-flex;align-items:center;min-height:44px}
:host([data-phone]) .formula-editor .f-mi{min-height:44px}
:host([data-phone]) .formula-editor .cm-tooltip.cm-tooltip-autocomplete > ul > li{min-height:44px;box-sizing:border-box}
@media (pointer:coarse){.formula-editor .cm-tooltip.cm-tooltip-autocomplete > ul > li{min-height:44px;box-sizing:border-box}}
`;
