/** The builder's chrome drawn with an icon set of the page's own. */
import { BUILDER_HEIGHT, SAMPLE_DATA_SOURCES, SAMPLE_DEFINITION_URL, bundleTags, htmlDocument, jsLiteral, moduleScript, openTag } from "./page";
import type { ExampleSpec } from "./types";

// A handful of glyphs drawn on a 24 by 24 grid, one per name the builder asks the set for.
const GLYPHS: Record<string, string> = {
  undo: `<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>`,
  redo: `<path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>`,
  "show-hidden": `<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>`,
  "hide-hidden": `<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><path d="M4 4l16 16"/>`,
  "drag-handle": `<circle cx="9" cy="6" r="1.5" fill="currentColor"/><circle cx="15" cy="6" r="1.5" fill="currentColor"/><circle cx="9" cy="12" r="1.5" fill="currentColor"/><circle cx="15" cy="12" r="1.5" fill="currentColor"/><circle cx="9" cy="18" r="1.5" fill="currentColor"/><circle cx="15" cy="18" r="1.5" fill="currentColor"/>`,
  "components-panel": `<rect x="4" y="4" width="7" height="7"/><rect x="13" y="4" width="7" height="7"/><rect x="4" y="13" width="7" height="7"/><rect x="13" y="13" width="7" height="7"/>`,
  "properties-panel": `<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="2.5" fill="var(--db-surface, #fff)"/><circle cx="15" cy="17" r="2.5" fill="var(--db-surface, #fff)"/>`,
  "outline-panel": `<path d="M4 6h3M10 6h10M7 12h3M13 12h7M7 18h3M13 18h7"/>`,
  "document-menu": `<circle cx="5" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="19" cy="12" r="1.5" fill="currentColor"/>`,
  "new-form": `<path d="M14 3H6v18h12V7z"/><path d="M12 11v6M9 14h6"/>`,
  "open-form": `<path d="M3 7h6l2 2h10v10H3z"/>`,
  "download-form": `<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>`,
  "field-text": `<path d="M5 6h14M12 6v13"/>`,
  "field-number": `<path d="M9 4 7 20M17 4l-2 16M4 9h16M3 15h16"/>`,
  "field-checkbox": `<rect x="4" y="4" width="16" height="16" rx="3"/><path d="m8 12 3 3 5-6"/>`,
  "field-select": `<rect x="3" y="6" width="18" height="12" rx="2"/><path d="m9 11 3 3 3-3"/>`,
  "field-date": `<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>`,
  "action-button": `<rect x="3" y="8" width="18" height="8" rx="4"/>`
};

export const iconsLibraryExample: ExampleSpec = {
  title: "The builder drawn with an icon set of the page's own",
  options: [],
  page() {
    const lines = Object.entries(GLYPHS).map(([name, body], index, all) => `  ${/^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name)}: glyph(\`${body}\`)${index < all.length - 1 ? "," : ""}`);
    return htmlDocument(
      "Form builder",
      bundleTags("builder"),
      [
        openTag("datum-form-builder", [`id="builder"`, `layout="contained"`, `style="height: ${BUILDER_HEIGHT}px"`, `src="${SAMPLE_DEFINITION_URL}"`]) + `\n    </datum-form-builder>`,
        ``,
        moduleScript([
          `// The bundle exports what a set is built from.`,
          `import { svgIconSet } from "/datum/datum-builder.js";`,
          ``,
          `// A glyph is the markup inside an <svg> and the grid it was drawn on.`,
          `const glyph = (body) => ({ viewBox: "0 0 24 24", body });`,
          ``,
          `// A real library plugs in the same way: each of its icons becomes a glyph under the builder's`,
          `// name for it. Any name left out is drawn with the builder's own icon.`,
          `const mine = svgIconSet(`,
          `  "mine",`,
          `  {`,
          ...lines.map((line) => `  ${line}`),
          `  },`,
          `  // Attributes for every glyph's <svg>: here a thick stroke that takes the control's colour.`,
          `  { attrs: 'fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"' }`,
          `);`,
          ``,
          `const builder = document.getElementById("builder");`,
          `builder.icons = mine;`,
          ``,
          `builder.dataSources = ${jsLiteral(SAMPLE_DATA_SOURCES)};`
        ])
      ]
    );
  }
};
