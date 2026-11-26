# ADR 0111: The inspector: its subject, its drafts and its problems

## Status

Accepted.

## Context

An inspector that edits the selected component and falls back to the form itself when nothing is selected does two unrelated jobs. The fallback is invisible: a canvas click that happens to miss a component silently swaps the whole panel for a different subject, and reaching the form's own settings means first working out how to deselect. The form's settings are therefore a panel of their own (ADR 0103), and two panels edit at once.

A draft the builder cannot save (an id another component holds, a CSS class the renderer would drop, a data key that clashes) could disable the panel's Apply. If a message is drawn far from the box it is about, the author types an id, sees Apply go grey, and has nothing near the button saying why; a disabled button cannot take focus, so a keyboard or screen reader user hears nothing at all. No box is marked invalid for assistive technology either.

Problems are also per component. A builder-wide id error, class error and data key error that follow the selection would be read by the Form panel and the Header & footer panel too, so a clashing id typed for a field would disable the Form panel's Apply and print the field's error there.

The builder cannot know where a host saves, so what a draft's commit does has to be worded for what it does. A commit on a form of 200 fields has to stay quick, and the size of the JSON editor does not belong in the builder's entry.

## Decision

1. **Each problem sits under its own box.** The id's message is under the id box. Every box a problem names is marked `aria-invalid="true"` and described by the message (`aria-describedby`), so focusing it reads what is wrong. A rule whose formula does not parse is a problem too, as is JSON in the inspector's JSON view that does not parse (with its line and column): Apply would otherwise quietly keep the last text that did.

2. **Apply is never disabled by a problem; it leads to it.** Pressing Apply (or Enter) with a problem applies nothing: the panel opens the problem's tab and section, clears a filter that hides the box, scrolls the box into view, focuses it, and says "Not saved: 1 problem. …" in a live region, as an invalid submit takes a person to the first invalid field (ADR 0001). Apply stays disabled only while there is nothing to apply.

3. **A line above Apply says what is wrong.** In the pinned footer, directly above Apply and Discard: one problem shows its message ("1 problem: ID "city" already exists."), and pressing it goes to the box (`data-problem-go`); several show their count, which opens a list of them, each a way to its box. The footer's button row keeps its one line at the inspector's default width.

4. **Problems are asked per component.** `BuilderController.problemsOf(componentId)` lists what holds that component's draft back, in the order of their boxes, and is cached until the next change. Each panel asks about the component it shows: the inspector about the selection, the Form panel and the Header & footer panel about the root. A field's problem never holds the Form panel's Apply back, and a panel is not repainted by another component's problem. The single `idError`, `cssClassError` and `dataKeyError` fields stay for hosts that read them, as the selection's. A tree's owner adds its own problems and advisory notes through the controller's `problems` and `notes` options (a journey page id that another page already has); a note is drawn under its box and never holds Apply back.

5. **The Header & footer panel's Apply goes to the Form panel.** It shares the root's draft but not the boxes the root's problems sit under, so its Apply, and the count beside its Not applied, open the Form panel at the first problem (`builder-open-panel` with `panel: "form"`).

6. **The unsaved-changes prompt lists the problems.** When the author clicks away from a draft that cannot be saved, the prompt names what is wrong, its Apply stays refused, and Keep editing goes to the first problem.

7. **Duplicate ids load as problems.** A definition with two components under one id opens in the builder. `problemsOf` says so on the id box of each twin, and Apply is not refused for it; the summary line and Apply lead to the box, as for any problem here.

8. **Reserved words.** `component`, `host`, `row`, `ancestor`, `constructor` and `prototype` cannot be a component id: the first four are the roots of a rule's paths, so an answer keyed by one could not be read back, and the last two cannot key the translations map. The inspector, the agent's tools, the inspector's JSON view and Open refuse one with a single sentence that names the word. The kernel's structure pass reports `component.id.reserved` for all six, and `component.id.invalid` is the grammar only.

   `__proto__`, `constructor` and `prototype` cannot be a PDF layout id, a journey id or a journey page id either, since texts kept under such a name could never be translated; the kernel's structure pass reports `pdf.layout.id.reserved`, `journey.id.reserved` and `journey.page.id.reserved`, and the builder refuses them on load and on every write. The four words that root a rule's paths are free as layout, journey and page ids.

9. **Inverted limits warn.** A field whose minimum is above its maximum (`minLength` over `maxLength`, `min` over `max`, and the row bounds as ADR 0153 reads them) gets the warning `component.limits.inverted`, naming the field. It is a note under the field's box in the inspector, never an entry of the Problems list, so it does not hold Apply back. The agent's `check_form` lists it once, from the kernel's structure pass. A run still ignores the pair.

10. **The form's panel is the inspector element, scoped.** `DatumBuilderPropertiesElement` has `subject: "selection" | "root"`, and `<datum-builder-form-panel>` (`DatumBuilderFormPanelElement`) is that element fixed to `"root"`. Every property control, the chrome-parts editor, the options and messages editors, the Identity and Localization handlers and the draft footer are therefore the same code in both places, and a property editor lands in both without being written twice.

    The tag is its own, not an attribute on the inspector, because the two are different panels in different columns: a page or a test reaching for `datum-builder-properties` means the inspector, and with one element used twice would find whichever came first in the shell's markup.

    The root is not a lesser subject. The form's panel offers the same tab strip as the inspector (Settings, then Rules while the root can carry rules, and the JSON behind the ⋯ menu), because the root carries the `visibleWhen`, `enabledWhen` and `readonlyWhen` gates every field under it inherits, and its JSON is the root's own: dropping those tabs there would have made both unreachable. It has no Style tab, no collapse control (its strip item is the toggle) and no Delete (the root cannot be removed). A head above the tabs names what it edits, "Form settings" or the mode's own word, which the inspector leaves to its tabs; with two inspectors on screen the tabs alone would not say which tree's root this one is for. The panel draws as floating cards (`data-floating`), as the inspector does.

11. **The inspector column comes and goes with the selection.** With nothing selected it draws nothing, and the shell takes its column and its grip away so the canvas has the width; the column returns at its remembered width and fold the moment something is selected. Selecting the root (the outline's first row, the canvas's root) opens the Form panel rather than the inspector, so the root is edited in exactly one place while the canvas still outlines it.

12. **The controller names its subject.** There is no single "inspected component": two panels edit at once. `editedNode(id?)` and `inspectorModel(id?)` take the subject and default to the selection; `commitDraft(id?)` and `discardDraft(id?)` do the same. `hasPendingChanges()` with no id means any draft is dirty, what a host's "is anything unsaved here" flag wants; with an id it asks about that component.

13. **The guard asks about what is actually disappearing.**
    - Moving around the tree (selecting, adding) asks about the selection's draft alone: the root's belongs to the Form panel, which stays on screen with its own Apply and Discard, so a prompt there would be about an edit the author can still see.
    - Leaving the builder (`requestLeave`) asks about the selection and then the root, since it takes both away.
    - Moving from the Form panel or the Header & footer panel to another panel asks about the root's unapplied edits (`requestPanelLeave`, held action `panel`, worded "before opening another panel"; the prompt names the root "The form's settings"), since the panel is the one going away.

    Each panel draws only the prompt naming its own subject.

14. **The inspector's tabs.** A component's inspector has Field, Style and Logic tabs under a head that names the component and its type; the form's panel keeps its own tab strip (decision 10). Style holds the presentation and PDF sections and the classes the canvas's binding declares (`LiveBinding.cssClasses`, `BuilderController.styleOptions`, ADR 0162) that apply to the component, as named toggles. Classes of one group are one radio choice with a Default that clears it. There is no free class picker. Logic counts the component's rules and is ADR 0140's formula editor for each rule. The JSON is behind the ⋯ menu.

15. **Saves to.** A form component always shows where its answer is stored, as a labelled, read-only text box (`readonly`, never `disabled`, so the path can be selected) with its `?` note.

16. **Apply and Discard commit a draft; Save is the host's.** The draft's commit is Apply and Discard, with "Not applied" beside them while it holds changes. The Header & footer panel and the Languages workspace say the same. The leave prompt is "Changes not applied" with Keep editing, Discard and Apply. `requestLeave(run)` and `hasUnsavedChanges()` ask about drafts.

17. **An edit taken back is no edit.** A draft value counts as no change when it matches the saved value, compared with key order ignored. It also counts as none when the form sets nothing there and the value is what the panel shows for that: the field's declared default, or else a blank box or an unticked switch. The draft then holds the saved value or no key at all, so "Not applied" and the prompt clear.

18. **JSON is edited through the draft.** For a component, and for the Form panel's root, ⋯ then Edit JSON shows `{ id, type, configuration, rules? }`. Edits go into the draft (changed configuration keys, with deleted keys removed; the rules; the id, where the ID row allows it), so Apply, Discard and the prompt cover them. The type cannot change. Children (and `collection`) are left out of the text, because applying them would be a second undo step outside the draft; the box says "Children are edited on the canvas." Parse and shape problems show under the box with their line and column (decision 1); the draft keeps the last text that applied, and Apply leads to the problem. The editor is the lazy CodeMirror editor, editable, with its own undo; a plain textarea stands in until it loads, and the editor is lifted out and put back across the panel's repaints so the caret, scroll and undo survive typing.

19. **A dialog the inspector opens returns focus.** The options and messages dialogs give focus back to the button that opened them, with `preventScroll`, so the panel does not scroll up.

20. **The inspector is one panel of floating cards.** The shell marks its drawer `data-floating` and draws no frame; the panel draws the cards in its place (decision 10): the head with the tabs, the ID and Saves to rows together, a card per section, rule or note, and Apply and Discard in a card of their own. It is still one panel with one Apply. The column takes its content's height up to the drawer's and its body scrolls; the canvas takes the pointer under a short column, in CSS alone, with nothing measured. The inspector's grip shows its hairline only while hovered or held, since one drawn the drawer's height would cross the canvas under a short column; the side column's grip draws its own always (ADR 0103, decision 5).

21. **The inspector's costs stay small.** The JSON boxes' editor (CodeMirror) loads on first use from its own chunk (`json-viewer-loader.ts`), and the plain JSON shows until it arrives. The renderer does not paint for a hook, renderer or show-hidden change while a rebuild is on its way, and the canvas sets each of the renderer's inputs only when it changed (hooks are reused by a structural key).

## Reasoning

- **Apply and Discard for drafts, Save for the host.** The builder cannot know where a host saves, so the draft's commit is worded for what it does.
- **Style offers a binding's named options only.** A class picker invites scraped class names that a binding does not own.
- **JSON in the draft.** Editing JSON through the draft, rather than writing to the controller, keeps one Apply, one undo step and one leave guard for every way of editing a component.

## Consequences

- An author who meets a refused Apply is told why beside the button and taken to the box, by mouse or keyboard, and a screen reader hears the message with the box.
- Tests and hosts that look for a disabled Apply on an unusable id find an enabled Apply, the summary line, and the draft still pending after pressing it.
- A problem the root can have with no box to fix it in (a malformed root CSS class from an imported definition) is announced and counted, but has nowhere to be edited except the JSON.
- An author laying out a form sees the canvas at full width until they select something, and can keep form settings open beside the canvas while editing a field. The two panels hold their own drafts, which `drafts` is keyed to allow.
- `hasPendingChanges()` without an id covers a draft left open on a component neither panel is showing; callers wanting one component name it.
- One custom element (`datum-builder-form-panel`, exported from the engine's builder index) is the form's panel for a host that wants it on its own.
