/**
 * The builder agent tools' English: the words the person sees and hears
 * while an assistant works on the form (the session banner, the notice row under a write, the
 * live region's announcements). They live in the builder agent chunk, never in the builder
 * entry, so a page without the `agent` feature carries none of them (each lazy surface keeps its own English).
 *
 * The lookup is the builder's one (`builderText` through `areaText`), so a host's catalog
 * translates these keys like any other builder key; `BuilderTextKey` names them as a type only.
 * Tool names, descriptions, hints and guidance are not here: they are static English for the
 * agent, not words for the person. The `run_tests` step and
 * reason sentences are not here either: they come from the tests chunk's `createTestsWords`, so
 * every `tests.*` key stays in exactly one table. `engine/tests/builder-texts.test.ts` holds each
 * key to exactly one table.
 */
import { areaText } from "../../builder/logic/builder-texts.js";

export const AGENT_EN = {
  // The session banner: a region in the wrapper's shadow root, outside the inert shell.
  "agent.banner.label": "Assistant",
  "agent.banner.working": "An assistant is working on this form: {purpose}",
  "agent.stop": "Stop",
  "agent.allowAgain": "Allow the assistant again",
  "agent.undoAll": "Undo all ({count})",
  "agent.undo": "Undo",
  "agent.redo": "Redo",
  "agent.dismiss": "Dismiss",
  // The notice row's accessible name, and the polite live region's, when the element host names them.
  "agent.notice.label": "Assistant changes",
  "agent.live.label": "Assistant activity",
  // Announcements at a session's transitions.
  "agent.session.started": "An assistant started working on this form: {purpose}. Press Stop to take over.",
  "agent.session.ended": "The assistant finished: {summary}",
  "agent.session.stopped.one": "The assistant was stopped; {count} change was undone",
  "agent.session.stopped.other": "The assistant was stopped; {count} changes were undone",
  "agent.session.paused": "The assistant paused",
  // What a write did, announced and shown in the notice.
  "agent.did.add.one": "Assistant added {count} component",
  "agent.did.add.other": "Assistant added {count} components",
  "agent.did.replace": "Assistant replaced the form's contents ({count} components)",
  "agent.did.set.one": "Assistant changed {count} property on {label}",
  "agent.did.set.other": "Assistant changed {count} properties on {label}",
  "agent.did.rename": "Assistant renamed {from} to {to}",
  "agent.did.move": "Assistant moved {label}",
  "agent.did.remove.one": "Assistant removed {count} component",
  "agent.did.remove.other": "Assistant removed {count} components",
  "agent.did.duplicate": "Assistant duplicated {label}",
  "agent.did.undo.one": "Assistant undid {count} step",
  "agent.did.undo.other": "Assistant undid {count} steps",
  "agent.did.redo.one": "Assistant redid {count} step",
  "agent.did.redo.other": "Assistant redid {count} steps",
  "agent.did.test.write": "Assistant wrote the test {name}",
  "agent.did.test.remove": "Assistant removed the test {name}",
  // What the five new tools and the identity write did.
  "agent.did.tryFill.one": "Assistant typed {count} answer in Try it",
  "agent.did.tryFill.other": "Assistant typed {count} answers in Try it",
  "agent.did.tryRows": "Assistant changed the rows of {label} in Try it",
  "agent.did.trySettings": "Assistant changed how Try it's stand-in server answers",
  "agent.did.translate.one": "Assistant wrote {count} translation",
  "agent.did.translate.other": "Assistant wrote {count} translations",
  "agent.did.language": "Assistant changed the form's languages",
  "agent.did.document": "Assistant changed {name}",
  "agent.did.mapFields.one": "Assistant mapped {count} PDF field",
  "agent.did.mapFields.other": "Assistant mapped {count} PDF fields",
  "agent.did.createFormFields.one": "Assistant added {count} form field for the PDF",
  "agent.did.createFormFields.other": "Assistant added {count} form fields for the PDF",
  "agent.did.removePart": "Assistant removed {name}",
  "agent.did.save": "Assistant saved the form",
  "agent.did.identity": "Assistant changed the form's identity",
  // One call that changes properties and the identity: a translator owns the joining punctuation.
  "agent.did.setAndIdentity": "{set}. {identity}",
  // The notice's button under a document an assistant removed.
  "agent.restore": "Restore",
  // The ended banner's line after a save inside the session.
  "agent.session.saveBarrier": "The site keeps the version saved at {time}; save again to keep the undo."
} as const;

/** The builder lookups widened with {@link AGENT_EN}; `agentWords` widens a `BuilderWords` the same way. */
export const { builderText: agentText, builderPlural: agentPlural, areaWords: agentWords } = /* @__PURE__ */ areaText(AGENT_EN);
