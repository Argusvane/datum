/** A component type of the page's own, on the form or on the builder's palette. */
import { BUILDER_HEIGHT, bundleTags, htmlDocument, moduleScript, openTag } from "./page";
import type { ExampleSpec } from "./types";

const SURVEY_URL = "/forms/customer-survey.json";

export const pluginExample: ExampleSpec = {
  title: "A component type of the page's own",
  options: [
    {
      key: "surface",
      label: "Give it to",
      default: "form",
      choices: [
        { value: "form", label: "The form" },
        { value: "builder", label: "The builder" }
      ]
    },
    {
      key: "wiring",
      label: "Wire it as",
      default: "definition",
      choices: [
        { value: "definition", label: "componentDefinitions" },
        { value: "plugin", label: "A plugin, with plugins.register" }
      ]
    }
  ],
  page(options) {
    const onForm = options.surface === "form";
    const bundle = onForm ? "form" : "builder";
    const asPlugin = options.wiring === "plugin";
    const element = onForm
      ? `    <datum-form id="survey" src="${SURVEY_URL}"></datum-form>`
      : openTag("datum-form-builder", [`id="builder"`, `layout="contained"`, `style="height: ${BUILDER_HEIGHT}px"`, `src="${SURVEY_URL}"`]) + `\n    </datum-form-builder>`;
    const target = onForm ? "survey" : "builder";
    const script = [
      `// The bundle exports what a component type is built from, and the page's plugin registry.`,
      `import { plugins, standardFieldCapabilities } from "/datum/datum-${bundle}.js";`,
      ``,
      `// A component type the bundle does not know: a row of stars, stored as a number.`,
      `const rating = {`,
      `  type: "star-rating",`,
      `  version: "1.0.0",`,
      `  // The standard type it reads as, so the definition can be validated without this code.`,
      `  base: "number",`,
      `  // What lands on the canvas when the type is picked from the palette.`,
      `  createDefault: () => ({ id: "rating", type: "star-rating", configuration: { label: "Rating", max: 5 } }),`,
      `  // The inspector fields every field type shares (label, required, hidden, CSS classes)...`,
      `  capabilities: standardFieldCapabilities({ placeholder: false, description: false }),`,
      `  // ...and one of its own.`,
      `  propertyEditor: {`,
      `    mode: "extend",`,
      `    fields: [{ id: "max", type: "number", propertyPath: "max", label: "Stars", min: 1, max: 10 }]`,
      `  },`,
      `  // How it draws, on the form and on the builder's canvas. It is handed the renderer's own`,
      `  // lit, so the page loads none, and answers the field with the number of the star pressed.`,
      `  adapter: ({ html }) => ({`,
      `    kind: "field",`,
      `    template: (state, on) => {`,
      `      const max = Number(state.model.node.configuration.max) || 5;`,
      "      const stars = Array.from({ length: max }, (_, index) =>",
      "        html`<button type=\"button\" class=${index < Number(state.answer) ? \"star-rating__star is-on\" : \"star-rating__star\"} aria-label=${`${index + 1} of ${max}`} @click=${() => on.input(index + 1)}>★</button>`",
      "      );",
      "      return html`<div class=\"star-rating\" role=\"group\" aria-labelledby=${state.labelId}>",
      "        <span class=\"star-rating__label\" id=${state.labelId}>${state.label}</span>",
      "        <span class=\"star-rating__stars\">${stars}</span>",
      "      </div>`;",
      `    }`,
      `  }),`,
      `  // Its own rules, adopted into the form after the design system's.`,
      `  css: [`,
      `    ".star-rating__stars { display: inline-flex; gap: 0.25rem; }",`,
      `    ".star-rating__star { font: inherit; font-size: 1.5rem; border: 0; background: none; color: inherit; cursor: pointer; }",`,
      `    ".star-rating__star.is-on { color: #b45309; }"`,
      `  ]`,
      `};`,
      ``
    ];
    if (asPlugin) {
      script.push(
        `// As a plugin: the type with the palette entry the builder lists it under, and beside it a`,
        `// hook that runs after every submit. Registered once, it serves every element on the page.`,
        `plugins.register({`,
        `  id: "survey",`,
        `  version: "1.0.0",`,
        `  components: [{ ...rating, palette: { label: "Rating", icon: "★", group: "Survey" } }],`,
        `  hooks: { afterSubmit: [({ submissionId }) => console.log("submitted", submissionId)] }`,
        `});`
      );
    } else if (onForm) {
      script.push(`// The type, beside the standard catalogue.`, `${target}.componentDefinitions = [rating];`);
    } else {
      script.push(
        `// The palette entry, under a heading of its own, then the type beside the standard catalogue.`,
        `${target}.componentTypes = [{ type: "star-rating", label: "Rating", icon: "★", group: "Survey" }];`,
        `${target}.componentDefinitions = [rating];`
      );
    }
    return htmlDocument(onForm ? "Customer survey" : "Survey builder", bundleTags(bundle), [element, ``, moduleScript(script)]);
  }
};
