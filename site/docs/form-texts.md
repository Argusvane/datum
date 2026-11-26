# The form's own words

The form says some things in its own voice:

- The Submitting line.
- The error summary heading.
- The Back and Continue buttons.
- The data grid's Add row.
- The character count.

These are not the definition's labels and not validation messages. Every one has a key, an English default and, where it carries a number or a name, slots. This page lists them all. The `texts` attribute and property change them.

## The value format

`texts` is an object from key to text. A text is a plain string, or an object with a default and a word per language:

```html
<datum-form src="/forms/intake.json" texts='{
  "submitting": { "default": "Sending your answers…", "locales": { "fr": "Envoi de vos réponses…" } },
  "back": "Previous"
}'></datum-form>
```

- The attribute takes the object as JSON. The `texts` property takes the object itself.
- The `locales` entry for a language is found by its exact tag, then by its primary language (`fr` for `fr-CA`), then the default is used.
- A key the object does not hold keeps its other wording.
- The order every source is read in is under [Where a word comes from](/languages#where-a-word-comes-from).

A slot is written `{{name}}` with double braces, and is filled when the text is drawn: `"{{n}} characters left"`.

- A slot the key does not provide is left as written.
- The builder's own texts use single braces; those are a different table.

The keys are the ones below.

- A key that is not on this page and that nothing words is shown as the key itself, so a mistyped key shows on the page instead of vanishing.
- A design-system binding may read keys of its own through the same object.

## Counted texts

A few texts depend on a number. Each has two keys, a general one and one for a count of one: `countLeft` and `countLeftOne`. They are listed as separate rows below.

Beside the pair, you can word a count by plural category, with a key written `base.category`, the dot being part of the key. The categories are `zero`, `one`, `two`, `few`, `many` and `other`, picked by the language's plural rules:

```json
{
  "countLeft.one": { "default": "{{n}} character to go", "locales": { "fr": "Encore {{n}} caractère" } },
  "countLeft.other": { "default": "{{n}} characters to go", "locales": { "fr": "Encore {{n}} caractères" } }
}
```

A category with no key reads `base.other`, and then the pair. The counted bases are:

- `summaryHeading`: its count is the number of errors.
- `countLeft` and `countOver`: the count is the number of characters.
- `tabHasErrors`.
- `fileAnnounced`: its pair is `fileAnnounced` and `fileAnnouncedMany`.
- The assistant lines `agentStopped`, `agentFilled`, `agentRowsAdded` and `agentUndone`.

A plain `summaryHeading` the page sets is used for a count of one too.

## The keys

### Status lines and the page around the fields

| Key | Default English | Slots | Where it appears |
|---|---|---|---|
| `submitting` | `Submitting…` | none | The line shown while a submit and its delivery are in flight. |
| `loading` | `Loading form…` | none | The placeholder shown before the first paint, and while `data-source-wait="all"` holds the form. |
| `checking` | `Checking your answers…` | none | The line shown while a journey's check against your server runs. |
| `serverUnavailable` | `We could not check your answers. Try again.` | none | What a journey says when that check could not reach your server. |
| `formNotShown` | `This form could not be shown. Check the connection and try again.` | none | The alert that takes the form's place when it could not be drawn at all. |
| `formPartlyShown` | `Part of this form did not finish loading, so it may not work as expected.` | none | The alert shown when part of the form did not finish drawing in time. |
| `definitionUnavailable` | `This form could not be loaded.` | none | The alert that takes the place of "Loading form…" when the form's definition could not be had from `src` (or the one given was refused). The reason goes to `datum-error`, not to this alert. Only the page's `texts` can word it, since no definition is there to carry a translation. An element that already shows a form keeps the form and shows no alert. |
| `journeysUnavailable` | `This form could not be loaded because part of it did not arrive. Check the connection and try again.` | none | The alert a form with journeys shows when the journeys file did not load, above the Retry button. |
| `retry` | `Try again` | none | The Retry button on that alert. |
| `pdfUnavailable` | `The PDF could not be created because part of the form did not load. Check the connection and try again.` | none | The alert the form's PDF button shows when the PDF file could not be loaded. |
| `fieldPending` | `Checking this answer…` | none | The note beside a field while a check of its answer runs, where the look has no spinner of its own. |
| `unknownComponent` | `Unknown component “{{type}}”` | `{{type}}` | What the form draws in place of a component whose type nothing registered. |
| `unknownComponentHint` | `This part of the form cannot be shown: nothing is registered for its component type. Register the plugin that provides it.` | none | The explanation under it. |

### Required and optional markers, errors

| Key | Default English | Slots | Where it appears |
|---|---|---|---|
| `required` | `*` | none | The marker after the label of a required field. |
| `optional` | (empty) | none | The marker after the label of an optional field. Empty by default. |
| `requiredNote` | (empty) | none | A sentence above the fields that explains the required marker. Empty by default, so nothing is drawn. |
| `errorPrefix` | (empty) | none | A visually hidden word read before an inline error. Empty by default. |
| `summaryHeading` | `{{count}} errors` | `{{count}}` | The error summary's heading. |
| `summaryHeadingOne` | `{{count}} error` | `{{count}}` | The same heading for one error. |
| `summaryEntry` | `{{label}}: {{message}}` | `{{label}}`, `{{message}}` | One line of the error summary. |

### Choices

| Key | Default English | Slots | Where it appears |
|---|---|---|---|
| `selectEmpty` | `Select…` | none | A select's empty first option, unless the component has a placeholder of its own. |
| `optionsLoading` | `Loading the choices…` | none | The line under a field while its data source has not answered. |
| `optionsFailed` | `The choices could not be loaded.` | none | The line under a field when its data source failed. |
| `optionsTruncated` | `Showing the first {{shown}} of {{total}} choices.` | `{{shown}}`, `{{total}}` | The line under a field whose list was cut to 5,000 items. |

### Files

| Key | Default English | Slots | Where it appears |
|---|---|---|---|
| `fileRemove` | `Remove` | none | A file row's Remove control. |
| `fileRemoveFile` | `Remove {{name}}` | `{{name}}` | The same control's accessible name. |
| `fileRemoved` | `File removed: {{name}}` | `{{name}}` | What the field's status region says once a file is removed. |
| `fileAnnounced` | `You have selected the file: {{names}}` | `{{names}}` | What it says once one file is picked. |
| `fileAnnouncedMany` | `You have selected {{count}} files: {{names}}` | `{{count}}`, `{{names}}` | What it says once several are picked. |
| `fileDownload` | `Download {{name}}` | `{{name}}` | The title of the link that downloads an embedded file. |
| `fileNone` | `No file` | none | What a read-only file field says when it holds nothing. |

### Dates

| Key | Default English | Slots | Where it appears |
|---|---|---|---|
| `dateDay` | `Day` | none | The label of a date's day box. |
| `dateMonth` | `Month` | none | The label of its month box. |
| `dateYear` | `Year` | none | The label of its year box. |
| `dateSelectMonth` | `Select a month` | none | The empty option of a month select. |

### Character count

| Key | Default English | Slots | Where it appears |
|---|---|---|---|
| `countUpTo` | `You can enter up to {{max}} characters` | `{{max}}`, `{{count}}`, `{{n}}` | The limit sentence a screen reader gets with the field's description. |
| `countEmpty` | (empty) | `{{max}}`, `{{count}}`, `{{n}}` | What an empty field shows. Empty by default, so the count then reads as the whole limit left. |
| `countLeft` | `{{n}} characters left` | `{{n}}`, `{{max}}`, `{{count}}` | The count while typing. |
| `countLeftOne` | `{{n}} character left` | `{{n}}`, `{{max}}`, `{{count}}` | The count when one character is left. |
| `countOver` | `{{n}} characters over limit` | `{{n}}`, `{{max}}`, `{{count}}` | The count past the limit. |
| `countOverOne` | `{{n}} character over limit` | `{{n}}`, `{{max}}`, `{{count}}` | The count when one character over. |

### Steps, pages and journeys

| Key | Default English | Slots | Where it appears |
|---|---|---|---|
| `stepOf` | `Step {{n}} of {{total}}` | `{{n}}`, `{{total}}` | The progress line of a steps container. |
| `stepTagSeparator` | `: ` | none | What a step's heading reads between its tag and its name. Visually hidden. |
| `stepCompleted` | `completed` | none | What the indicator says of a step the person has completed. |
| `stepNotCompleted` | `not completed` | none | What it says of a step not completed. |
| `stepFallback` | `Step {{n}}` | `{{n}}` | The name of a step its author left untitled. |
| `back` | `Back` | none | The Back button of steps and journeys. |
| `continue` | `Continue` | none | The Continue button. |
| `submit` | `Submit` | none | The button on the last page of a journey. |
| `pageOf` | `Step {{n}} of {{total}}` | `{{n}}`, `{{total}}` | The caption over a journey page's heading, unless the journey's `progress` is `none`. |
| `pageRedirected` | `The page you asked for is not available yet. This is the nearest page you can open.` | none | The line a journey page draws when the page asked for with `page` was not open to the answers and the person was put on the nearest page they can reach. |
| `workedOut` | `Worked out from your answers` | none | The line under a worked-out value, a read-only copy of a form field that a journey page computes. |
| `change` | `Change` | none | The link beside each answer on a Check answers page. It opens the page the answer was given on. |
| `changeHidden` | `Change {{label}}` | `{{label}}` | That link's whole name for assistive technology. The words after `change` are drawn visually hidden. |
| `notProvided` | `Not provided` | none | A Check answers page's value for an optional question left blank, unless the page leaves such answers out. |
| `enterAnswer` | `Enter {{label}}` | `{{label}}` | The link that takes the place of a required answer not given, on a Check answers page. It opens the page that asks it. |

### Tabs

| Key | Default English | Slots | Where it appears |
|---|---|---|---|
| `tabsContents` | `Contents` | none | The title over a tabs container's list of links where its panels stack. |
| `tabHasErrors` | `{{count}} errors` | `{{count}}` | What a tab says of the blocking errors in its panel, for a look whose tabs say it. |
| `tabHasErrorsOne` | `{{count}} error` | `{{count}}` | The same for one error. |
| `tabFallback` | `Tab {{n}}` | `{{n}}` | The name of a tab its author left untitled. |

### Data grid

| Key | Default English | Slots | Where it appears |
|---|---|---|---|
| `dataGridAdd` | `Add row` | none | The Add button. |
| `dataGridRemove` | `Remove` | none | Each row's Remove button. |
| `dataGridMoveUp` | `Move up` | none | Each row's Move up button. |
| `dataGridMoveDown` | `Move down` | none | Each row's Move down button. |
| `dataGridEmpty` | `No rows yet.` | none | The line shown in place of the rows when there are none. |
| `dataGridRow` | `Row {{n}}` | `{{n}}` | A row's name: the row header, and the error summary's "Row n: Label". |
| `dataGridActions` | `Actions` | none | The header of the column that holds the row buttons. |

### Notices and the confirmation

| Key | Default English | Slots | Where it appears |
|---|---|---|---|
| `confirmationTitle` | `Your form was submitted` | none | The title of the built-in confirmation (the `confirmation` attribute). |
| `confirmationMessage` | `Thank you. We have received your answers.` | none | Its message. |
| `confirmationReference` | `Reference` | none | The label of its reference line. |
| `noticeSuccess` | `Success: ` | none | The word read to assistive technology before a success notice, never drawn. |
| `noticeInfo` | `Information: ` | none | The same for an information notice. |
| `noticeWarning` | `Warning: ` | none | The same for a warning notice. |
| `noticeError` | `Error: ` | none | The same for an error notice. |

### Language

| Key | Default English | Slots | Where it appears |
|---|---|---|---|
| `languageSwitcher` | `Language` | none | The label of the form's own language switcher. |
| `languageSelection` | `Language selection` | none | The hidden heading over language links. |
| `localeLabel` | `Form locale` | none | The title of the locale select of the engine's form host element, which `datum-form.js` does not include. |

### Help and images

| Key | Default English | Slots | Where it appears |
|---|---|---|---|
| `tooltipHelp` | `Help` | none | The accessible name of the help mark beside a label. |
| `imageEmpty` | `No image URL` | none | The caption of an image component with no usable URL. |

### Printed form

| Key | Default English | Slots | Where it appears |
|---|---|---|---|
| `printOnlyIf` | `Complete only if it applies to you.` | none | The note beside a field that prints while a rule hides it, when its author wrote none. |
| `printEmpty` | `Not answered` | none | What a printed answer left empty says. |
| `printPageNumber` | `Page {{page}} of {{pages}}` | `{{page}}`, `{{pages}}` | The page number line at the end of the printed footer, until the form's own footer text replaces it. |
| `printChosen` | `Chosen` | none | The word a chosen option carries in print. |
| `printRowNumber` | `#` | none | The heading of a printed data grid's row number column. |

### Toolbar labels of the engine's form host element

| Key | Default English | Slots | Where it appears |
|---|---|---|---|
| `validateLabel` | `Validate` | none | The Validate button. `datum-form.js` does not include this element; the keys exist for hosts that build with the engine's host element. |
| `printLabel` | `Print` | none | The Print button. |
| `printAnswers` | `Answers` | none | The Print menu's choice for a record of the answers. The menu shows when the form offers more than one version. |
| `printBlank` | `Blank form` | none | The Print menu's choice for a blank paper form. |
| `printFilled` | `Filled-in form` | none | The Print menu's choice for the paper form with the answers written in. |
| `pdfLabel` | `PDF` | none | The PDF button. |
| `downloadPdfLabel` | `Download PDF` | none | The Download PDF button. |
| `pdfLayoutLabel` | `PDF layout` | none | The label of its PDF layout picker. |

### Browser assistants

| Key | Default English | Slots | Where it appears |
|---|---|---|---|
| `agentBannerLabel` | `Assistant` | none | The accessible name of the banner shown while an assistant works on the form. |
| `agentBanner` | `An assistant is working on this form: {{purpose}}` | `{{purpose}}` | The banner's line. |
| `agentStop` | `Stop` | none | The banner's Stop button. |
| `agentAllowAgain` | `Allow the assistant again` | none | The button that lets the assistant carry on after Stop. |
| `agentUndoAll` | `Undo all` | none | The Undo all button. |
| `agentDismiss` | `Dismiss` | none | The Dismiss button. |
| `agentSessionStarted` | `An assistant started working on this form: {{purpose}}. Press Stop to take over.` | `{{purpose}}` | What the live region says when an assistant starts. |
| `agentSessionEnded` | `The assistant finished: {{summary}}` | `{{summary}}` | What it says when the assistant finishes. |
| `agentSessionEndedAfterRestore` | `A saved draft replaced the answers; earlier changes cannot be undone.` | none | The ended banner's line when a restored draft replaced the answers, so earlier changes cannot be undone. |
| `agentStopped` | `The assistant was stopped; {{count}} changes were undone` | `{{count}}` | What it says when the assistant is stopped and its changes were undone. |
| `agentStoppedOne` | `The assistant was stopped; {{count}} change was undone` | `{{count}}` | The same for one change. |
| `agentPaused` | `The assistant paused` | none | What it says when the assistant pauses. |
| `agentFilled` | `An assistant filled {{count}} fields` | `{{count}}` | What it says when the assistant filled fields. |
| `agentFilledOne` | `An assistant filled {{count}} field` | `{{count}}` | The same for one field. |
| `agentRowsAdded` | `An assistant added {{count}} rows to {{label}}` | `{{count}}`, `{{label}}` | What it says when the assistant added rows. |
| `agentRowsAddedOne` | `An assistant added {{count}} row to {{label}}` | `{{count}}`, `{{label}}` | The same for one row. |
| `agentRowRemoved` | `An assistant removed a row from {{label}}` | `{{label}}` | What it says when the assistant removed a row. |
| `agentMoved` | `An assistant moved to {{title}}` | `{{title}}` | What it says when the assistant moved to another page. |
| `agentLanguage` | `An assistant switched the form to {{label}}` | `{{label}}` | What it says when the assistant switched the language. |
| `agentUndone` | `{{count}} changes by the assistant were undone` | `{{count}}` | What it says when the person undid the assistant's changes. |
| `agentUndoneOne` | `{{count}} change by the assistant was undone` | `{{count}}` | The same for one change. |
| `agentSubmitted` | `An assistant submitted the form` | none | What it says when the assistant submitted the form. |
| `agentDraftSaved` | `An assistant saved your draft` | none | What it says when the assistant saved the draft. |
| `agentDraftRestored` | `An assistant restored your saved draft` | none | What it says when the assistant restored the draft. |
| `agentDraftCleared` | `An assistant deleted your saved draft` | none | What it says when the assistant deleted the draft. |
| `agentPdfDownloaded` | `An assistant downloaded a PDF of the form` | none | What it says when the assistant downloaded a PDF. |

## Next

- Where texts are translated for each language: [Languages](/languages).
- The confirmation these keys word: [Submissions and replies](/submissions#after-acceptance).
- The attributes that carry `texts`: [The form element](/form-element).
