# ADR 0123: Button groups

## Status

Accepted.

## Context

A form's components stack one per row. Buttons are the exception people expect: Save beside
Cancel, Continue beside a "Save and come back later" link. Design systems document the pattern as
markup of its own: GOV.UK's `govuk-button-group` (a `div`), USWDS's `usa-button-group` (a `ul` of
`usa-button-group__item`s), and similar groups elsewhere.

Inferring a group in css from consecutive buttons guesses at intent: two buttons in a row are not
always a group, a hidden component between them breaks the guess, and css cannot turn buttons into
the list USWDS's markup is. So the author says what the group is, the renderer draws it, and a binding
draws it as its design system does. There is one way to group buttons; loose consecutive buttons
are not a group.

## Decision

1. **A layout container.** `button-group` (`BUTTON_GROUP_COMPONENT_TYPE` in
   `core/schema/button-group.ts`) holds buttons in one `content` slot (`BUTTON_GROUP_SLOT_ID`).
   The standard catalogue (`packages/datum/src/standard-components.ts`) registers it
   with that slot's `allowedTypes` set to `BUTTON_GROUP_CHILD_TYPES`, the `button` type. The
   link look is a button variant, not a type, so it is included.

   A new group is empty; its slot
   says "Drop buttons here." while empty (`emptyHint`). It has no settings of its own beyond
   what every component has: an id, CSS classes (its whole inspector, as the `steps`
   container's is), and rules. It has no label: a group of actions is not a fieldset, and it
   carries no role.

2. **The constraint is the builder's.** Every command that places a component checks the slot
   (`canAcceptInSlot`): add, drop, move, insert and replace refuse anything but a button in a
   group, with the refusal's reason in `dropError`. A definition written elsewhere that puts
   something else in a group is neither flagged nor dropped. The renderer draws it in the
   group, and the default PDF layout prints it in place (decision 6).

   This is how every other slot
   constraint behaves: a `steps` container's step-only slot and a PDF template's slots are
   checked by the commands, and no definition check or diagnostic reads them.

3. **The markup.**
   - The renderer draws the group as a container: its wrapper carries `data-container-id`, as
     every container's does, and holds what the binding's `button-group` adapter draws (a
     `GroupAdapter`), else Datum's. `data-component-id` marks a component's own controls: the
     renderer's focus lookup and the builder's node chrome read it, so the group never carries
     it.
   - Datum's adapter (`render/live/datum/buttons.ts`) by default draws
     `<div class="datum-form__button-group">`, then the buttons as they are drawn alone. The
     author's classes join the group's class.
   - Datum's stylesheet lays the group out as a wrapping row at the form's field gap, each child at
     its natural width and the list without markers or indent. No inline style, no layout class and
     no new design token, so a host restyles it with ordinary rules.
   - **`createDatumBinding({ controls: { buttonGroup: "div" | "list" } })`**, default `"div"`.
     Under `"list"` the group is a `<ul class="datum-form__button-group">`, each child in an
     `<li class="datum-form__button-group-item">`, for a look whose group is a list. A child
     that draws nothing (a hidden button) gets no item.
   - A group whose buttons are all hidden draws nothing, as any empty container does.
   - The builder canvas puts its drop zone and node chrome on the group's container (decision
     8), so the buttons stay the group's flex items on both surfaces.

4. **Every mode and every container.** A grouped button is drawn exactly as a lone button is in
   each mode: live, or disabled in a read-only review. Print leaves out every button and every
   button group (`render/print/model.ts`), so no empty row keeps its gap on paper. A group works
   inside a fieldset, a panel, a tab, a step and a grid column; a click on a grouped button acts as a lone button's does.

5. **No data.** A group has a `children` map, so it is a group to `core/tree/data-scope.ts`:
   no path segment and no place in the data. Only a data-scoping `container` adds a level.
   `data-scope.ts` is unchanged. A hand-written group without a `children` map would read as
   a leaf there, and in the kernel's copies of its group-type list (`submittable-fold.ts`,
   `journey-path.ts`). The builder always writes the map, and those lists stay as they are.

6. **Nothing on paper, and nothing unknown.**
   - The default PDF layout replaces a group with its children in place, never a section.
     Buttons are dropped, so a group of buttons leaves nothing, and the kernel never sees the
     group.
   - The group has a built-in rendition: `group`, its children with no heading, in
     `PDF_RENDITION_CATALOG` and `BUILT_IN_PDF_RENDITIONS`. A group bound under a panel in an
     authored layout therefore draws its children (buttons draw nothing) and raises no
     `component.unknown` (ADR 0043), even under `unknownComponents: "fail"`.
   - The kernel needs no code for it: the PDF program bundles the engine's model builder.

7. **Not a `LAYOUT_CONTAINER_TYPES` member.** That set (`render/core/component-model.ts`)
   feeds `layoutForNode`, which calls every member a grid of
   `configuration.columns` (default 2). A button group in it would report
   `{ kind: "grid", columns: 2 }`, which is wrong, and fixing that needs a second edit to
   `layoutForNode`. Nothing the group needs comes from the set:
   - the renderer draws it through its group adapter;
   - the default PDF layout has its own branch, ahead of the set's;
   - `ENGINE_COMPONENT_TYPES` knows the type through the always-container list;
   - `containerPath` is informational and read by nobody.

   The model keeps `layout: { kind: "stack" }` for a group. The adapter's own CSS is what
   lays it out.

8. **The builder.**
   - On the canvas the group's own element is its drop zone and its node: the drop axis is
     horizontal, so a button lands where the pointer is along the row. Under `"list"` the
     canvas draws the same `ul` and `li`s, and the drop marker counts the list items.
   - The palette entry is "Button group", after Grid in the Layout group (inferred from the
     type, key `buttongroup`). Its glyph is `container-row`, a name already in
     `DATUM_ICON_NAMES`, so no icon set has a new glyph to supply (ADR 0048).
   - Selection, move, delete and undo are the command model's, as for any container. Removing a
     container also clears a selection inside it. The outline
     lists the group as a container and the variables list walks through it and lists none of its
     buttons. The data model, which
     the builder draws and imports in the Data workspace, reads it as a group, since it has
     children; it has no text for the translations grid.

9. **Journeys and presentations.** A journey page draws the components it lists
   (`journeyPageComponents`, ADR 0112):
   - a listed group is drawn with its buttons;
   - a button listed alone is drawn without its group, so a binding must never assume a button
     has its group around it;
   - a page that lists a group, a container holding one, or the Submit alone is known to bring
     its own Submit (`buildJourneyMeta`), and draws no second one;
   - a presentation (ADR 0121) may hold its own group, and a Submit in it counts as the page's.

10. **Bindings draw the group their design system documents.** A binding's `button-group`
    adapter draws its design system's markup around the buttons it is handed: the reference
    bindings draw, for example, GOV.UK's `govuk-button-group` (`bindings/govuk`) and USWDS's
    `usa-button-group` list (`bindings/uswds`). A binding with no adapter for the type gets
    Datum's: a `div`, a wrapping row at the field gap, children at their own widths. Each grouped
    button is still drawn by the binding's `button` adapter.

## Consequences

- Authors group buttons on purpose, and a binding draws the group as its design system does: a
  `div` or a list, through one adapter and ordinary CSS.
- The builder refuses anything but a button in a group; a definition from elsewhere is drawn as
  written, never rewritten or refused.
- A group costs the renderer one container adapter and two CSS rules; it adds no token and no
  icon.
- No binding may assume a button has its group around it (decision 9).
