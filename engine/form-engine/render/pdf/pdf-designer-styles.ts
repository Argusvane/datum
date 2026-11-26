/**
 * How the PDF layout tree looks while it is being designed: a page-shaped
 * sheet with margin bands and page edges, and a design-time face for every PDF component. The
 * canvas previews through `<datum-form-renderer>` under the PDF designer's binding (Datum's
 * look, `builder/pdf-designer/pdf-canvas-adapters.ts`), which adopts these rules after its own;
 * they are scoped under the Datum binding's `.datum-form` form element.
 *
 * The sheet is a size container: its page edges and margins are fractions of its own width,
 * so the same layout previews at any canvas width with the page's true proportions.
 */
export const PDF_DESIGNER_THEME_ID = "datum-pdf-designer";

export const PDF_DESIGNER_CSS = `
.datum-form .datum-pdf-sheet {
  container-type: inline-size;
  display: block;
}
.datum-form .datum-pdf-page {
  position: relative;
  box-sizing: border-box;
  min-height: calc(100cqw * var(--datum-pdf-ratio, 1.2941));
  padding: calc(100cqw * var(--datum-pdf-margin-top, 0.0882)) calc(100cqw * var(--datum-pdf-margin-right, 0.0882))
    calc(100cqw * var(--datum-pdf-margin-bottom, 0.0882)) calc(100cqw * var(--datum-pdf-margin-left, 0.0882));
  background: #ffffff;
  color: #111111;
  font-family: var(--datum-pdf-font, "DejaVu Sans", "Helvetica Neue", Arial, sans-serif);
  font-size: calc(100cqw * 0.0163);
  line-height: 1.35;
}
/* Page edges: one hairline every page height, over the whole sheet. */
.datum-form .datum-pdf-page::before {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  background-image: repeating-linear-gradient(
    to bottom,
    transparent 0,
    transparent calc(100cqw * var(--datum-pdf-ratio, 1.2941) - 2px),
    rgba(190, 60, 60, 0.55) calc(100cqw * var(--datum-pdf-ratio, 1.2941) - 2px),
    rgba(190, 60, 60, 0.55) calc(100cqw * var(--datum-pdf-ratio, 1.2941))
  );
}
.datum-form .datum-pdf-page__band {
  box-sizing: border-box;
  min-height: calc(100cqw * var(--datum-pdf-band, 0));
  border: 1px dashed rgba(100, 120, 140, 0.45);
  padding: 4px;
  margin: 0 0 8px;
  font-size: 0.85em;
}
.datum-form .datum-pdf-page__band--footer { margin: 8px 0 0; }
.datum-form .datum-pdf-page__band-label {
  display: block;
  font-size: 10px;
  color: #6b7c8c;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.datum-form .datum-pdf-page__body { min-height: 2em; }
.datum-form .datum-pdf-section { margin: 0 0 12px; }
.datum-form .datum-pdf-section__heading { margin: 0 0 6px; font-size: 1.2em; font-weight: 600; }
.datum-form .datum-pdf-text { margin: 0 0 6px; white-space: pre-wrap; }
.datum-form .datum-pdf-text--h1 { font-size: 1.8em; font-weight: 700; }
.datum-form .datum-pdf-text--h2 { font-size: 1.4em; font-weight: 700; }
.datum-form .datum-pdf-text--h3 { font-size: 1.2em; font-weight: 700; }
.datum-form .datum-pdf-text--muted { color: #555555; font-size: 0.85em; }
.datum-form .datum-pdf-text--label { font-size: 0.8em; font-weight: 700; color: #555555; }
.datum-form .datum-pdf-text--center { text-align: center; }
.datum-form .datum-pdf-text--end { text-align: end; }
.datum-form .datum-pdf-token {
  background: #e8f1fb;
  color: #1a4480;
  border-radius: 3px;
  padding: 0 3px;
  font-family: ui-monospace, Menlo, monospace;
  font-size: 0.9em;
}
.datum-form .datum-pdf-field { margin: 0 0 8px; }
.datum-form .datum-pdf-field__chip,
.datum-form .datum-pdf-chip {
  display: inline-block;
  font-size: 10px;
  color: #1a4480;
  background: #e8f1fb;
  border-radius: 999px;
  padding: 1px 7px;
  margin: 0 0 2px;
}
.datum-form .datum-pdf-field__chip--unbound { color: #8a2a2a; background: #fbe9e9; }
/* The bound field's own drawing is a picture here (inert): clicks select the layout node around it. */
.datum-form .datum-pdf-field__preview,
.datum-form .datum-pdf-field__preview * { pointer-events: none; }
.datum-form .datum-pdf-field__preview .datum-live-field { margin: 0; }
.datum-form .datum-pdf-placeholder {
  border: 1px dashed #c9d3dc;
  border-radius: 4px;
  padding: 6px 8px;
  color: #6b7c8c;
  font-size: 0.85em;
}
.datum-form .datum-pdf-table { width: 100%; border-collapse: collapse; margin: 0 0 8px; }
.datum-form .datum-pdf-table td { vertical-align: top; padding: 4px; }
.datum-form .datum-pdf-table--all td { border: 1px solid #999999; }
.datum-form .datum-pdf-table--horizontal tr { border-bottom: 1px solid #999999; }
.datum-form .datum-pdf-table--none td { border: 1px dashed rgba(100, 120, 140, 0.35); }
.datum-form .datum-pdf-table tr.datum-pdf-table__header td { background: #f2f2f2; font-weight: 700; }
.datum-form .datum-pdf-table__caption { caption-side: top; text-align: start; font-size: 10px; color: #6b7c8c; padding: 0 0 2px; }
.datum-form .datum-pdf-table__caption--unbound { color: #8a2a2a; }
.datum-form .datum-pdf-repeat { border: 1px dashed #7aa2cf; border-radius: 4px; padding: 6px; margin: 0 0 8px; }
.datum-form .datum-pdf-box { box-sizing: border-box; margin: 0 0 8px; }
.datum-form .datum-pdf-box--anchored { border-left: 3px solid #1a4480 !important; }
.datum-form .datum-pdf-rule { border: 0; border-top: 1px solid #999999; margin: 6px 0; }
.datum-form .datum-pdf-spacer { border: 1px dashed rgba(100, 120, 140, 0.3); border-radius: 3px; }
.datum-form .datum-pdf-break {
  border-top: 2px dashed rgba(190, 60, 60, 0.7);
  text-align: center;
  color: #8a2a2a;
  font-size: 10px;
  margin: 10px 0;
  line-height: 1;
}
.datum-form .datum-pdf-image { max-width: 100%; display: block; margin: 0 0 8px; }
.datum-form .datum-pdf-signature { margin: 0 0 8px; }
.datum-form .datum-pdf-signature__label { font-size: 10px; color: #6b7c8c; margin: 0 0 2px; }
.datum-form .datum-pdf-signature__box {
  box-sizing: border-box;
  border: 1px solid #999999;
  border-radius: 2px;
  padding: 4px 6px;
  font-size: 11px;
  color: #6b7c8c;
  display: flex;
  align-items: center;
  gap: 6px;
  background: rgba(100, 120, 140, 0.06);
}
.datum-form .datum-pdf-signature__mark { font-size: 16px; line-height: 1; }
.datum-form .datum-pdf-signature__rule { border-top: 1px solid #333333; height: 28px; }
`;
