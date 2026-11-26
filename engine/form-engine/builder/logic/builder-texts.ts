/**
 * The builder's own words: one catalog of
 * dotted, stable keys with English built in, which a host extends per locale the way a form's
 * texts are (`FormTextCatalog`). A host sets `{ fr: { "rule.show.when": "Afficher {target}
 * lorsque {condition}" } }` and the builder's locale picks it, falling back key by key.
 *
 * Every sentence is a template with named slots, never words glued together in code: the
 * order of the slots is the language's to choose, so a translation can put the condition
 * before the field. Lists go through `Intl.ListFormat` ("A or B", "A ou B") and counts through
 * `Intl.PluralRules`, so neither is spelt out in English rules either.
 *
 * Pure and dependency-free: the Logic workspace's model reads it in node, and the builder's
 * chrome reads it in the browser.
 */

/**
 * The shell chrome's words (the activity strip, the Outline, Components, Variables, Settings,
 * View, Header and footer panels, the Data and Languages surfaces), kept in one block of their
 * own and spread into the catalog below. English only here; a host adds its locales.
 */
const SHELL_EN = {
  "shell.panel.form.label": "Form settings",
  "shell.panel.form.title": "Form settings",
  "shell.panel.form.short": "Form",
  "shell.panel.chrome.label": "Header and footer",
  "shell.panel.chrome.title": "Header & footer",
  "shell.panel.chrome.short": "Header",
  "shell.panel.components.label": "Components",
  "shell.panel.components.title": "Components",
  "shell.panel.components.short": "Add",
  "shell.panel.fields.label": "Form fields",
  "shell.panel.fields.title": "Form fields: put the form's fields on this step",
  "shell.panel.outline.label": "Outline",
  "shell.panel.outline.title": "Outline",
  "shell.panel.variables.label": "Variables",
  "shell.panel.variables.title": "Variables",
  "shell.panel.tests.label": "Tests",
  "shell.panel.tests.title": "Tests: scenarios that pin the form's rules",
  "shell.panel.view.label": "View",
  "shell.panel.view.title": "View",
  "shell.panel.settings.label": "Settings",
  "shell.panel.settings.title": "Settings",
  "shell.noController": "No builder controller.",
  "shell.command.showPanel": "Show the {panel} panel",
  "shell.command.add": "Add {type}",
  "shell.rail.label": "Add a component",
  "shell.rail.add": "Add {type}",
  "shell.rail.addTitle": "{type}: click to add, or drag onto the form",
  "shell.rail.all": "All components",
  "shell.rail.allShort": "Add",
  "shell.sheet.grab": "Drag to close or tap to expand",
  "shell.sheet.grabTall": "Drag to close or tap to shrink",
  "shell.sheet.results": "Try it results",
  "shell.sheet.results.preview": "Preview results",
  "components.title": "Components",
  "components.filter.placeholder": "Filter components…",
  "components.filter.label": "Filter components",
  "components.skip": "Skip to canvas",
  "shell.fields.title": "Form fields",
  "shell.fields.filter.label": "Filter fields",
  "shell.fields.filter.placeholder": "Filter fields…",
  "shell.fields.notPlaced": "Not on a step",
  "shell.fields.placed": "On a step",
  "shell.fields.here": "On this step",
  "shell.fields.required": "Required",
  "shell.fields.none": "No field matches.",
  "shell.fields.empty": "The form has no fields to put on a step.",
  "shell.fields.add": "Add {field} to this step",
  "shell.fields.added": "{field} added to this step.",
  "outline.title": "Outline",
  "outline.journeyNote": "Every page and step of the journey, in the order it is drawn.",
  "view.title": "View",
  "view.width.label": "Preview width",
  "view.width.fit": "Fit page",
  "view.width.custom": "Custom",
  "view.width.tip": "Preview width — {choice}",
  "view.theme.label": "Design system",
  "view.theme.name": "Design system",
  "view.theme.tip": "Design system — {choice}",
  "view.showHidden.label": "Show components a rule hides",
  "view.showHidden.note": "Drawn faded while their rule hides them, so you can reach and edit them. Try it shows the form as a person sees it.",
  // The same row where the shell leaves a part out: no Try it to name, or no rules to speak of.
  "view.showHidden.label.noLogic": "Show hidden components",
  "view.showHidden.note.preview": "Drawn faded while their rule hides them, so you can reach and edit them. Preview shows the form as a person sees it.",
  "view.showHidden.note.noLogic": "Drawn faded while the form hides them, so you can reach and edit them.",
  "view.chrome.legend": "Form chrome",
  "view.chrome.note": "As the page showing the form sets it. For the preview only: the form keeps its own settings.",
  "view.chrome.frame": "The page's frame",
  "view.chrome.fixed": "The page fixes its frame",
  "view.chrome.parts": "Show the form's header and footer",
  "view.chrome.switcher": "Show the form's language switcher",
  "settings.title": "Settings",
  "settings.language.title": "Language",
  "settings.language.note": "The language the canvas shows the form in. The form's languages and translations are in Languages.",
  "settings.language.select": "Show the form in",
  "settings.language.default": "Form default ({language})",
  "settings.language.none": "The form is in one language. Add others in Languages.",
  "settings.submit.title": "Submitting in Try it",
  "settings.submit.hint": "These values are what Try it uses, in Form, Logic, Journeys and PDF.",
  "settings.submit.note": "What Submit does while you try the form: a stand-in for the page's server. The form keeps none of it.",
  "settings.submit.outcome.label": "What the server does",
  "settings.submit.outcome.accept": "Accepts the form",
  "settings.submit.outcome.refuse": "Refuses the form",
  "settings.submit.outcome.fail": "Cannot be reached",
  "settings.submit.delay.label": "How long it takes (milliseconds)",
  "settings.submit.delay.note": "From 0 to 10000.",
  "settings.submit.status.legend": "Where \"Submitting…\" shows",
  "settings.placement.top": "Top",
  "settings.placement.bottom": "Bottom",
  "settings.submit.statusText.label": "Status text",
  "settings.submit.statusText.placeholder": "Submitting…",
  "settings.submit.statusText.note": "Blank uses the form's own wording.",
  "settings.receipt.legend": "The receipt, when the server accepts",
  "settings.receipt.kind": "Kind",
  "settings.receipt.kind.success": "Success",
  "settings.receipt.kind.info": "Information",
  "settings.receipt.title": "Title",
  "settings.receipt.message": "Message",
  "settings.receipt.detailLabel": "Reference label",
  "settings.receipt.reference": "Reference",
  "settings.receipt.reference.note": "{n} becomes six random digits. Blank, the receipt shows no reference.",
  "settings.receipt.placement": "Where the receipt shows",
  "settings.refusal.label": "Refusal message",
  "settings.afterAccept.label": "After the server accepts",
  "settings.afterAccept.editable": "Keep the answers editable",
  "settings.afterAccept.readonly": "Show the answers read only",
  "settings.sources.title": "Data sources",
  "settings.sources.note": "The lists the form's choices come from. Give one a list of your own to try the form with it; the form and the page keep theirs.",
  "settings.sources.none": "The form takes no choices from a data source yet.",
  "settings.sources.state.simulated": "Simulated",
  "settings.sources.state.host": "From the page",
  "settings.sources.state.missing": "Not provided",
  "settings.sources.options": "Options for {id}",
  "settings.sources.format": "One option a line, as value | label. A JSON list of { \"value\", \"label\" } works too.",
  "settings.sources.use": "Use this list",
  "settings.sources.cancel": "Cancel",
  "settings.sources.edit": "Edit the list",
  "settings.sources.simulate": "Simulate",
  "settings.sources.clear": "Stop simulating",
  "settings.host.title": "Host values",
  "settings.host.note": "What the page gives the form under host., for example host.role. Give some here to try a rule that reads them; the form and the page keep none of it.",
  "settings.host.label": "Host values (a JSON object)",
  "settings.host.placeholder": "{ \"role\": \"admin\" }",
  "settings.host.reads": "A rule or calculation in this form reads host values.",
  "settings.host.problem.json": "This is not valid JSON, so the last good values stay in use. {reason}",
  "settings.host.problem.object": "Host values are a JSON object, such as { \"role\": \"admin\" }, so the last good values stay in use.",
  "settings.host.problem.left": "Left out, because JSON cannot carry it: {details}",
  "variables.title": "Variables",
  "variables.filter.placeholder": "Filter",
  "variables.filter.label": "Filter variables",
  "variables.none": "Nothing matches.",
  "variables.noFields": "No fields yet.",
  "variables.copy": "Copy {reference}",
  "variables.copied": "Copied {reference}",
  "variables.copyFailed": "Could not copy {reference}",
  "variables.intro.rules": "A rule is a formula: it names fields and calls functions, such as age(birthDate) >= 18. A field is its id wherever it sits. Click one to copy it.",
  "variables.intro.placeholders": "What a text block, a signature caption or a mapped field's text may hold. Click one to copy it.",
  "variables.intro.print": "What a printed header or footer line may hold: the form's values, and the names below. Click one to copy it.",
  "variables.intro.conditions": "A journey's condition is a formula over the form's answers, each field by its id. The row., ancestor., host. and component paths are not available here. Click one to copy it.",
  "variables.link.reference": "Formula reference",
  "variables.alias.rowNumber": "Entry number",
  "variables.alias.rowNumber.note": "counted from 1",
  "variables.alias.rowIndex": "Entry index",
  "variables.alias.rowIndex.note": "counted from 0",
  "variables.alias.rowCount": "Number of entries",
  "variables.scope.component": "This component's own value",
  "variables.scope.part": "One part of this component's value",
  "variables.scope.part.note": "when the value is an object",
  "variables.scope.row": "A field of the current entry, by its key within the entry",
  "variables.scope.row.note": "inside a repeating section",
  "variables.scope.ancestor": "The value of a container this component is inside",
  "variables.scope.host": "A value the host passes in",
  "variables.group.fields": "Fields",
  "variables.group.scopes": "Scopes",
  "variables.group.page": "Page",
  "variables.group.page.note": "In a header or footer only",
  "variables.group.print": "Print",
  "variables.group.print.note": "In a header or footer line",
  "variables.print.title": "The form's title",
  "variables.print.date": "The day it is printed",
  "variables.print.receipt": "A value from the receipt the host shows",
  "variables.group.host": "Host",
  "variables.group.logic": "Logic",
  "variables.group.text": "Text",
  "variables.group.number": "Numbers",
  "variables.group.list": "Lists",
  "variables.group.date": "Dates",
  "variables.group.scope": "Repeating sections",
  "variables.group.plugins": "Plugins",
  "variables.function.variadic": "takes any number of arguments",
  "variables.page.number": "This page's number",
  "variables.page.count": "The number of pages",
  "variables.host.value": "A value the host passes when it renders",
  "variables.field.section": "repeating section: its entries",
  "variables.ancestor.note": "the enclosing {label} entry",
  "variables.collection.title": "In {label}",
  "variables.collection.note.placeholders": "Inside a repeat or a table bound to this section",
  "variables.collection.note.entry": "Inside an entry of this section",
  "chrome.title": "Header & footer",
  "chrome.tablist": "Header and footer",
  "chrome.tab.parts": "Parts",
  "chrome.more": "More",
  "chrome.viewJson": "View JSON",
  "chrome.json.label": "Header and footer JSON (read only)",
  "chrome.hint": "What the form shows above and below its fields, each part on a row of its own, in this order; a group puts its parts side by side. Texts are in the default language — their translations are in Languages. The application showing the form may add parts of its own after these.",
  "chrome.notPrimary": "The header and footer belong to the form. Open the form's tab to edit them.",
  "chrome.region.header": "Header",
  "chrome.region.footer": "Footer",
  "chrome.empty.header": "Nothing in the header yet. Add a part below.",
  "chrome.empty.footer": "Nothing in the footer yet. Add a part below.",
  "chrome.group.empty": "Nothing in this group yet.",
  "chrome.add.type": "Type of part to add",
  "chrome.add.typeGroup": "Type of part to add to the group",
  "chrome.add.button": "Add part",
  "chrome.add.group": "Add to group",
  "chrome.move.upLabel": "Move part {n} up",
  "chrome.move.up": "Move up",
  "chrome.move.downLabel": "Move part {n} down",
  "chrome.move.down": "Move down",
  "chrome.remove.label": "Remove part {n}",
  "chrome.remove": "Remove",
  "chrome.partType.form-title": "Form title",
  "chrome.partType.form-description": "Form description",
  "chrome.partType.heading": "Heading",
  "chrome.partType.text": "Text",
  "chrome.partType.html": "HTML",
  "chrome.partType.image": "Image",
  "chrome.partType.language-switcher": "Language switcher",
  "chrome.partType.group": "Group (parts side by side)",
  "chrome.field.part": "Part",
  "chrome.field.place": "Place",
  "chrome.field.label": "Label (default: Language)",
  "chrome.field.hideLabel": "Hide the label (keep it for screen readers)",
  "chrome.field.src": "Image URL",
  "chrome.field.src.placeholder": "https://… or /logo.svg",
  "chrome.field.alt": "Alternative text",
  "chrome.field.href": "Link (optional)",
  "chrome.field.width": "Width (px)",
  "chrome.field.height": "Height (px)",
  "chrome.field.text": "Text",
  "chrome.field.html": "HTML (links, lists and emphasis are kept; scripts are not)",
  "chrome.field.html.label": "HTML",
  "chrome.field.level": "Level",
  "chrome.field.spread": "Spread",
  "chrome.field.lineUp": "Line up",
  "chrome.field.description": "The description from Form settings.",
  "chrome.choice.default": "Default",
  "chrome.choice.start": "Start",
  "chrome.choice.center": "Center",
  "chrome.choice.end": "End",
  "chrome.choice.levelDefault": "Default (h{level})",
  "chrome.choice.spaceBetween": "Space between",
  "chrome.choice.justifyDefault": "Default (space between)",
  "chrome.choice.middleDefault": "Default (middle)",
  "chrome.choice.top": "Top",
  "chrome.choice.middle": "Middle",
  "chrome.choice.bottom": "Bottom",
  "chrome.notApplied": "Not applied",
  "chrome.problems.title": "Open the Form panel at the problem",
  "chrome.problems.one": "{count} problem",
  "chrome.problems.other": "{count} problems",
  "chrome.discard": "Discard",
  "chrome.apply": "Apply"
} as const;

const EN = {
  ...SHELL_EN,
  // Conditions: one comparison each, joined by the join words.
  "cond.join.and": "and",
  "cond.join.or": "or",
  // Counts shown across the builder.
  "problems.count.one": "{count} problem",
  "problems.count.other": "{count} problems",
  // Formula parse errors, one per `FormulaErrorCode` (`core/expressions/formula-types.ts`); the
  // `.end` form words the same code at the end of the formula, where there is no token.
  "formula.err.unexpected": "Unexpected {token}.",
  "formula.err.unexpected.end": "The formula could not be read.",
  "formula.err.expectedValue": "A value is missing at the end of the formula.",
  "formula.err.expectedValueHere": "A value is missing before {token}.",
  "formula.err.expectedOperator": "Something is missing between the values, before {token}.",
  "formula.err.unclosedParen": "Expected {expected} but found {token}.",
  "formula.err.unclosedParen.end": "Missing {expected} at the end of the formula.",
  "formula.err.unmatchedParen": "A closing parenthesis has no opening one.",
  "formula.err.unterminatedString": "A quoted text has no closing quote.",
  "formula.err.curlyQuote": "{token} is a curly quote; use straight quotes.",
  "formula.err.unterminatedName": "A backticked name has no closing backtick.",
  "formula.err.emptyName": "A backticked name is empty.",
  "formula.err.badChar": "{char} is not part of a formula.",
  "formula.err.unknownFunction": "No function is called {name}.",
  "formula.err.arity": "{name} takes {expected} arguments, not {got}.",
  "formula.err.arity.one": "{name} takes {expected} argument, not {got}.",
  "formula.err.arity.other": "{name} takes {expected} arguments, not {got}.",
  "formula.err.arityMin": "{name} needs at least {min} arguments; {got} given.",
  "formula.err.betweenAnd": "Expected and after the lower bound, before {token}.",
  "formula.err.betweenAnd.end": "Expected and after the lower bound of between.",
  "formula.err.inList": "Expected a list in parentheses after in, before {token}.",
  "formula.err.inList.end": "Expected a list in parentheses after in.",
  "formula.err.intervalDots": "Expected .. between the bounds of a range, before {token}.",
  "formula.err.intervalDots.end": "Expected .. between the bounds of a range.",
  "formula.err.ifThen": "Expected then after the condition, before {token}.",
  "formula.err.ifThen.end": "Expected then after the condition.",
  "formula.err.chainedCompare": "Comparisons cannot be chained; join them with and.",
  "formula.err.numberTooLarge": "The number {token} is too large to be a number.",
  "formula.err.badUnit": "{name} takes days, weeks, months or years as its unit, not {unit}.",
  "formula.err.tooDeep": "The formula nests more than {max} levels deep.",
  "formula.err.invalidRule": "The {key} rule is a {got}, not a formula.",
  "field.pattern.risky": "This pattern repeats a repeat (or a back-reference), which can take very long on some answers; the form does not run it unless the host allows risky patterns. Rewrite {pattern} so no repeated group holds a repeat.",
  "formula.err.runScope": "The {key} rule runs in the browser by nature; it cannot run {run}.",
  "formula.unknownField": "No field is called {name}.",
  "formula.unknownField.hint": "Did you mean {suggestion}?",
  "formula.hyphenHint": "Write {left} - {right} with spaces to subtract.",
  // The formula editor's words.
  "editor.readsAs": "Reads as",
  "editor.placeholder": "Type a field name, or pick one with + Field",
  "editor.tryOne": "Try one:",
  "editor.failed": "The formula editor could not load; the plain box still works.",
  "editor.retry": "Retry",
  // Where a rule runs.
  "run.both": "Browser and server",
  "run.browser": "Browser only",
  "run.server": "Server only",
  "run.secret": "Server only, secret",
  "run.both.hint": "Checked while filling and again when submitted",
  "run.browser.hint": "Guides the person; the server does not enforce it",
  "run.server.hint": "Applied when submitted; the browser shows nothing",
  "run.secret.hint": "Also left out of the form sent to browsers",
  "run.fixedBrowser": "Browser",
  "run.fixedBrowser.hint": "Defaults and option filters run in the browser by nature",
  "run.secret.note": "Try it shows the server's result only. A PDF printed from the browser leaves this field blank.",
  // Try it.
  "try.title": "Try it",
  // The function table's groups and the Helpers menu.
  "fn.group.logic": "Logic",
  "fn.group.text": "Text",
  "fn.group.number": "Numbers",
  "fn.group.list": "Lists",
  "fn.group.date": "Dates",
  "fn.group.scope": "Scope",
  "fn.group.plugin": "Plugins",
  "snippet.group.answers": "Answers",
  "snippet.group.choices": "Choices",
  "snippet.group.dates": "Dates",
  "snippet.group.cases": "Cases",
  "snippet.group.plugin": "Plugins",
  "snippet.isAnswered": "Is answered",
  "snippet.isEmpty": "Is empty",
  "snippet.anyOf": "Is any of",
  "snippet.between": "Is between",
  "snippet.allTicked": "All of these ticked",
  "snippet.anyTicked": "Any of these ticked",
  "snippet.noneTicked": "None of these ticked",
  "snippet.atLeastTicked": "At least N ticked",
  "snippet.withinDays": "Within the last N days",
  "snippet.beforeDate": "Before a date",
  "snippet.ageAtLeast": "Age at least",
  "snippet.weekend": "Falls on a weekend",
  "snippet.ifThenElse": "If … then … else",
  "snippet.cases": "Several cases",
  // The Form settings panel's formula errors setting.
  "settings.formulaErrors.label": "Formula errors",
  "settings.formulaErrors.hint": "What a runtime does with a formula problem. Fail, the default, refuses; Warn is for preview and staging.",
  "settings.formulaErrors.fail": "Fail",
  "settings.formulaErrors.fail.hint": "The form refuses to run until the formula is fixed",
  "settings.formulaErrors.warn": "Warn",
  "settings.formulaErrors.warn.hint": "The rule is dropped and the run log says so",
  // The Form settings panel's Browser assistants setting: the author's agentTools switch.
  "settings.agentTools.label": "Assistants in the browser",
  "settings.agentTools.hint": "Whether an assistant in the person's browser may fill this form for them. Each site decides whether it offers assistants at all.",
  "settings.agentTools.unset": "Not set",
  "settings.agentTools.unset.hint": "Sites that follow the form's setting keep assistants off this form; a site can still allow them on every form.",
  "settings.agentTools.allowed": "Allowed",
  "settings.agentTools.allowed.hint": "Assistants may fill this form where the site offers them.",
  "settings.agentTools.off": "Not on this form",
  "settings.agentTools.off.hint": "For forms the person must complete themselves, such as declarations. Sites that follow the form's setting keep assistants off it; a site can still allow them on every form.",
  // The Variables panel per workspace.
  "variables.data.intro": "What the form saves: each answer at the path it is stored under, a data key when it has one, else its id. Click one to copy it.",
  "variables.data.group": "Saved values",
  "variables.data.note.key": "{type}, id {id}, data key {key}",
  "variables.data.note.plain": "{type}",
  "variables.data.section": "Repeating section: its entries are saved here",
  "variables.journey.pages": "Steps",
  "variables.journey.pages.note": "A step by its id, and where a route may go",
  "variables.journey.page": "Step",
  "variables.journey.end": "The end of the journey",
  "variables.journey.own": "The journey's own",
  "variables.journey.own.note": "Fields the steps own and the form fields they work out, by id",
  "variables.journey.own.field": "Field of its own, {type}",
  "variables.journey.own.alias": "Stands for the form field {target}",
  "variables.journey.own.worked": "Worked-out value: a condition reads the form field by this id",
  // Translation editing in the builder.
  "i18n.tab.noLabel": "Tab {n} has no label, so the form shows it as “Tab {n}”. Give it one in its tab label.",
  // The component pointer line under its texts, in the Form panel: "Translated in fr" or the missing count.
  "inspector.pointer.done": "Translated in {languages}",
  "inspector.pointer.missing": "{language} {count} missing",
  "inspector.pointer.open": "Open in Languages",
  "inspector.pointer.openPart": "Open in Languages: {part}",
  // The PDF designer
  "pdf.layout.quoted": "\"{name}\"",
  "pdf.layout.fromForm": "a layout derived from the form",
  "pdf.rules.when": "Print this layout when",
  "pdf.rules.whenHint": "A download that names no layout prints the first layout, in the list's order, whose condition holds; otherwise the default prints. Off: this layout prints only when asked for by id, or as the default.",
  "pdf.finding.invalid": "The condition on {name} is not one the engine can evaluate, so it never holds: build it again, or mend its expression.",
  "pdf.finding.scope": "The condition on {name} reads {path}. A layout's condition reads the form's answers by component id; row., ancestor., host. and component paths are not available to it, so it reads nothing there.",
  "pdf.finding.unknownField": "The condition on {name} reads {path}, which is not a component of the form, so it always reads as unanswered.",
  "pdf.finding.entryField": "The condition on {name} reads {id}, which is part of each entry of {section}, so it always reads as unanswered. A layout's condition cannot read a field of each entry, or count a section's entries, today.",
  "pdf.finding.section": "The condition on {name} reads {id}, a repeating section, which reads as nothing here: its entries travel one by one, so len({id}) is 0. A layout's condition cannot count a section's entries today.",
  "pdf.finding.shadowed": "{name} is tried after {earlier}, whose condition {holds}, so {name} never prints by its own condition.",
  "pdf.finding.holds.always": "always holds",
  "pdf.finding.holds.same": "is the same",
  "pdf.finding.template": "{name} fills a PDF the definition does not hold ({storage}: {pdfName}). Which layout prints now depends on the answers, so every host that prints this form must be able to resolve it.",
  "pdf.finding.defaultConditional": "{name} is the default and has a condition: the condition only sets where it is tried; it still prints whenever no condition holds.",
  "pdf.finding.noDefault": "Layouts here have conditions, but the form declares no default: when none holds, the first layout, {name}, prints. Choose one with \"Set as default\" in a layout's menu.",
  "pdf.order.none": "No layout has a condition: a download that names none prints {name}, the default.",
  "pdf.order.chosen": "Chosen by the answers: {steps} Otherwise: {name}.",
  "pdf.order.step": "{index}. {name}, {condition}.",
  "pdf.condition.none": "no condition",
  "pdf.condition.never": "a condition that never holds",
  "pdf.condition.when": "when {words}",
  "pdf.condition.custom": "a custom condition",
  "pdf.rulesNote.reads": "A layout's condition reads the form's answers as they would be submitted, by component id — not which journey was taken; row., ancestor. and host. paths are not available, and fields are named by id, not by the {{…}} placeholders the layout's text uses.",
  "pdf.rulesNote.tried.default": "Its condition is tried {ordinal} of {count}; when none holds, this layout prints anyway: it is the default.",
  "pdf.rulesNote.tried": "Its condition is tried {ordinal} of {count}; when none holds, {fallback} prints.",
  "pdf.rulesNote.defaultConditional": "It has no condition and is the default: it prints when no layout's condition holds.",
  "pdf.rulesNote.default": "It is the default: a download that names no layout prints it.",
  "pdf.rulesNote.byId": "With no condition, it prints only when a host asks for it by id; when no condition holds, {fallback} prints.",
  "pdf.ordinal.one": "{n}st",
  "pdf.ordinal.two": "{n}nd",
  "pdf.ordinal.few": "{n}rd",
  "pdf.ordinal.other": "{n}th",
  "pdf.label.withId": "{label} ({id})",
  // The workspace surfaces
  "phoneMenu.row": "{label}, {problems}",
  "phoneMenu.button": "Menu. {workspace} workspace, {problems}",
  "phoneMenu.button.plain": "Menu. {workspace} workspace",
  "settings.formulaErrors.title": "Formulas",
  "settings.agentTools.title": "Browser assistants",
  "themeClasses.sep": ", ",
  "themeClasses.invalid.one": "{list} is not a valid class name.",
  "themeClasses.invalid.other": "{list} are not a valid class name.",
  "themeClasses.unknown.one": "{list} is not one of the binding's classes.",
  "themeClasses.unknown.other": "{list} are not among the binding's classes.",
  "snippet.blank.field": "field",
  "snippet.blank.box": "box",
  "snippet.blank.group": "group",
  "snippet.blank.date": "date",
  "snippet.blank.dateOfBirth": "date of birth",
  "snippet.blank.condition": "condition",
  "snippet.blank.value": "value",
  "snippet.blank.number": "N",
  "snippet.blank.a": "a",
  "snippet.blank.b": "b",
  // Journeys
  "journey.designer.ui.when-the-server-cannot-be-reached": "When the server cannot be reached",
  "journey.designer.ui.journey-name": "Journey name",
  "journey.designer.ui.what-the-journey-picker-and-this-builder-s-list-ca": "What the journey picker and this builder's list call it. Renaming keeps the journey's id.",
  "journey.designer.ui.back-button": "Back button",
  "journey.designer.ui.continue-button": "Continue button",
  "journey.designer.ui.submit-button-the-last-page": "Submit button (the last step)",
  "journey.designer.ui.page-count-caption": "Step count caption",
  "journey.designer.ui.write-n-and-total-where-the-numbers-go": "Write {{n}} and {{total}} where the numbers go.",
  "journey.designer.ui.while-the-server-checks": "While the server checks",
  "journey.designer.ui.title": "Title",
  "journey.designer.ui.the-page-s-heading-blank-its-first-question-s-labe": "The step's heading. Blank: its first question's label.",
  "journey.designer.ui.description": "Description",
  "journey.designer.ui.submit-button": "Submit button",
  "journey.designer.grid.label": "Label",
  "journey.designer.grid.journey": "Journey “{name}”",
  "journey.designer.grid.page": "{name} · Step {number} · {title}",
  "journey.designer.grid.reviewRow": "Check answers row: {field}",
  "journey.mode.view.group": "What the canvas shows",
  "journey.mode.opensAs.label": "The form opens as",
  "journey.mode.opensAs.whole": "The whole form",
  "journey.mode.view.map": "Map",
  "journey.mode.view.mapTitle": "See every way a person can move through the steps",
  "journey.mode.view.step": "Step",
  "journey.mode.view.stepTitle": "Edit one step as the person sees it: its fields, heading and buttons",
  // Other texts
  "dataModel.gen.noEntries": "Nothing on the form holds the entries of {path}.",
  "dataModel.gen.noContainer": "No container on the form stands for {path}, so there is nowhere to put it.",
  "dataModel.gen.notObject": "The form holds {path} as something other than an object.",
  "dataModel.gen.nowhere": "Nowhere to put it.",
  "dataModel.gen.nothingBuilt": "Nothing can be built for it.",
  // Language lifecycle
  "languages.pdf.group": "PDF layout · {name}",
  "languages.pdf.name": "Layout name",
  "languages.pdf.title": "Document title",
  "languages.pdf.attachment": "Attachment description",
  "languages.pdf.reason": "Signature reason",
  "languages.pdf.heading": "Heading",
  "languages.pdf.text": "Text",
  "languages.pdf.fieldLabel": "Label override",
  "languages.pdf.emptyText": "Text when empty",
  "languages.pdf.alt": "Alternative text",
  "languages.pdf.caption": "Signature caption",
  "languages.pdf.fill": "Text filled into {name}",
  "shell.bar.undo": "Undo",
  "shell.bar.undo.tip": "Undo (Cmd/Ctrl+Z)",
  "shell.bar.redo": "Redo",
  "shell.bar.redo.tip": "Redo (Cmd/Ctrl+Shift+Z)",
  "shell.bar.search": "Search commands",
  "shell.bar.search.tip": "Search commands (Cmd/Ctrl+K)",
  "shell.bar.workspace": "Workspace",
  "shell.bar.fullWindow": "Full window",
  "shell.bar.leaveFullWindow": "Leave full window",
  "shell.workspace.form": "Form",
  "shell.workspace.logic": "Logic",
  "shell.workspace.data": "Data",
  "shell.workspace.languages": "Languages",
  "shell.workspace.journeys": "Journeys",
  "shell.workspace.pdf": "PDF",
  "shell.workspace.print": "Print",
  "shell.strip.panels": "Panels",
  "shell.file.dismiss": "Dismiss",
  "shell.file.menu": "Menu",
  "shell.file.save": "Save",
  "shell.file.saving": "Saving…",
  "shell.file.new": "New form",
  "shell.file.open": "Open form file…",
  "shell.file.download": "Download form",
  "shell.file.cancel": "Cancel",
  "shell.file.input": "Form file",
  "shell.file.saveFailed": "Could not save: {reason}.",
  "shell.file.noSubmitWarning": "This form has no Submit button, so nobody can send it. Add a Button from All components, under Layout, and set its action to Submit form.",
  "shell.file.readFailed": "Could not read \"{name}\": {reason}.",
  "shell.file.openFailed": "Could not open \"{name}\": {reason}.",
  "shell.file.noDownload": "Downloads are not available here.",
  "shell.file.unreadable": "the file could not be read",
  "shell.file.newConfirm.message": "Start a new form in place of this one? Its components, languages and layouts are replaced, and this can't be undone.",
  "shell.file.newConfirm.ok": "Start a new form",
  "shell.file.openConfirm.title": "Open form file",
  "shell.file.openConfirm.message": "Replace this form with \"{name}\"? This can't be undone.",
  "shell.file.openConfirm.ok": "Replace",
  "shell.bottom.try": "Try it",
  "shell.bottom.preview": "Preview",
  "shell.bottom.results": "Results",
  "shell.bottom.more": "More",
  "shell.sheet.close": "Close",
  "shell.sheet.closeNamed": "Close {name}",
  "shell.sheet.closeSettings": "Close settings",
  "shell.sheet.settings": "Settings",
  "shell.sheet.try": "Try it",
  "shell.sheet.try.preview": "Preview",
  "shell.sheet.panelFallback": "panel",
  "shell.more.title": "More panels",
  "shell.menu.close": "Close menu",
  "shell.menu.host": "From the page",
  "shell.menu.workspaces": "Workspaces",
  "shell.menu.layouts": "Layouts",
  "shell.menu.journeys": "Journeys",
  "shell.menu.thisDocument": "This {noun}",
  "shell.menu.allLayouts": "All layouts",
  "shell.menu.allJourneys": "All journeys",
  "shell.menu.canvas": "Canvas",
  "shell.menu.file": "File",
  "shell.menu.tools": "Tools",
  "shell.menu.tryIt": "Try it",
  "shell.menu.preview": "Preview",
  "shell.menu.backToEditing": "Back to editing",
  "shell.menu.trySettings": "Try it settings",
  "shell.menu.showHidden": "Show hidden components",
  "shell.menu.darkMode": "Dark mode",
  "shell.menu.lightMode": "Light mode",
  "shell.menu.zoomIn": "Zoom in",
  "shell.menu.zoomOut": "Zoom out",
  "shell.menu.fit": "Fit to width",
  "shell.menu.search": "Search commands…",
  "shell.menu.unsaved": "Changes not saved",
  "shell.menu.saved": "All changes saved",
  "shell.phone.backPlace": ". Back to {place}",
  "shell.phone.backTitle": "Back to {place}",
  "shell.phone.place.layouts": "the layouts",
  "shell.phone.place.journeys": "the journeys",
  "shell.phone.place.overview": "the overview",
  "shell.doc.default": "Default",
  "shell.doc.noun": "document",
  "shell.doc.kind.pdfLayout": "PDF layout",
  "shell.doc.rename": "Rename…",
  "shell.doc.duplicate": "Duplicate",
  "shell.doc.moveUp": "Move up",
  "shell.doc.moveDown": "Move down",
  "shell.doc.setDefault": "Set as default",
  "shell.doc.delete": "Delete…",
  "shell.doc.deleteNamed": "Delete \"{name}\"",
  "shell.doc.deleteNote": "The {noun} goes, with its translations. Undo brings it back.",
  "shell.doc.options": "{noun} options",
  "shell.doc.name": "{noun} name",
  "shell.doc.place": "{name} is {noun} {place} of {count}",
  "shell.doc.moreTools": "More {mode} tools",
  "shell.command.workspace": "Go to the {workspace} workspace",
  "shell.command.go": "Go to {name}",
  "shell.command.duplicate": "Duplicate the selection",
  "shell.command.up": "Move the selection up",
  "shell.command.down": "Move the selection down",
  "shell.command.logic": "Add logic to the selection",
  "shell.command.delete": "Delete the selection",
  "shell.command.open": "Open {name}",
  "shell.command.new": "New {noun}…",
  "shell.command.stopHidden": "Stop showing hidden components",
  "shell.command.showHidden": "Show hidden components",
  "shell.command.backToEditing": "Back to editing",
  "shell.command.tryIt": "Try it: preview the form",
  "shell.command.preview": "Preview the form",
  "shell.command.width.desktop": "Preview at desktop width",
  "shell.command.width.tablet": "Preview at tablet width",
  "shell.command.width.phone": "Preview at phone width",
  "shell.load.logic": "Loading Logic…",
  "shell.load.data": "Loading Data…",
  "shell.load.languages": "Loading Languages…",
  "shell.load.print": "Loading Print…",
  "shell.load.layouts": "Loading the layouts…",
  "shell.load.journeys": "Loading the journeys…",
  "shell.load.chrome": "Loading Header & footer…",
  "shell.load.variables": "Loading Variables…",
  "shell.load.tests": "Loading Tests…",
  "shell.load.failed.logic": "Logic didn't load.",
  "shell.load.failed.data": "Data didn't load.",
  "shell.load.failed.languages": "Languages didn't load.",
  "shell.load.failed.print": "Print didn't load.",
  "shell.load.failed.layouts": "The layouts didn't load.",
  "shell.load.failed.journeys": "The journeys didn't load.",
  "shell.load.failed.chrome": "Header & footer didn't load.",
  "shell.load.failed.variables": "Variables didn't load.",
  "shell.load.failed.tests": "Tests didn't load.",
  "shell.load.failed.formula": "The formula editor didn't load. The plain box still works.",
  "shell.load.failed.reads": "The plain-words wording for rules didn't load. Rules show as formulas.",
  "shell.load.check": "Check the connection and try again.",
  "shell.load.retry": "Retry",
  "shell.palette.failed": "The command palette did not load. Try again.",
  "settings.language.noneDesigner": "Shown in the page's language while you design this output.",
  "settings.sources.json.notList": "The JSON is not a list.",
  "settings.sources.json.needsValue": "Each entry needs a value.",
  "settings.sources.json.unreadable": "The JSON could not be read.",
  "settings.sources.tooLarge": "The list is too large: at most {max} options and 2 MiB.",
  "view.chrome.frameNone": "Not set",
  "controller.formLabel": "Form",
  "controller.tabLabel": "Tab {n}",
  "controller.messageLabel": "Message “{code}”",
  "controller.printHeaderStart": "Print header, start",
  "controller.printHeaderEnd": "Print header, end",
  "controller.printFooterStart": "Print footer, start",
  "controller.printFooterEnd": "Print footer, end",
  "controller.idInvalid": "Invalid ID.",
  "controller.notAllowed": "Component not allowed here.",
  "controller.notAllowedMany": "Components not allowed here.",
  "controller.renameFailed": "Unable to rename this component.",
  // Drawn on the canvas in place of a choice field with no options, where the canvas draws its controls.
  "canvas.noOptions": "No options yet - edit options",
  "common.cancel": "Cancel",
  "common.delete": "Delete",
  "common.apply": "Apply",
  "common.discard": "Discard",
  "common.stay": "Stay",
  "confirm.unsaved.keep": "Keep editing",
  "common.close": "Close",
  "common.remove": "Remove",
  "common.clear": "Clear",
  "common.export": "Export",
  "common.import": "Import",
  "common.moveUp": "Move up",
  "common.moveDown": "Move down",
  "confirm.delete.label": "Confirm delete",
  "confirm.delete.title": "Delete this component?",
  "confirm.delete.body": "{what} will be removed.",
  "confirm.delete.bodyInside.one": "{what} and the {count} component inside it will be removed.",
  "confirm.delete.bodyInside.other": "{what} and the {count} components inside it will be removed.",
  // What else leans on the component being deleted: listed under the question, with an opt-in to clear it.
  "confirm.delete.dependents.one": "{count} other place uses it:",
  "confirm.delete.dependents.other": "{count} other places use it:",
  "confirm.delete.dependents.rule": "Rule “{rule}” of {name}",
  "confirm.delete.dependents.journey.question": "Journey “{journey}”, step “{page}” lists it",
  "confirm.delete.dependents.journey.fills": "Journey “{journey}”, step “{page}” has a field filled from it",
  "confirm.delete.dependents.journey.value": "Journey “{journey}”, step “{page}” works out a value from or into it",
  "confirm.delete.dependents.journey.rule": "Journey “{journey}”, step “{page}” has a field with a rule that reads it",
  "confirm.delete.dependents.journey.route": "Journey “{journey}”, a route from step “{page}” reads it",
  "confirm.delete.dependents.pdf.when": "PDF layout “{layout}”: its condition reads it",
  "confirm.delete.dependents.pdf.node": "PDF layout “{layout}”: {detail} is bound to it",
  "confirm.delete.dependents.pdf.field": "PDF layout “{layout}”: the field {detail} is filled from it",
  "confirm.delete.dependents.pdf.area": "PDF layout “{layout}”: the area {detail} is drawn from it",
  "confirm.delete.dependents.pdf.text": "PDF layout “{layout}”: the text in {detail} writes it as a placeholder, which will print blank",
  "confirm.delete.dependents.keep": "Without that, they stay and are flagged as missing.",
  "confirm.delete.alsoRemove": "Also remove references",
  "confirm.unsaved.label": "Changes not applied",
  "confirm.unsaved.body": "{what} has changes that are not applied. Apply or discard them before {action}.",
  "confirm.unsaved.bodyForm": "The form's settings have changes that are not applied. Apply or discard them before {action}.",
  "confirm.unsaved.what": "“{label}” ({id})",
  "confirm.unsaved.blocked.one": "Apply is unavailable until this is fixed; Keep editing takes you there:",
  "confirm.unsaved.blocked.other": "Apply is unavailable until these are fixed; Keep editing takes you there:",
  "confirm.unsaved.blockedPanel": "Apply is unavailable until the problem shown in the panel is fixed.",
  "confirm.unsaved.action.select": "moving on",
  "confirm.unsaved.action.add": "adding a component",
  "confirm.unsaved.action.drop": "moving a component",
  "confirm.unsaved.action.leave": "leaving the builder",
  "confirm.unsaved.action.replace": "replacing the form's contents",
  "confirm.unsaved.action.remove": "removing components",
  "confirm.unsaved.action.panel": "opening another panel",
  "common.sep": ", ",
  "common.maximize": "Maximize",
  "common.restore": "Restore size",
  "common.rowActions": "Row actions",
  "common.none": "—",
  "chromeSummary.group": "Group",
  "chromeSummary.groupOf": "Group ({parts})",
  "chromeSummary.empty": "empty",
  "chromeSummary.none": "Nothing yet",
  "chromeSummary.open": "Open the Header & footer panel",
  "chromeSummary.edit": "Edit {label}…",
  "optionsEditor.options.noun": "option",
  "optionsEditor.options.keyHeader": "Key",
  "optionsEditor.options.textHeader": "Label",
  "optionsEditor.options.hint": "Each row is one choice: the key is what the form stores when it is picked, the label is what the person filling the form reads — per language, with the default as the fallback. Descriptions adds a line of help under each option. Pasting a list makes one option per line.",
  "optionsEditor.discard.title.one": "Discard 1 change?",
  "optionsEditor.discard.title.other": "Discard {count} changes?",
  "optionsEditor.discard.body": "What you changed in this dialog has not been applied. Discard closes it and keeps the list as it was.",
  "optionsEditor.discard.keep": "Keep editing",
  "optionsEditor.err.rowUnfinished": "Row {n} is not finished: it has a key but no label. Add a label, or clear the key.",
  "optionsEditor.options.empty": "No options yet — add one below, or import a list.",
  "optionsEditor.options.newKeyPlaceholder": "Key (stored value)",
  "optionsEditor.options.newTextPlaceholder": "Label",
  "optionsEditor.options.addLabel": "Add option",
  "optionsEditor.options.exportTitle": "Download the options as JSON",
  "optionsEditor.options.importTitle": "Replace the options with a JSON file",
  "optionsEditor.options.close": "Close options editor",
  "optionsEditor.messages.noun": "message",
  "optionsEditor.messages.keyHeader": "Code",
  "optionsEditor.messages.textHeader": "Message",
  "optionsEditor.messages.hint": "Every code this component's own checks can raise is a row, with what it means beside it; a blank row keeps the page's or engine's wording, shown greyed in the cells — Use default copies it in to edit from. A message is what the person filling the form reads when that check fails — per language, with the default as the fallback — and may carry the error's details in braces, such as {minLength}. Any other code a server or a rule returns can be added below; the chips under the table list the rest.",
  "optionsEditor.messages.empty": "No messages yet — add one below, or import a list.",
  "optionsEditor.messages.newKeyPlaceholder": "Code (required, minLength, …)",
  "optionsEditor.messages.newTextPlaceholder": "Message",
  "optionsEditor.messages.addLabel": "Add message",
  "optionsEditor.messages.exportTitle": "Download the messages as JSON",
  "optionsEditor.messages.importTitle": "Replace the messages with a JSON file",
  "optionsEditor.messages.close": "Close messages editor",
  "optionsEditor.meaning": "Meaning",
  "optionsEditor.description": "Description",
  "optionsEditor.descriptions": "Descriptions",
  "optionsEditor.descriptionsTitle": "A line of help under each option, shown beside its label on the form",
  "optionsEditor.descriptionOf": "Description of {noun} {n}",
  "optionsEditor.partOf": "{part} of {noun} {n}",
  "optionsEditor.messageOf": "{code} {part}",
  "optionsEditor.newPart": "New {noun} {part}",
  "optionsEditor.moveUpLabel": "Move {noun} {n} up",
  "optionsEditor.moveDownLabel": "Move {noun} {n} down",
  "optionsEditor.useDefault": "Use default",
  "optionsEditor.useDefaultLabel": "Use the page's wording for {noun} {n}",
  "optionsEditor.useDefaultTitle": "Copy the page's wording in, to edit from",
  "optionsEditor.clearLabel": "Clear {noun} {n}",
  "optionsEditor.clearTitle": "Drop this code's wording; the page's or engine's applies again",
  "optionsEditor.removeLabel": "Remove {noun} {n}",
  "optionsEditor.source": "This field currently takes its options from the data source {source}; the list here applies only once no source is set.",
  "optionsEditor.chip.details": "Details a message may quote: {names}.",
  "optionsEditor.chip.taken": "Already has a row.",
  "optionsEditor.chip.free": "Click to put it in the code box.",
  "toolbar.addTitle": "Click to add, or drag onto a slot",
  "paletteGroup.fields": "Fields",
  "paletteGroup.choices": "Choices",
  "paletteGroup.layout": "Layout",
  "paletteGroup.content": "Content",
  "paletteGroup.actions": "Actions",
  "paletteGroup.other": "Other",
  // The type chip of a container whose type name is not words an author reads: a data grid.
  "canvas.type.dataGrid": "Data grid",
  "canvas.hidden": "Hidden by a rule",
  "canvas.hiddenTitle": "A rule is hiding this component right now; Try it shows when",
  "canvas.paperOnly": "Paper only",
  "canvas.paperOnlyTitle": "Printed only: a person filling the form never sees it on screen",
  "canvas.dragTitle": "Drag to move",
  "canvas.dropRoot": "Drop components here to build the form.",
  "canvas.drop": "Drop components here.",
  "tree.hidden": "hidden",
  "tree.note": "Every component, including any the canvas is currently hiding.",
  "inspector.helpOf": "Help: {label}",
  "inspector.id": "ID",
  "inspector.savesTo": "Saves to",
  "inspector.properties": "Properties",
  "inspector.noProperties": "This component has no editable properties.",
  "inspector.noStyle": "This component has no style options.",
  "inspector.selectProperties": "Select a component in the canvas to edit its properties.",
  "inspector.selectJson": "Select a component to see its JSON.",
  "inspector.selectRules": "Select a component to edit its rules.",
  // Which adapter draws the component, and the settings the binding draws less than in full.
  "inspector.drawn.binding": "Drawn by {name}, from {binding}.",
  "inspector.drawn.binding-base": "Drawn by {name}, from {binding}, as a {via}.",
  "inspector.drawn.datum": "Drawn by Datum’s {name}: {binding} has no component for this type.",
  "inspector.drawn.datum-base": "Drawn by Datum’s {name}, as a {via}: {binding} has no component for this type or its base.",
  "inspector.drawn.renderer": "Nothing draws this type: the form shows a note in its place.",
  "inspector.drawing.kept": "{binding} does not draw this setting, so the form ignores it. The value stays in the form.",
  "inspector.drawing.degraded.tooltip": "{binding} shows the tooltip text in the hint, not on hover.",
  "inspector.drawing.degraded.prefix": "{binding} draws the prefix in a reduced form.",
  "inspector.drawing.degraded.suffix": "{binding} draws the suffix in a reduced form.",
  "inspector.drawing.degraded.characterCount": "{binding} draws the count, but a screen reader is not told as it changes.",
  "inspector.drawing.degraded.hideLabel": "{binding} draws a hidden label in a reduced form. It stays the control’s name.",
  "inspector.drawing.degraded.placeholder": "{binding} draws the placeholder in a reduced form.",
  "inspector.drawing.degraded.workedOut": "{binding} shows the line saying the value is worked out in the hint.",
  "inspector.drawing.degraded.rowNumbers": "{binding} always draws the row numbers.",
  "inspector.drawing.degraded.notice": "{binding} draws warnings and info as hint-styled text with their severity word.",
  "inspector.drawing.degraded.pending": "{binding} says a check is running in the hint.",
  "inspector.unknownType": "Unknown component type “{type}”: nothing is registered for it. The canvas shows a note in its place, and so will the running form. Register the plugin that provides it, or delete the component.",
  "inspector.childrenNote": "Children are edited on the canvas.",
  "inspector.jsonAt": "Line {line}, column {column}: ",
  "inspector.themeOptions": "Style options",
  "inspector.styleGroup.panelLook": "Look",
  "inspector.styleGroup.other": "Choose one",
  "inspector.styleGroup.default": "Default",
  "inspector.styleGroup.defaultHelp": "Leaves the choice to the binding.",
  "inspector.styleLook.plain": "Plain",
  "inspector.styleLook.plainHelp": "The heading with the fields under it: no border, no background, no header band.",
  "inspector.styleLook.outlined": "Outlined",
  "inspector.styleLook.outlinedHelp": "A border around the panel, with no header band and no fill.",
  "inspector.styleLook.shaded": "Shaded",
  "inspector.styleLook.shadedHelp": "A light background behind the panel, with no border.",
  "inspector.styleLook.card": "Card",
  "inspector.styleLook.cardHelp": "A border, a header band behind the heading and a surface for the fields.",
  "inspector.unknownChoice": "{value} (unknown)",
  "inspector.expressionHint": "Written as an expression tree (JSON); the Logic tab's rules are written as formulas.",
  "inspector.optionsCount.none": "No options yet",
  "inspector.optionsCount.one": "{count} option",
  "inspector.optionsCount.other": "{count} options",
  "inspector.fromSource": "From the data source {source}",
  "inspector.sourceNote": "Clear the data source to author the options inline.",
  "inspector.sourceNoteKept.one": "Clear the data source to author the options inline ({count} option saved).",
  "inspector.sourceNoteKept.other": "Clear the data source to author the options inline ({count} options saved).",
  // What holds Apply back (the only place it is held back for a value) and what the inspector only warns of.
  "inspector.block.pattern": "This is not a valid regular expression, so it cannot be applied. Check the brackets and escapes.",
  "inspector.block.lengthRange": "The minimum length is above the maximum length, so no answer could pass. Lower the minimum or raise the maximum.",
  "inspector.block.range": "The minimum is above the maximum, so no number could pass. Lower the minimum or raise the maximum.",
  // A data grid's row bounds: said under the box, never a reason the form cannot run.
  "inspector.problem.rowsMaxBelowMin": "Maximum rows is below the minimum, so the form will use the minimum. Raise the maximum or lower the minimum.",
  "inspector.problem.rowsCap": "At most {max}.",
  "inspector.problem.paperOnly": "This is set to On paper only, but it holds an answer or is a step or tabs, so it is still shown on screen.",
  "inspector.print.paperOnlyBlocked": "On paper only is not offered here: this holds an answer, holds something that does, or is a step or tabs, and a person filling the form must see it.",
  "inspector.warn.noLabel": "This field has no label, so nobody (a screen reader included) is told what it asks for.",
  "inspector.warn.untitled": "Give this field a label",
  "inspector.hint.calculated": "Calculated by a rule - read-only to the filler",
  // The validation presets: a ready-made Pattern and message, written into the
  // definition only when asked for. The Email keyboard alone validates nothing; it only suggests this.
  "inspector.preset.label": "Check the answer as",
  "inspector.preset.help": "Fills in the Pattern and Pattern message below with a ready-made check. Choose Any text to take it away.",
  "inspector.preset.none": "Any text",
  "inspector.preset.custom": "Custom pattern",
  "inspector.preset.email": "Email address",
  "inspector.hint.presetEmail": "Suggest: validate as email",
  "inspector.editOptions": "Edit options…",
  "inspector.messagesCount.none": "No messages yet",
  "inspector.messagesCount.one": "{count} code",
  "inspector.messagesCount.other": "{count} codes",
  "inspector.editMessages": "Edit messages…",
  "inspector.file.none": "None",
  "inspector.file.inline": "{name} · {size} · kept in the form definition",
  "inspector.file.host": "{name} · provided by the host ({storage})",
  "inspector.file.upload": "Upload a file…",
  "inspector.file.choose": "Choose…",
  "idHelp.layoutRoot": "The layout's own ID. No component in the layout can take it.",
  "idHelp.layout": "This component's name across the whole layout. The builder finds it by this ID, so no two components in the layout can share one. A layout stores no answers of its own: it shows the form's.",
  "idHelp.formRoot": "The form's own ID. No component in the form can take it. The form's answers are stored at the top level of the submitted data, not under it.",
  "idHelp.name": "This component's name across the whole form. Rules, error messages and PDF layouts refer to it by this ID, so no two components can share one, even inside different containers.",
  "idHelp.collection": "Its entries are stored as a list under the ID too, unless its collection path names another place. If so, the Saved as line shows where.",
  "idHelp.scope": "The answers inside it are nested under the ID too, unless it has a Data key or sits inside another container that nests data. If so, the Saved as line shows where.",
  "idHelp.data": "Its answer is stored under the ID too, unless it has a Data key or sits inside a container that nests data or a repeating section. If so, the Saved as line shows where.",
  "idHelp.none": "It stores no answer of its own.",
  "savedAsHelp.collection": "Where this section's or data grid's entries are stored in the submitted data, as a list. It is the section's collection path, wherever it sits. The fields inside are stored in each entry, which their Saved as shows as [].",
  "savedAsHelp.made": "The path joins the keys of the containers above it that nest data, then its own Data key, or its ID when it has none.",
  "savedAsHelp.entry": "[] stands for each entry of the repeating section it sits in. A submission numbers them, as in {example}.",
  "savedAsHelp.container": "Where the answers inside this container are stored in the submitted data, as one object.",
  "savedAsHelp.answer": "Where this answer is stored in the submitted data.",
  "savedAsHelp.tail": "Submissions, exports and the Data workspace all use this path.",
  "rules.note": "Rules run against the live form. Every rule is a formula: reference a field by its id, or use a {row} / {ancestor} / {host} prefix; the strip's Variables panel lists them.",
  "rules.runsValue": "Runs: {scope}",
  "rules.off": "Off",
  "rules.formula": "Formula",
  "rules.stateOff": "off",
  "rules.stateOn": "on",
  "rules.openInLogic": "Open in Logic",
  "identity.title": "Identity",
  "identity.hint": "How submissions, drafts and storage name this form. A blank box keeps its current value.",
  "identity.formId": "Form ID",
  "identity.version": "Version",
  "identity.schemaVersion": "Schema version",
  "identity.eg": "e.g. {example}",
  "problem.labelled": "{label}: {message}",
  "problem.goTo": "Go to the problem",
  "problem.notApplied": "Not applied",
  "toolbar.noMatch": "No components match.",
  "gap.noAnswer": "Never enforced: this component holds no answer of its own. Put the rule on the field it is about, or turn it off.",
  "gap.repeating": "Not enforced inside a repeating section: a rule there is not read row by row. Turn it off, or move the field out of the section.",
  "canvas.keys": "Arrow keys move between components; Alt with an arrow moves the selected one, M asks where to; Delete removes it; Enter edits its settings; Escape clears the selection. Shift with an arrow moves the form on the canvas; 0 fits and centres it.",
  "inspector.managedBySite": "Managed by the site.",
  "canvas.remoteLoad": "Load remote content?",
  "canvas.remoteConfirm": "This form asks for pictures from another website. Loading them tells that site you opened the form. Load them for this form?",
  "canvas.backJourneys": "Back to the journeys",
  "canvas.backJourneysText": "‹ Journeys",
  "canvas.backPdf": "Back to the PDF layouts",
  "canvas.backPdfText": "‹ Layouts",
  "canvas.bar": "Canvas",
  "canvas.stepPrev": "Previous step",
  "canvas.stepNext": "Next step",
  "canvas.previewing": "Previewing",
  "canvas.widthZoom": "Width and zoom",
  "canvas.previewWidth": "Preview width",
  "canvas.device.desktop": "Desktop, 1280 wide",
  "canvas.device.tablet": "Tablet, 768 wide",
  "canvas.device.phone": "Phone, 390 wide",
  "canvas.zoom": "Zoom",
  "canvas.zoomOut": "Zoom out",
  "canvas.zoomOutTip": "Zoom out (-)",
  "canvas.zoomIn": "Zoom in",
  "canvas.zoomInTip": "Zoom in (+)",
  "canvas.fitLabel": "Fit the whole form and centre it",
  "canvas.fitTip": "Fit and centre (0)",
  "canvas.fit": "Fit",
  "canvas.actualLabel": "Zoom 100%, actual size",
  "canvas.actualTip": "Actual size",
  "canvas.tryIt": "Try it",
  "canvas.preview": "Preview",
  "canvas.backToEditing": "Back to editing",
  "canvas.page": "Form canvas",
  "canvas.gripTitle": "Drag to set a custom width",
  "canvas.edit": "Edit",
  "canvas.editTip": "Edit its settings",
  "canvas.editName": "Edit {name}",
  "canvas.selected": "Selected: {name}",
  "canvas.action.move": "Move to…",
  "canvas.action.moveTip": "Move to… (M)",
  "canvas.action.duplicate": "Duplicate",
  "canvas.action.logic": "Add logic",
  "canvas.stepper": "Step {n} of {total} · {label}",
  "canvas.zoomBack": "Zoom {percent}, back to actual size",
  "canvas.zoomSaid": "Zoom {percent}%",
  "canvas.zoomMax": "Zoom {percent}%, as large as it goes",
  "canvas.zoomMin": "Zoom {percent}%, as small as it goes",
  "canvas.position": "{label}, {type}, {n} of {total}",
  "canvas.tryClose": "Close the results",
  "canvas.tryLoadFailed": "Try it could not be loaded",
  "canvas.tryAgain": "Try again",
  "canvas.tryStarting": "Starting Try it…",
  "inspector.tab.properties": "Field",
  "inspector.tab.style": "Style",
  "inspector.tab.rules": "Logic",
  "inspector.tab.settings": "Settings",
  "inspector.tab.step": "Step",
  "inspector.tabRules.one": "{label}, {count} rule",
  "inspector.tabRules.other": "{label}, {count} rules",
  "inspector.tabs": "Settings",
  "inspector.more": "More",
  "inspector.findings.label": "What to fix in this journey",
  "inspector.editJson": "Edit JSON",
  "inspector.showProperties": "Show properties",
  "inspector.filter.placeholder": "Filter properties…",
  "inspector.filter.label": "Filter properties",
  "inspector.jsonOf": "The component's JSON",
  "inspector.jsonOfRoot": "The {name}'s JSON",
  "inspector.jsonReadOnly": "Component JSON (read only)",
  "panel.notSaved": "Not saved: {count}. {problem}",
  "optionsEditor.titleOptions": "Options — {name}",
  "optionsEditor.titleMessages": "Validation messages — {name}",
  "optionsEditor.group.engine": "Other engine codes",
  "optionsEditor.group.page": "Named by the page",
  "optionsEditor.group.other": "Other codes",
  "optionsEditor.err.messageNoCode": "Message {n} has no code.",
  "optionsEditor.err.codeDup": "Code \"{code}\" is used more than once.",
  "optionsEditor.err.messageEmpty": "The message for \"{code}\" is empty.",
  "optionsEditor.err.optionNoKey": "Option {n} has no key.",
  "optionsEditor.err.keyDup": "Key \"{key}\" is used more than once.",
  "optionsEditor.err.enterCode": "Enter the validation code the message is for (required, minLength, …).",
  "optionsEditor.err.enterKey": "Enter a key for the option (what the form stores when it is picked).",
  "optionsEditor.err.codeHasMessage": "Code \"{code}\" already has a message.",
  "optionsEditor.err.keyExists": "Key \"{key}\" already exists.",
  "optionsEditor.err.downloads": "Downloads are not available in this environment.",
  "optionsEditor.err.notJson": "\"{file}\" is not valid JSON.",
  "optionsEditor.err.notMessages": "\"{file}\" is not a messages map (expected { \"code\": \"text\", … }).",
  "optionsEditor.err.notOptions": "\"{file}\" is not an options list (expected [{ \"value\", \"label\" }, …]).",
  "optionsEditor.err.unreadable": "\"{file}\" could not be read.",
  "optionsEditor.err.tooLarge": "\"{file}\" is too large: at most {max} options and 2 MiB.",
  "optionsEditor.err.tooMany": "A list holds at most {max} options.",
  "panel.json.problem": "Line {line}, column {column}: {message}",
  "panel.problem.json": "JSON",
  "panel.problem.rules": "Rules · {label}",
  "rules.note.browserOnly": "Checked only in the browser: a server checking the submission has no {path}, so it does not hold this component to the rule.",
  "rules.note.neverWorked": "Never worked out: this component holds no data of its own, so there is nowhere to put the result. Turn it off.",
  "pdf.bar.suggest": "Suggest mappings",
  "pdf.bar.suggest.title": "Fill every unmapped field whose name matches a form component's id or label",
  "pdf.bar.createFields": "Create form fields",
  "pdf.bar.createFields.title": "Add a form field for every PDF field nothing fills, and fill the PDF field from it",
  "pdf.bar.preview": "Preview PDF",
  "pdf.bar.rendering": "Rendering…",
  "pdf.bar.preview.noExecutor": "No PDF executor is available",
  "pdf.bar.preview.layout": "Render this layout with the answers in Try it now (none once Try it has ended)",
  "pdf.bar.preview.derived": "Render the PDF printed without a layout, with the answers in Try it now (none once Try it has ended)",
  "pdf.newName.blank": "Blank layout",
  "pdf.newName.custom": "Custom layout",
  "pdf.newName.paper": "Paper form",
  "file.embed.heavy": "\"{name}\" ({size}) would make this form {total}. A form opens only up to {limit}, so it could be saved here and never opened again. Nothing was changed. Use a smaller file.",
  "pdf.add.error.heavy": "\"{name}\" ({size}) would make this form {total}. A form opens only up to {limit}, so it could be saved here and never opened again. Nothing was changed. Use a smaller PDF, or have your host offer this one as a template to choose from.",
  "pdf.copyName": "{name} (copy)",
  "pdf.badge.conditional": "Conditional",
  "pdf.settings.label": "Layout",
  "pdf.order.label": "Which layout prints",
  "pdf.order.open": "Open the PDF layouts",
  "pdf.tryIt.derived": "PDF · derived from the form",
  "pdf.paper.custom": "Custom",
  "pdf.paper.landscape": "{size} landscape",
  "pdf.provenance.uploaded": "uploaded; travels with the form",
  "pdf.provenance.host": "provided by the host",
  "pdf.unusable.one": "{count} PDF layout in the definition is unusable and was left out; saving the form now removes it. {list}",
  "pdf.unusable.other": "{count} PDF layouts in the definition are unusable and were left out; saving the form now removes them. {list}",
  "pdf.status.inspecting": "Inspecting the template…",
  "pdf.status.waiting": "{name} ({provenance}) — waiting for the PDF executor to read its fields.",
  "pdf.status.failed": "{name} ({provenance}) — {problem}",
  "pdf.summary.lead": "{name} ({provenance}) · ",
  "pdf.summary.pages.one": "{count} page",
  "pdf.summary.pages.other": "{count} pages",
  "pdf.summary.noFields": "no form fields on {pages} — draw areas on the pages to place answers",
  "pdf.summary.fields.one": "{count} field on {pages} · areas can be drawn on the pages",
  "pdf.summary.fields.other": "{count} fields on {pages} · areas can be drawn on the pages",
  "pdf.summary.unplaced.one": " · {count} field has no page position and is not drawn on the pages",
  "pdf.summary.unplaced.other": " · {count} fields have no page position and are not drawn on the pages",
  "pdf.summary.xfa": " · XFA present (removed on fill)",
  "pdf.summary.encrypted": " · encrypted",
  "pdf.summary.scripts": " · This PDF carries scripts; they are kept and run only in the viewer",
  "pdf.summary.pdfa": " · PDF/A-{level}",
  "pdf.summary.notPdfa": " · not PDF/A",
  "pdf.fill.noForm": "There is no populated form with fields to build from.",
  "pdf.fill.formUnsaved": "The Form tab has unsaved edits to {id}: save or discard them there, then create the fields.",
  "pdf.fill.layoutUnsaved": "This layout has unsaved edits: save or discard them, then create the fields.",
  "pdf.fill.layoutUnsavedNamed": "This layout has unsaved edits to {id}: save or discard them, then create the fields.",
  "pdf.fill.holding": "the Form tab is holding unsaved edits",
  "pdf.fill.refused": "No form fields were created: {reason}.",
  "pdf.fill.refusedDefault": "the form refused them",
  "pdf.fill.nothingLeft": "Nothing to create. Left out: {list}.",
  "pdf.fill.nothingAll": "Nothing to create: every field of this PDF is filled already.",
  "pdf.fill.formFields.one": "{count} form field",
  "pdf.fill.formFields.other": "{count} form fields",
  "pdf.fill.pdfFields.one": "{count} PDF field",
  "pdf.fill.pdfFields.other": "{count} PDF fields",
  "pdf.fill.had": ", {count} of them from fields the form had",
  "pdf.fill.left": " Left out: {list}.",
  "pdf.fill.more": "{count} more",
  "pdf.fill.done": "Added {added} and filled {filled}{had}.{left} Undo here takes the filling back; undo on the Form tab takes the fields back.",
  "pdf.rename.unparsed": "A formula in {layout} ({where}) still names {from}, now {to}, but does not parse, so it was left as written: {formula}",
  "pdf.empty.title": "No PDF layouts",
  "pdf.empty.body": "A layout sets how the form prints: a document built from the form and arranged here, or an existing PDF filled from the answers. Several layouts can be chosen between by the answers.",
  "pdf.empty.hint": "Until there is one, a PDF of this form is printed from the form as it stands; nothing is written into the definition for it. Preview PDF shows that one.",
  "pdf.empty.add": "New layout…"
} as const;

/** The keys of the core table, the ones eager code may name. */
export type BuilderCoreTextKey = keyof typeof EN;

/**
 * Every key the builder's catalog defines: the core table's and each lazy area's. The area
 * tables are imported as types only, so they cost the entry nothing; a host's catalog stays one
 * flat map per locale over all of them.
 */
export type BuilderTextKey =
  | BuilderCoreTextKey
  | keyof typeof import("../journey-designer/journey-texts-en.js").JOURNEY_EN
  | keyof typeof import("../journey-map/journey-map-texts-en.js").JOURNEY_MAP_EN
  | keyof typeof import("../journey-designer/journey-preview-texts-en.js").JOURNEY_PREVIEW_EN
  | keyof typeof import("../journey-designer/journey-authoring-texts-en.js").JOURNEY_AUTHORING_EN
  | keyof typeof import("../data/data-texts-en.js").DATA_EN
  | keyof typeof import("../languages/languages-texts-en.js").LANGUAGES_EN
  | keyof typeof import("../print/print-texts-en.js").PRINT_EN
  | keyof typeof import("./logic-texts-en.js").LOGIC_EN
  | keyof typeof import("../overview/overview-texts-en.js").OVERVIEW_EN
  | keyof typeof import("../palette/palette-texts-en.js").PALETTE_EN
  | keyof typeof import("../formula/formula-texts-en.js").FORMULA_EN
  | keyof typeof import("../web-component/try-texts-en.js").TRY_EN
  | keyof typeof import("../pdf-designer/pdf-texts-en.js").PDF_EN
  | keyof typeof import("../drag-drop/move-texts-en.js").MOVE_EN
  | keyof typeof import("../form-tests/tests-texts-en.js").TESTS_EN
  | keyof typeof import("../form-tests/tests-panel-texts-en.js").TESTS_PANEL_EN
  | keyof typeof import("../form-tests/tests-editor-texts-en.js").TESTS_EDITOR_EN
  // The builder agent tools' words: their table is in the builder agent chunk.
  | keyof typeof import("../languages/languages-exchange-texts-en.js").LANGUAGES_EXCHANGE_EN
  | keyof typeof import("../../agent/builder/agent-texts-en.js").AGENT_EN;

/** One lazy area's English: key to template, supplied by the area's own module (`areaText`). */
export type BuilderTextTable = Readonly<Record<string, string>>;

/** The base of every key that comes in `.one` / `.other` forms, for {@link builderPlural}. */
export type BuilderPluralKey = {
  [K in BuilderTextKey]: K extends `${infer Base}.one` ? Base : never;
}[BuilderTextKey];

/** The core English texts, built in: the last fallback for the keys eager code names. */
export const BUILDER_TEXTS_EN: Record<BuilderCoreTextKey, string> = EN;

/** A host's texts per locale (`fr`, `fr-CA`), each a partial catalog over the English keys. */
export type BuilderTextCatalog = { [locale: string]: Partial<Record<BuilderTextKey, string>> };

export interface BuilderTextOptions {
  /** BCP 47; absent: English. */
  locale?: string | undefined;
  catalog?: BuilderTextCatalog | undefined;
  /** The English of lazy areas, after the core table; set by `areaText` and `BuilderWords.with`, never by a host. */
  tables?: readonly BuilderTextTable[] | undefined;
}

/** One piece of a template: text as written, or a named slot to fill. */
export type BuilderTemplatePart = { text: string } | { slot: string };

const SLOT_PATTERN = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

/** The locales to try, most specific first: `fr-CA`, then `fr`, then English. */
function localeChain(locale: string | undefined): string[] {
  const chain: string[] = [];
  if (locale !== undefined && locale !== "") {
    chain.push(locale);
    const primary = locale.split("-")[0];
    if (primary !== undefined && primary !== "" && primary !== locale) {
      chain.push(primary);
    }
  }
  if (!chain.includes("en")) {
    chain.push("en");
  }
  return chain;
}

/** A key's template for the locale: the host's, key by key down the locale chain, else English. */
function templateOf(key: string, options: BuilderTextOptions | undefined): string | undefined {
  const catalog = options?.catalog;
  if (catalog !== undefined) {
    for (const locale of localeChain(options?.locale)) {
      const entry = Object.prototype.hasOwnProperty.call(catalog, locale) ? catalog[locale] : undefined;
      const text = entry !== undefined ? (entry as Record<string, string | undefined>)[key] : undefined;
      if (typeof text === "string") {
        return text;
      }
    }
  }
  return englishOf(key, options);
}

/** The built-in English for `key`: the core table, then the area tables the caller carries. */
function englishOf(key: string, options: BuilderTextOptions | undefined): string | undefined {
  if (Object.prototype.hasOwnProperty.call(EN, key)) {
    return (EN as Record<string, string>)[key];
  }
  for (const table of options?.tables ?? []) {
    if (Object.prototype.hasOwnProperty.call(table, key)) {
      return table[key];
    }
  }
  return undefined;
}

/**
 * The text for `key` in the locale, its `{name}` slots filled from `params`. A slot with no
 * param stays visible as written, so a missing value shows up in review rather than vanishing.
 */
export function builderText(
  key: BuilderTextKey,
  params?: Record<string, string | number>,
  options?: BuilderTextOptions
): string {
  const template = templateOf(key, options) ?? key;
  return template.replace(SLOT_PATTERN, (whole, name: string) => {
    const value = params !== undefined && Object.prototype.hasOwnProperty.call(params, name) ? params[name] : undefined;
    return value === undefined ? whole : String(value);
  });
}

/**
 * The template for `key`, split into its text and its slots in order, for a sentence built as
 * tokens (a field as a chip, a value as a pill) rather than as one string. Empty text between
 * two adjacent slots is left out; the text keeps its spaces, so the parts read back as written.
 */
export function builderTemplateParts(key: BuilderTextKey, options?: BuilderTextOptions): BuilderTemplatePart[] {
  const template = templateOf(key, options) ?? key;
  const parts: BuilderTemplatePart[] = [];
  let last = 0;
  for (const match of template.matchAll(SLOT_PATTERN)) {
    const at = match.index ?? 0;
    if (at > last) {
      parts.push({ text: template.slice(last, at) });
    }
    parts.push({ slot: match[1] as string });
    last = at + match[0].length;
  }
  if (last < template.length) {
    parts.push({ text: template.slice(last) });
  }
  return parts;
}

/** One piece of a formatted list: an item, or the punctuation and words between items. */
export interface BuilderListPart {
  kind: "element" | "literal";
  text: string;
}

interface ListFormatLike {
  formatToParts(items: string[]): Array<{ type: string; value: string }>;
}

type ListFormatConstructor = new (
  locale: string,
  options: { type: "conjunction" | "disjunction"; style: "long" }
) => ListFormatLike;

/**
 * `items` as a list in the locale's words ("A, B, or C"; "A, B ou C"), as parts so the items
 * can be drawn as tokens. Without `Intl.ListFormat` (an old engine), or for a locale it
 * refuses, the list is joined plainly with the catalog's join word: "A, B or C".
 */
export function formatList(
  items: string[],
  options: BuilderTextOptions & { type: "conjunction" | "disjunction" }
): BuilderListPart[] {
  if (items.length === 0) {
    return [];
  }
  const ListFormat = (Intl as unknown as { ListFormat?: ListFormatConstructor }).ListFormat;
  if (typeof ListFormat === "function") {
    try {
      const formatter = new ListFormat(options.locale ?? "en", { type: options.type, style: "long" });
      return formatter
        .formatToParts(items)
        .map((part) => ({ kind: part.type === "element" ? "element" : "literal", text: part.value }));
    } catch {
      // A locale the engine refuses (a malformed tag): the plain join below still reads.
    }
  }
  const join = builderText(options.type === "disjunction" ? "cond.join.or" : "cond.join.and", undefined, options);
  const parts: BuilderListPart[] = [];
  items.forEach((item, index) => {
    if (index > 0) {
      parts.push({ kind: "literal", text: index === items.length - 1 ? ` ${join} ` : ", " });
    }
    parts.push({ kind: "element", text: item });
  });
  return parts;
}

/** {@link formatList} read back as one string. */
export function formatListText(
  items: string[],
  options: BuilderTextOptions & { type: "conjunction" | "disjunction" }
): string {
  return formatList(items, options)
    .map((part) => part.text)
    .join("");
}

/**
 * The count's form of a plural key (`problems.count` → "1 problem", "3 problems"), chosen by
 * the locale's plural rules. A category the catalog has no key for (`few`, `many`) reads as
 * `.other`. `{count}` is filled with the count unless `params` gives it.
 */
export function builderPlural(
  baseKey: BuilderPluralKey,
  count: number,
  params?: Record<string, string | number>,
  options?: BuilderTextOptions
): string {
  let category = "other";
  try {
    category = new Intl.PluralRules(options?.locale ?? "en").select(count);
  } catch {
    category = count === 1 ? "one" : "other";
  }
  const candidate = `${baseKey}.${category}`;
  const key = (englishOf(candidate, options) !== undefined ? candidate : `${baseKey}.other`) as BuilderTextKey;
  return builderText(key, { count, ...(params ?? {}) }, options);
}

/**
 * The words for a formula parse error (`FormulaErrorCode`) from its `params`: the `.end` form
 * when the problem sits at the end of the formula (no `token`), the argument count's plural for
 * `arity` (one argument, two arguments, "2 to 3 arguments"), else `formula.err.<code>`. A code
 * the catalog lacks reads as the code itself, so a newer parser still shows something.
 */
export function formulaErrorText(
  code: string,
  params: Record<string, string | number> | undefined,
  options?: BuilderTextOptions
): string {
  const filled = params ?? {};
  if (code === "arity") {
    const count = typeof filled.expected === "number" ? filled.expected : Number.NaN;
    if (Number.isFinite(count)) {
      return builderPlural("formula.err.arity", count, { ...filled, expected: count }, options);
    }
    return builderText("formula.err.arity.other", filled, options);
  }
  const atEnd = filled.token === undefined;
  const endKey = `formula.err.${code}.end`;
  if (atEnd && Object.prototype.hasOwnProperty.call(EN, endKey)) {
    return builderText(endKey as BuilderTextKey, filled, options);
  }
  const key = `formula.err.${code}`;
  if (!Object.prototype.hasOwnProperty.call(EN, key)) {
    return code;
  }
  return builderText(key as BuilderTextKey, filled, options);
}

/**
 * The words for a compile problem (`FormulaProblem.code`): a parse code through
 * {@link formulaErrorText}, `runScope` and `invalidRule` from their own keys.
 */
export function formulaProblemText(
  code: string,
  params: Record<string, string | number> | undefined,
  options?: BuilderTextOptions
): string {
  if (code === "runScope" || code === "invalidRule") {
    return builderText(`formula.err.${code}`, params, options);
  }
  return formulaErrorText(code, params, options);
}

/**
 * A panel's handle on the catalog: the builder's locale and catalog as the shell hands them
 * down, and the words through them. One small object per panel, so no panel carries its own
 * copy of the lookup. English when the host set nothing.
 */
export class BuilderWords {
  public locale: string | undefined;
  public catalog: BuilderTextCatalog | undefined;
  /** The area tables these words also read (see {@link BuilderWords.with}). */
  public tables: readonly BuilderTextTable[] | undefined;

  /** The options for {@link builderText}. */
  public options(): BuilderTextOptions {
    return {
      ...(this.locale !== undefined ? { locale: this.locale } : {}),
      ...(this.catalog ? { catalog: this.catalog } : {}),
      ...(this.tables ? { tables: this.tables } : {})
    };
  }

  /**
   * These words, also reading a lazy area's English. The result looks through to this object for
   * the locale and the catalog, so a later change of either still reaches it.
   */
  public with(table: BuilderTextTable): BuilderWords {
    if (this.tables?.includes(table)) {
      return this;
    }
    const view = Object.create(this) as BuilderWords;
    view.tables = [...(this.tables ?? []), table];
    return view;
  }

  /** The text for `key`, its slots filled from `params`. */
  public text(key: BuilderTextKey, params?: Record<string, string | number>): string {
    return builderText(key, params, this.options());
  }

  /** The text for a counted phrase (`.one` / `.other`, per the locale's plural rules). */
  public plural(baseKey: BuilderPluralKey, count: number, params?: Record<string, string | number>): string {
    return builderPlural(baseKey, count, params, this.options());
  }

  /**
   * The text as HTML: the template's own words escaped, each `{slot}` replaced by the markup
   * given for it (already safe), so a sentence can hold a `<code>` or a `<strong>`.
   */
  public html(key: BuilderTextKey, slots: Record<string, string>): string {
    const escape = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    return builderTemplateParts(key, this.options())
      .map((part) => ("slot" in part ? (slots[part.slot] ?? `{${part.slot}}`) : escape(part.text)))
      .join("");
  }
}

/**
 * The lookup functions bound to one lazy area's English table: the same `builderText`,
 * `builderPlural`, `builderTemplateParts` and `formatListText`, which read the area's keys as
 * well as the core's. Each area module exports the result, so the area's code imports from it
 * instead of from here and no registration happens at load (the engine is side-effect free).
 */
export function areaText(table: BuilderTextTable): {
  builderText: typeof builderText;
  builderPlural: typeof builderPlural;
  builderTemplateParts: typeof builderTemplateParts;
  formatListText: typeof formatListText;
  areaWords: (words?: BuilderWords) => BuilderWords;
} {
  const tables = [table];
  const widen = (options: BuilderTextOptions | undefined): BuilderTextOptions => ({ ...options, tables: [...(options?.tables ?? []), ...tables] });
  return {
    builderText: (key, params, options) => builderText(key, params, widen(options)),
    builderPlural: (baseKey, count, params, options) => builderPlural(baseKey, count, params, widen(options)),
    builderTemplateParts: (key, options) => builderTemplateParts(key, widen(options)),
    formatListText: (items, options) => formatListText(items, { ...widen(options), type: options.type }),
    areaWords: (words) => (words ?? new BuilderWords()).with(table)
  };
}
