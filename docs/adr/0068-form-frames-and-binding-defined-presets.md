# ADR 0068: Form Frames — `chrome.frame` with Binding-Defined Presets

## Status
Accepted.

## Context

A form drawn with nothing around it is a bare grid on the page. Any border, shadow or padding it
seems to have is then the host's: a page's card, the builder's sheet. A page that wants the
form to read as paper over the page, as an outlined panel, or to sit seamlessly in the page would
write that itself, and the form's author would have no say. Hosts want those looks, a way to add
looks of their own, and a way to set a look as a default for forms that pick none or to fix one
on a page regardless.

## Decision

1. **The choice lives on chrome.** `chrome.frame` names a preset id: on the form root
   (`root.configuration.chrome.frame`, the author's pick, chosen in the builder's Form settings
   panel under Header & footer) and on the host's `chrome` (`<datum-form-renderer>`,
   `<datum-form-host>`, `<datum-form>`, whose `frame` and `frame-fixed` attributes are the short
   form). A frame is drawn *around* the form, and the host-versus-author negotiation is the kind
   of page-level relationship `chrome` already holds (`formChrome`, the switcher slot, ADR 0066).

2. **The host's frame is a default unless fixed.** `chrome.frame` takes a string (a default: the
   author's own pick, if any, wins) or `{ id, fixed: true }` (the host's wins on this page).
   `resolveFrame(host, form)` (`core/schema/form-chrome.ts`) is the whole rule: host when fixed or
   the form set none, else the form's, else `seamless`. It is independent of
   `formChrome: "exclude"`, which governs parts. A host that must show a plain form on its own
   card sets `{ id: "seamless", fixed: true }`.

3. **What a frame looks like is the binding's.** The renderer's chrome feature
   (`render/live/chrome.ts`) puts `datum-form--frame-<id>` and `data-frame` on the form element for
   any frame but `seamless`, which adds nothing.
   - The Datum binding draws three built-ins (`render/live/datum/frames.ts`): `seamless`, `outlined`
     (a bordered panel on the form's surface) and `paper` (a sheet with its own fill and shadow),
     from the frame tokens `color-frame-border`, `color-frame-surface`, `radius-frame`,
     `shadow-frame` and `spacing-frame-padding`, each falling back to a general token where one fits
     (the border colour, the surface), then the engine's literal.
   - `createDatumBinding({ frame })` names more presets, or restyles a built-in under its id: each
     is `{ label: LocalizedText; css?: string }`, its rules scoped to `.datum-form--frame-<id>` and
     adopted with the binding's sheet; the binding carries them as `DatumBinding.frames`.

4. **An id nothing draws is drawn seamless.** When neither the binding nor Datum's binding
   defines the resolved id, the form is drawn in the default frame and the renderer warns once
   for that id.

5. **The builder previews the frame.** The Form settings panel's Frame select defaults to "Not
   set (the host's frame)", which writes no `chrome.frame`, and lists `frameOptions` for the
   chosen binding: the built-ins, then the binding's own, relabelled where it says so. The canvas
   draws the frame through the renderer, and the sheet goes flush (border and shadow off, fill
   kept) whenever the form frames itself, so the author sees one frame.

## Reasoning

Presets rather than knobs: per-form overrides of padding, radius or shadow would make a frame a
pile of numbers rather than a promise each binding keeps in its own way. The frame lives on
`chrome` and on the binding, with no separate registry, so a host adds a look by configuring
the binding it already draws with.

## Consequences

- Nothing changes on a page until someone sets a frame: no class, no rule, no token read.
- Preset ids are binding-scoped: an author's "paper" is a promise each binding keeps its own way.
- Print and the PDF draw no frame: paper is the page (ADR 0035).
