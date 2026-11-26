/** The builder's chrome drawn with Font Awesome, or with the builder's own icons. */
import { BUILDER_HEIGHT, BUNDLE_BASE, SAMPLE_DATA_SOURCES, SAMPLE_DEFINITION_URL, bundleTags, htmlDocument, jsLiteral, moduleScript, openTag } from "./page";
import type { ExampleSpec } from "./types";

export const iconsFontawesomeExample: ExampleSpec = {
  title: "The builder drawn with Font Awesome",
  options: [
    {
      key: "set",
      label: "Icon set",
      default: "font-awesome",
      choices: [
        { value: "font-awesome", label: "Font Awesome" },
        { value: "builtin", label: "The builder's own" }
      ]
    }
  ],
  page(options) {
    const fontAwesome = options.set === "font-awesome";
    const [stylesheet, builder] = bundleTags("builder");
    const head = fontAwesome
      ? [
          stylesheet!,
          `<!-- The icons bundle goes before the builder's. It registers Font Awesome Free's solid glyphs as the page's icon set. -->`,
          `<script type="module" src="${BUNDLE_BASE}/datum-icons-fontawesome.js"></script>`,
          builder!
        ]
      : [stylesheet!, builder!];
    const script = fontAwesome
      ? [
          `import { FONT_AWESOME_ICONS } from "${BUNDLE_BASE}/datum-icons-fontawesome.js";`,
          ``,
          `const builder = document.getElementById("builder");`,
          ``,
          `// The icons bundle has registered the set for the whole page, so this line is not needed`,
          `// here. It gives the set to one builder, which is how a page uses a set it did not register.`,
          `builder.icons = FONT_AWESOME_ICONS;`
        ]
      : [
          `import { BUILTIN_ICONS } from "${BUNDLE_BASE}/datum-builder.js";`,
          ``,
          `const builder = document.getElementById("builder");`,
          ``,
          `// The builder's own drawings: one stroke glyph per control and per kind of component, with no`,
          `// icon library behind them. This is what it draws with when the page registers no set.`,
          `builder.icons = BUILTIN_ICONS;`
        ];
    script.push(``, `builder.dataSources = ${jsLiteral(SAMPLE_DATA_SOURCES)};`);
    return htmlDocument(
      "Form builder",
      head,
      [openTag("datum-form-builder", [`id="builder"`, `layout="contained"`, `style="height: ${BUILDER_HEIGHT}px"`, `src="${SAMPLE_DEFINITION_URL}"`]) + `\n    </datum-form-builder>`, ``, moduleScript(script)]
    );
  }
};
