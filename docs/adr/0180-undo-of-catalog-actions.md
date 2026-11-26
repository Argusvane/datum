# ADR 0180: Undo of catalog actions

## Status

Accepted.

## Context

A form's journeys and PDF layouts are the documents of two designer modes, each document edited by a controller of its own (ADR 0115, ADR 0044). The catalog of those documents is part of the form's definition. A journey or a layout added, copied, renamed, removed or made the default is a change of the form, and it often rewrites the form's translations with it.

Undo has to take back what the author did, whole, whichever designer is on the page, and the form's Undo has to reach the same steps. Two things would break that: a designer's tree keeping an entry of its own for what the catalog or the form wrote into it, so that the tree's Undo and the form's Undo both take it back; and one catalog action reaching the form's history in several pieces.

## Decision

1. **Every catalog action is one step of the form's history.**
   - Journeys: a journey added (New journey, a host's `addJourney`), copied, replaced (a rename, a host's `replaceJourney`) or removed, the default journey and what the form opens as (`setDefaultJourney`, `setOpensAs`, `chooseOpensAs`).
   - PDF layouts: a layout added (New layout from the form or blank, a template layout, a host's `addLayout`), copied, renamed, removed or given another id (`replaceLayout`), the default layout and the try order (`setDefaultLayout`, `moveLayout`). A host's `replaceLayout` under the same id is none: a new name alone is the rename's (decision 3), and any other change starts the layout's designer over.
   - Each is one step whether or not a translation moves with it, and one Undo takes it back with its translations. A template layout's step holds the layout with its template source, mappings and areas, so Redo brings back a layout its designer reads the same PDF for.
   - The Form panel's Opens-as row commits the default as a journey is chosen (ADR 0115, decision 10), which is one step. Its Save then writes what the form opens as, one step more when that changes. A Save with no journey chosen before it, which may write both, is one step.
   - Create form fields adds form fields and mappings, never a layout, and is no catalog action.

2. **One action, one entry, however many writes.** Each catalog action runs as one run (`formSteps.stepped`) inside `BuilderController.joinSteps`. The first step its run records (its translations rewrite) is the entry, and the block's change over the run and every other step the run causes from then on join it, a plain edit of the form's included. The entry is one step to whoever counts steps (an agent's `undo.steps`, Undo all): the parts it takes in publish no mutation of their own.

   A host's `onChange` handler that calls another catalog action while one runs, either way round, puts that action's change, its translations included, in the same entry: one Undo takes both back, one Redo makes both again. A plain form edit the handler makes before the run's first step (the mode reports its change ahead of its translations rewrite, and an action with no translations records its step only as the run ends) is an entry of its own, under the action's. The entry is recorded and held whole even when a listener throws partway through the run.

3. **A rename is a step of the form's history, never of a designer's tree.** A journey or a PDF layout renamed from the documents menu, by a host (`renameJourney`, `renameLayout`) or by an agent (`documents { rename }`) is one step of the form's history whether the document's designer is built or not, so the designer on the page and the Form workspace reach it alike.

   `BuilderController.setPropertyUnrecorded` writes the name into a built tree's root without an entry, as every write of a name from the catalog does: a host's replace, Make default and the Languages workspace's Apply of a default, and the form's Undo and Redo putting a name back. The tree's Undo never takes a name back on its own, nor after the form's Undo did.

   A name typed in the designer's own box (the Journey panel's "Journey name", the inspector's "Layout name") is an edit of that tree like any other field: one entry of the tree's history, which the catalog follows.

4. **A form rename reaches open journey trees and built PDF layout trees, their unsaved parts included**, such as a route with no target yet or a condition held on a layout's Rules tab. The trees take it with no entry of their own (`BuilderController.setProperties(edits, { unrecorded: true })`): the form's rename is the step.

   The rename's Undo and Redo write the journeys' follow-up again (`renameStepped`). A PDF layout's follow-up is one part of the rename's own entry, the catalog's change and the trees' together (`followFormStep` in `pdf-builder-mode.ts`): its Undo and Redo follow the rename the way the step goes in every built tree, a custom layout's and a populated form's, then carry onto the catalog what no tree holds (a layout never opened). A move of data (a data key changed, ADR 0109, decision 10) is followed the same way in the path sources and collection paths.

   So one Undo, from the Form workspace or from the designer on the page, takes the rename back in every journey and every layout, and Redo makes it again in all of them.

   A component's rename and every rewrite it makes is one `RenameStep` (`builder/history/rename-step.ts`): the id itself, then each follow-up command joined to the step (`CommandHistory` hands a command run while the step is joining to it instead of making an entry). Undo takes the parts back last first and Redo makes them again in order, and a part that fails rolls the parts already done back. A step the tree can no longer take (it changed behind the history's back) is never thrown at the bar's Undo or Redo: the tree stays as it was, the steps beyond it in that direction are dropped, and the canvas says why ("This step could not be undone, nor can the ones after it").

5. **An agent's undo and restore go through a catalog seam.** `applyCatalogForAgent` keeps the designers and their histories as a catalog action does, and is no step of the form's history unless translations move with it (a document taken away or brought back with its wording). Then its translations rewrites are one step that holds the catalog's change as well, however many documents come back worded, so its Undo takes the whole change back, never the wording alone. The designer on the page holds that step as it holds a catalog action's.

   An agent's catalog action that is a step of the form's history is taken back by that step alone: its outside-journal entry records the steps (`stepped`) and has no inverse of its own. A restore with no wording to bring back writes no step, so its entry is journaled with an inverse instead: one record either way. An inverse the journal does run goes through the catalog seam, never the mode's own removal, which is a step (ADR 0155).

6. **A catalog action is announced as a change of the form.** Its step is one change event of the form's controller (reason `"edit"`, as a translations rewrite's), so in the Form workspace, where a host's or an agent's `journeyMode.removeJourney` or `pdfMode.removeLayout` lands, the bar's Undo and a host following the form's changes see it. A part an entry takes in is announced by none of its own, and a step a rename's history entry takes in is that rename's change.

7. **A designer's Undo reaches the form's steps made there.** The bar's Undo on a designer steps the document on the page, whose controller never held those steps, so each mode answers `BuilderMode.history` with the form's steps made while it is on the page (`history/form-steps-on-page.ts`): every catalog action, its own mode's or the other's (a host removing a journey while a PDF layout is up), any step made from a panel over the designer (a test removed in the Tests panel), and in Journeys every form step made in the Step view, whose own history is asked first while it is up.

   The mode's own follow-ups of an edit on the page (its translations, the block carried) are that edit's and are never held on their own: the page's own Undo of the edit takes its follow-up back off the form's history (`formSteps.followUp`), and its Redo makes it again, so neither history gets an entry the other does not account for. A step stays held for as long as the form's history keeps its entry.

8. **A held step is taken back in order.** A step is held with the undo and redo marks of every document controller the mode has, as they stand when the step is made and each time it is undone or redone, wherever that is done. Each mode hears the form's history until it is disposed (the Journeys mode from when it is made, the PDF mode from its first activation), so a held step the Form workspace's Undo takes back is reached by Redo on the designer's page.

   Undo takes it back while it is the form's newest step and none of those controllers has moved since. A controller made or built afresh since counts as unmoved while its history is empty, and a write with no entry moves none. So inside one designer workspace Undo takes back the newest thing done, on whichever document or view it was done: an edit made on any document after the held step goes first, from whichever document is on the page, and the held step is reached again once nothing newer is left, on whichever document the page then shows; two documents deleted in a row come back newest first; a test removed in the Step view is taken back from the map, ahead of an older edit of the journey. Redo goes the same way and also asks that no controller's redo side has moved: an edit made after the step was undone, even one undone in turn, ends that step's Redo, as a new step does in any history.

   A deleted document that Undo brings back, or an added one that Redo makes again, is put back in the list, and the page stays on the document it landed on. A document added or copied that was on the page and is taken back leaves the page where deleting it would: on the first document left. A document the page only falls back to keeps its designer and its history.

9. **A held step has limits.** A step made in another workspace is newer than anything held, so nothing held is taken back from a designer until that step is. A step is held only by the designer on the page when it was made: a test removed while the PDF designer is on the page is not reached from Journeys. An edit on the page whose own translations follow-up is a step of the form's history (a node with translated wording deleted) puts that follow-up above a held step until the page takes the edit back, which takes the follow-up back with it; a follow-up the form's history no longer has next in order is not stepped, and taking the edit back writes a follow-up of its own, which sits above the held step as the other workspace's step does. The Form workspace's Undo steps the form's history alone, newest first, and reaches every step of it in order, these included; a document's own edits are its designer's.

## Reasoning

- **What a tree takes from the catalog or the form takes no entry.** A name the catalog writes into a built tree, or an id a form rename writes into a journey's or a layout's, is derived from the step that caused it, whose Undo and Redo write it again. An entry of the tree's for it would let the tree's Undo take it back alone, leaving the tree and the catalog or the form apart, and the form's Undo then take it back a second time.
- **A layout's tree moves before the catalog on a rename's Undo and Redo.** A built tree writes its layout into the catalog as it hears its own edit, so following the rename in the trees first leaves the catalog's carry nothing to do for them. A catalog write over a layout whose tree has not moved reads as a change underneath the designer, which builds it again and loses its history.
- **One action, one entry, however many writes.** An author who presses Undo once expects the thing they did to come back whole. A host handler that reacts to a change is part of that change, so its writes from the action's first step on join the action's entry instead of leaving an entry that takes back half of it. A page edit's follow-up on the form is part of that edit the same way, so the page's Undo takes it back rather than writing its inverse over whatever the designer holds beneath it.

## Consequences

- One Undo takes back a catalog action with its translations and every tree it touched, from either workspace, and one Redo makes it again.
- An agent counts a catalog action as one step, and its undo and restore leave the designers and their histories as the author's own actions do (ADR 0155).
- A removal that Undo takes back asks in place instead of in a dialog (ADR 0179); decisions 7 to 9 say where a designer's Undo reaches it and where it does not.
