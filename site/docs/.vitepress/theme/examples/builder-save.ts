/** The builder keeping its form on the page's own server: Save, the unsaved cue, and a stale save refused. */
import { BUILDER_HEIGHT, SAMPLE_DATA_SOURCES, bundleTags, htmlDocument, jsLiteral, moduleScript } from "./page";
import type { ExampleRequest, ExampleReply, ExampleSpec } from "./types";

const FORM_ADDRESS = "/api/forms/customer-intake";

// The stand-in server's copy of the form's revision. A real server keeps this beside the form and
// sends it as the ETag; the example's stand-ins answer with a body, so it travels as a number.
let serverRevision = 3;

export const builderSaveExample: ExampleSpec = {
  title: "The builder saving to the page's server",
  options: [{ key: "conflict", label: "Someone else saves first", default: false }],
  page() {
    return htmlDocument("Form builder", bundleTags("builder"), [
      `    <datum-form-builder id="builder" layout="contained" style="height: ${BUILDER_HEIGHT}px"></datum-form-builder>`,
      ``,
      moduleScript([
        `const builder = document.getElementById("builder");`,
        `const FORM_URL = "${FORM_ADDRESS}";`,
        ``,
        `builder.dataSources = ${jsLiteral(SAMPLE_DATA_SOURCES)};`,
        ``,
        `// The revision the form was loaded at. Every save sends it back as If-Match, so a save from`,
        `// a page that fell behind another author's is refused with 409, not laid over theirs.`,
        `const loaded = await fetch(FORM_URL).then((response) => response.json());`,
        `let revision = loaded.revision;`,
        ``,
        `// The definition the builder is handed is its saved one: builder.dirty stays false, and the`,
        `// builder shows no "Changes not saved" cue, until the author changes something.`,
        `builder.definition = loaded.definition;`,
        ``,
        `async function save() {`,
        `  // What this save sends: an edit made while it runs stays unsaved.`,
        `  const definition = builder.definition;`,
        `  let response;`,
        `  try {`,
        `    response = await fetch(FORM_URL, {`,
        `      method: "PUT",`,
        `      headers: { "content-type": "application/json", "if-match": String(revision) },`,
        `      body: JSON.stringify(definition)`,
        `    });`,
        `  } catch {`,
        `    throw new Error("the server could not be reached");`,
        `  }`,
        `  // A thrown error is the reason the builder shows beside its menu.`,
        `  if (response.status === 409) throw new Error("someone else saved this form first");`,
        `  if (!response.ok) throw new Error("the server answered " + response.status);`,
        `  revision = (await response.json()).revision;`,
        `  // The form as sent is the saved one now, so the cue clears. An edit made meanwhile stays unsaved.`,
        `  builder.savedDefinition = definition;`,
        `}`,
        ``,
        `// Save in the builder's ⋮ menu, and Ctrl/Cmd+S inside the builder. The builder asks about`,
        `// an edit still open in the inspector first, and shows "Saving…" while the promise is pending.`,
        `builder.fileActions = { save, saveLabel: "Save" };`
      ])
    ]);
  },
  async serve(request: ExampleRequest, options): Promise<ExampleReply | undefined> {
    if (request.path !== FORM_ADDRESS) return undefined;
    if (request.method === "GET") {
      // A fresh page load: the form as the server holds it.
      serverRevision = 3;
      const { withBase } = await import("vitepress");
      const definition = await fetch(withBase("/forms/customer-intake.json")).then((response) => response.json());
      return { body: { revision: serverRevision, definition }, log: [`GET ${FORM_ADDRESS}  revision ${serverRevision}`] };
    }
    if (request.method !== "PUT") return undefined;
    // The option stands for another author saving between this page's load and its Save.
    if (options.conflict === true && request.headers["if-match"] === String(serverRevision)) serverRevision += 1;
    if (request.headers["if-match"] !== String(serverRevision)) {
      return { status: 409, body: { error: "stale revision" }, log: [`PUT refused: If-Match ${request.headers["if-match"]}, the form is at revision ${serverRevision}`] };
    }
    serverRevision += 1;
    return { body: { revision: serverRevision }, log: [`PUT accepted: If-Match ${request.headers["if-match"]}, the form is now at revision ${serverRevision}`] };
  }
};
