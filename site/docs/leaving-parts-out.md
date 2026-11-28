# Leaving parts out

Both elements load their optional parts as separate files, the first time each is needed. The `features` attribute goes a step further: with it, only the parts it lists exist. A part left out is never fetched, so its files need not be deployed at all. This page is the one place `features` is described, for the form and for the builder.

## The whole page

<LiveExample name="features" />

## How the list reads

Without the attribute, every feature exists. With it, only the listed ones do.

- `minimal` on `<datum-form>` is a single-page form that renders, validates and submits.
- `minimal` on `<datum-form-builder>` is the Form workspace alone: canvas, inspector and component palette.
- Add names to put parts back: `features="minimal data-sources drafts"`, `features="minimal logic languages"`.
- A setting for a part the list leaves out is ignored, with one warning in the console. A `minimal` form ignores `dataSources`, for one, which is why the example lists `data-sources`.
- A minus takes one out: `features="-drafts"` is everything but drafts. A list of only exclusions starts from `all`, so `-drafts` and `all -drafts` say the same. An exclusion wins wherever it stands in the list.
- A word that names nothing, a mistyped exclusion included, is reported and left out. A list holding one no longer starts from `all`, so a typo can only narrow what exists.
- `all` is every feature that is on by default. A feature that is off by default, `agent`, is added to it: `features="all agent"`.
- Lists take spaces or commas, in any case.

`features` is the master. An attribute that belongs to a part can only narrow it: `pdf="auto"` on a form whose list leaves `pdf` out is ignored, with one warning in the console.

## The form

| Feature | What it switches on, and what stops loading without it |
|---|---|
| `journeys` | Multi-page flows. The journey engine chunk |
| `print` | Printing the form. No file of its own |
| `translations` | Translations of the form's texts and the language switcher. No file of its own |
| `data-sources` | Option lists from data sources. No file of its own |
| `drafts` | Saving answers under a `draft` key. No file of its own |
| `server-validation` | A journey's server check (`validate-url`). The server validator chunk |
| `signing` | WebAuthn signing. The passkey chunk |
| `pdf` | The PDF action. The PDF service chunk, `datum-pdf.js` and `fonts/` |
| `wasm` | The in-page sandbox (`wasm="auto"`, for development and testing). `datum-wasm.js` |
| `agent` | Tools for a browser assistant, opt in only: `features="all agent"`. The agent chunk |

A feature with no file is a behaviour switch: leaving it out changes what the form does, and there is nothing to delete.

## The builder

The builder takes the same attribute with its own names. For each goal there is one recommended setting, and where `features` can do it, that is the setting.

| Goal | Setting | What stops loading |
|---|---|---|
| Only the form, nothing else | `features="minimal"` | Every optional part below |
| No PDF side | `features="-pdf"` | The PDF workspace and mode, the PDF module `datum-pdf.js` and `fonts/`. The largest part |
| No Journeys | `features="-journeys"` | The Journeys workspace and mode, and the journey engine chunks |
| No Logic workspace | `features="-logic"` | The Logic workspace. The inspector's Rules tab and the canvas's Add logic go with it |
| No Data workspace | `features="-data"` | The Data workspace |
| No Languages workspace | `features="-languages"` | The Languages workspace |
| No header and footer panel | `features="-header-footer"` | The Header & footer panel |
| No Variables panel | `features="-variables"` | The Variables panel |
| No Tests panel | `features="-tests"` | The Tests panel and its editor |
| No JSON view | `features="-json"` | The JSON view and editor, the code editor chunk |
| No command palette | `features="-palette"` | The command palette (Ctrl+K) |
| No Try it | `features="-try-it"` | Try it on the canvas |
| No data-model import | `features="-data-model"` | The Data workspace's import of a JSON sample or schema. No file of its own |
| No pointer to Languages under a component's texts | `features="-translations"` | No file of its own |
| No binding picker | `features="-binding-picker"` | The canvas's design-system picker. The `binding` property still sets the binding. No file of its own |
| No component id or data key in the inspector | `features="-advanced-fields"` | No file of its own |
| Agent tools over the builder | `features="all agent"` | Opt in only: the agent chunks load only when named |
| Only these component types | `component-types="text,select"` | Nothing: it filters the palette |
| No New, Open or Download | `file-actions="none"` | Nothing: it hides menu items |
| No Components, Outline, View, Settings or Form panel | `hidden-panels="outline view"` | A hidden panel is never loaded, but these five have no feature |

Take several away with one list: `features="-pdf -journeys -tests"`.

### The narrower switches

These can only take more away from what `features` allows. They never bring a part back.

| Attribute | Takes | What it does |
|---|---|---|
| `workspaces` | List of `form`, `logic`, `data`, `languages`, `journeys`, `pdf`, `print` | The only workspaces the bar offers. `pdf` or `journeys` alone is [that workspace on its own](/builder-element#one-workspace-alone). It does not remove the others' code |
| `hidden-workspaces` | List of `form`, `logic`, `data`, `languages`, `journeys`, `pdf`, `print` | Leaves workspaces off the bar. It does not remove their code |
| `hidden-panels` | List of `form`, `chrome`, `components`, `fields`, `outline`, `variables`, `tests`, `view`, `settings` | Leaves strip panels off. A hidden panel is never loaded and never the open one |
| `component-types` | List of types. A leading `-` drops a type, a trailing `*` matches a prefix | Restricts the palette. Exclusions win over inclusions. The property is `componentTypeFilter` |
| `file-actions` | `auto`, `none` or `off` (the same), or a list of `new`, `open`, `download` | Which of the builder's own file actions show |

Reach for these when the part must stay in the folder, for instance when one deployment serves the same files to two audiences. Only `features` lets a build step delete files, because `feature-files.json` is indexed by feature name.

### One part, two names

A feature and a strip panel can name the same part differently:

| Part | `features` name | Panel or workspace id |
|---|---|---|
| Header & footer panel | `header-footer` | panel `chrome` |
| Variables panel | `variables` | panel `variables` |
| Tests panel | `tests` | panel `tests` |
| Logic, Data, Languages, Journeys, PDF, Print | `logic`, `data`, `languages`, `journeys`, `pdf`, `print` | the same ids, as workspaces |
| Components, Outline, View, Settings, Form settings | none | panels `components`, `outline`, `view`, `settings`, `form` |

`palette` is the command palette (Ctrl+K), not the component palette that `minimal` keeps. `data-model` is the Data workspace's import. `translations` is the pointer line under a component's texts, not the Languages workspace.

## Deleting the files

`feature-files.json` in the bundle folder names, for each feature, the files only that feature fetches:

```json
{
  "features": {
    "journeys": { "bundle": "both", "files": ["datum-form-journey-engine-chunk-<hash>.js", "…"] },
    "pdf": { "bundle": "both", "files": ["datum-form-pdf-service-<hash>.js", "…"] }
  },
  "aliases": { "signing": "webauthn", "server-validation": "validate-url" }
}
```

Each entry says which bundle uses its files: `form`, `builder` or `both`. An alias names a feature whose files are another's. A feature with an empty `files` list has nothing to delete.

The Spring Boot and FastAPI hosts build this in. Their asset build takes `--omit-features`, and the files of those features never reach the host's folder:

```
npm run datum:build
npm run jvm:assets -- --omit-features=pdf,journeys
npm run fastapi:assets -- --omit-features=pdf,journeys
```

The PDF fonts always ship in a host, since the PDF program embeds the same faces. For a folder you serve yourself, a build step does the same:

```js
import { readFileSync, rmSync } from "node:fs";

const manifest = JSON.parse(readFileSync("dist/feature-files.json", "utf8"));
for (const feature of ["pdf", "journeys"]) {
  const name = manifest.aliases?.[feature] ?? feature;
  for (const file of manifest.features[name].files) rmSync(`dist/${file}`, { force: true });
}
```

Also:

- The manifest lists `pdf-pages`, the page images of a PDF template (`datum-pdf-pages.js` and `pdfjs/`), under a name of its own; remove it with the PDF side.
- Nothing asks for the deleted files, so nothing breaks.
- The classic-script bundles (`.iife.js`) carry their parts inside them and have nothing to delete.

## A file that is missing

A feature that is listed but whose file did not arrive, because it was not deployed or a content policy blocked it, is reported as `datum-error`.

- The part shows an error with **Retry** in its place, and the rest of the form or builder keeps working.
- A later attempt fetches the file again.
- The exception is the journeys file for a form that runs as a journey: that form cannot be drawn without it, so the whole form is replaced by an error card with **Retry**.

## Next

- What the bundle folder holds: [Files you host](/files).
- Setting the builder's first workspace, its look and its commands: [Customising the builder](/customising-the-builder).
