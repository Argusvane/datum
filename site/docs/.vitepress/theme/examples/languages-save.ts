/** The builder hands the page the languages removed or renamed since the last save, so its catalog follows. */
import definition from "../../../public/forms/visit-request-save.json?raw";
import { BUILDER_HEIGHT, bundleTags, htmlDocument, moduleScript, openTag } from "./page";
import type { ExampleSpec } from "./types";

// The page's own catalog before any save: wording for French and Spanish, by language first.
const CATALOG = {
  fr: { form: { title: "Demande de visite" }, components: { fullName: { label: "Nom complet" }, submit: { label: "Envoyer" } } },
  es: { form: { title: "Solicitud de visita" }, components: { fullName: { label: "Nombre completo" }, submit: { label: "Enviar" } } }
};

export const languagesSaveExample: ExampleSpec = {
  title: "A builder whose Save keeps the page's catalog in step",
  options: [{ key: "save", label: "Server reply to Save", default: "saved", choices: [{ value: "saved", label: "Saved (204)" }, { value: "refused", label: "Refused (500)" }] }],
  page() {
    const element = [
      openTag("datum-form-builder", [`id="builder"`, `layout="contained"`, `style="height: ${BUILDER_HEIGHT}px"`, `src="/forms/visit-request-save.json"`]),
      `    </datum-form-builder>`
    ].join("\n");
    return htmlDocument("Form builder with a translation catalog", bundleTags("builder"), [
      element,
      ``,
      moduleScript([
        `const builder = document.getElementById("builder");`,
        `const URL_OF_FORM = "/api/forms/visit-request";`,
        ``,
        `// The page keeps a translation catalog of its own: language, then kind, then id, then`,
        `// property. The form's own translations travel inside its definition, and the builder keeps`,
        `// those in step itself.`,
        `let catalog = await (await fetch(URL_OF_FORM + "/catalog")).json();`,
        ``,
        `// The builder never asks the page to touch its catalog while the author works: Undo would`,
        `// then lose wording it can no longer bring back. It counts the net change to the languages`,
        `// since the form was loaded or last saved, and hands it to Save: { removed: ["es"],`,
        `// renamed: [{ from: "fr", to: "fr-CA" }] }. A chain of renames is one move, and a rename`,
        `// back or a removal undone is no change at all.`,
        `function applyLocaleChanges(catalog, { removed, renamed }) {`,
        `  const sources = new Set(renamed.map((move) => move.from));`,
        `  const next = {};`,
        `  for (const [code, entries] of Object.entries(catalog)) {`,
        `    if (!removed.includes(code) && !sources.has(code)) next[code] = entries;`,
        `  }`,
        `  for (const { from, to } of renamed) {`,
        `    if (from in catalog && !removed.includes(from)) next[to] = catalog[from];`,
        `  }`,
        `  return next;`,
        `}`,
        ``,
        `// Save is on the builder's menu. When the promise resolves, the languages as they stand`,
        `// become the new baseline; a rejected save leaves the count as it was.`,
        `builder.fileActions = {`,
        `  saveLabel: "Save",`,
        `  async save({ localeChanges }) {`,
        `    const next = applyLocaleChanges(catalog, localeChanges);`,
        `    console.log("localeChanges", JSON.stringify(localeChanges));`,
        `    const response = await fetch(URL_OF_FORM, {`,
        `      method: "PUT",`,
        `      headers: { "content-type": "application/json" },`,
        `      body: JSON.stringify({ definition: builder.definition, catalog: next })`,
        `    });`,
        `    if (!response.ok) throw new Error("The server refused the save (" + response.status + ")");`,
        `    catalog = next;`,
        `    console.log("catalog languages", Object.keys(catalog).join(", "));`,
        `  }`,
        `};`,
        ``,
        `// A page with a Save of its own, outside the menu, reads the same by hand:`,
        `//   const changes = builder.localeChangesSinceSave();`,
        `//   ...apply and store, then...`,
        `//   builder.markSaved();   // also clears the unsaved cue; markLocalesSaved() resets only the languages`,
        ``,
        `// A component id renamed in the builder is announced on datum-builder-change as`,
        `// detail.renamedIds, [{ kind: "components", from, to }], so a catalog kept under the same`,
        `// addresses can follow.`
      ])
    ]);
  },
  files() {
    return [{ title: "visit-request-save.json", lang: "json", code: definition }];
  },
  serve(request, options) {
    if (request.path === "/api/forms/visit-request/catalog" && request.method === "GET") return { body: CATALOG };
    if (request.method !== "PUT" || request.path !== "/api/forms/visit-request") return undefined;
    return { status: options.save === "refused" ? 500 : 204, log: [`PUT ${request.path} (${request.body.length} bytes)`] };
  }
};
