# ADR 0049: Authored validation messages on the component tree

## Status

Accepted.

## Context

Validation errors travel as codes with parameters (ADR 0001), and the text a person reads
for a code is resolved by `resolveValidationMessage` from a `ValidationMessageCatalog` of
code → `LocalizedText`. A form author must be able to word "this field is required" for their
own form, and for one field in particular, without coordinating with the embedding page's
technical team. A page that embeds a form also words it: a site hosting many forms keeps one
catalog of wording (`<datum-form messages>`), and the page is where the person reading the
form is known (its house style, its legal wording, its plain-language rules). The page already
has the last word on a form's labels through its `translations`.

## Decision

1. **`configuration.messages` on any component.** A component's configuration may carry
   `messages?: Record<string, string>`, keyed by error code, each the text in the form's
   default language (other languages: decision 6). The
   form root's `messages` are the form's defaults; a container's apply to everything inside
   it; a field's to itself. There is no new `FormDefinition` key: the map lives with the
   root's `title` and `print` settings, so undo/redo, locale removal (ADR 0158), schema files
   and the builder's definition round trip already carry it, and a container's entry needs
   nothing registered. `readValidationMessages(configuration)` reads it.

2. **The page first, then nearest.** For an error on a component the catalogs layer, the
   winner first: the page's `messages`, then the component's own, then each container's up to
   the root (`layerValidationMessages`; `createComponentMessageResolver` in
   `render/core/error-wording.ts` resolves each component once). An error naming no component
   is worded from the page's catalog over the root's messages.

   A code the page's catalog does
   not name keeps the form's words; a page entry, once it names a code, wins for every
   component. Where no catalog names the code, the form's texts word it (`error.<code>`,
   by the field's label) unless the error carries its own `message`, and past those the
   error's own `message` and the engine's sentence decide, in the order
   `resolveValidationMessage` gives them; the bare code is the last resort.

3. **Why the page wins.** The page's wording and the form's are both deliberate, so one rule
   has to settle a clash, and it is the rule `translations` already follows: what the embedding
   page hands the element beats what the definition carries for the same text. A page that
   wants the author's words for a code leaves that code out of its catalog. A single rule for
   every kind of word means a host never has to learn which kinds the author can lock, and no
   switch is needed to say which side wins.

4. **`patternMessage` stays, as the field's `pattern` message.** The field keeps its own
   editor, the validation kernels still resolve it into `parameters.message` (so raw error
   consumers see it), and `readValidationMessages` reads it as the field's `pattern` entry
   when `messages.pattern` is absent. It therefore ranks with the field's other messages:
   under a page's `pattern` entry, over the form's texts and the engine's sentence.

5. **One table editor for options and messages.** The builder's keyed-text editor
   (`OptionsEditorKind`: `options` or `messages`) edits a component's message map: a Code
   column, a meaning column and a Message column (the default language; translations are typed in
   Languages, ADR 0158). Every code the component's own checks
   can raise (`validationCodesRaisedBy`, read from the same constraints the stage enforces, the
   whole form's on the root) opens as a row, blank until worded: a blank row writes nothing, so
   the page's or the engine's text applies, and it can be cleared but not removed. The other
   codes (`ENGINE_VALIDATION_CODES`, and the codes the host named through `validationCodes`) sit
   under the table as chips, behind a disclosure on a field; the code box stays free text. A host
   may hand its wording along with its codes (`HostValidationCode.message`) and the editor shows
   it as the blank row's placeholder. A `messages-editor` property field (`messagesCapability`,
   on for every value-bearing field by default and off for a button; `FORM_ROOT_FIELDS` carries
   it for the form root) puts the "Edit messages..." row in the Validation section. The editor
   is described in `docs/translation-support.md`, "Validation messages".

6. **Messages translate like every other text.** A message's other languages live in the
   definition's translations map under `messages › <code>` for the owning component (ADR 0158),
   and `readValidationMessages` resolves each entry for the run's locale before the catalogs
   layer. The page's own catalog stays host data (`LocalizedText` per code).

## Consequences

- The schema carries a form's own validation wording, and a form authored with messages
  reads that way under every page that does not word the same codes. A page's catalog is
  site-wide wording: every code it names reads the page's way on every form it embeds, so a
  catalog that names `required` replaces each field's own `required` message.
- A page that wants only to fill gaps names only the codes the forms leave unworded.
- Binding and plugin adapters receive each error already worded for their component (the field
  state's errors and joined `message`) and need no logic of their own.
