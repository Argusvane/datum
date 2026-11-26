/**
 * The `languages` body's test page: the adapters fixture and
 * the documents fakes extended, never edited. `languagesBuilder()` registers a builder over the
 * shared Languages fixture (`builder-languages.ts`, used read-only: `languagesRoot()` and
 * `LANGUAGES`) on a `uiStub` with both fake designers, so the Undo all interleave can use a
 * `documents` write beside a `languages` one. The Languages inputs the shell would lend are plain
 * state on `stub.state.languageInputs`; `withOutsideJourney()` and `withOutsidePdfName()` fill them
 * with a journey's name and a layout's, and give the controller the document those defaults are
 * held in (`setOutsideDocuments`), as the shell does. The header's texts are the controller's own.
 */
import type { BuilderController } from "../../form-engine/builder/controller/builder-controller.js";
import type { TranslatableText } from "../../form-engine/builder/controller/builder-controller.js";
import type { OutsideDocument } from "../../form-engine/core/localization/locale-documents.js";
import { addressOf } from "../../form-engine/core/localization/translations.js";
import type { LocalizationConfiguration } from "../../form-engine/core/schema/types.js";
import { documentsBuilder, type DocumentsBuilder, type DocumentsBuilderOptions } from "./agent-builder-documents-fakes.js";
import { languagesController } from "./builder-languages.js";

export interface LanguagesBuilderOptions extends Omit<DocumentsBuilderOptions, "controller" | "root"> {
  /** The form's languages: the shared fixture's `LANGUAGES` by default, `null` for a form that declares none. */
  localization?: LocalizationConfiguration | null;
  controller?: BuilderController;
}

export interface LanguagesBuilder extends DocumentsBuilder {
  controller: BuilderController;
}

/** A builder over the Languages fixture with the fake page around it. */
export function languagesBuilder(options: LanguagesBuilderOptions = {}): LanguagesBuilder {
  const { localization, controller: given, ...rest } = options;
  const controller = given ?? (localization === undefined ? languagesController() : languagesController(localization));
  const set = documentsBuilder({ ...rest, controller });
  return { ...set, controller };
}

/** What the fake journeys document holds: the held value, and every write. */
export interface OutsideJourney {
  value: { name: string };
  writes: number;
}

/**
 * A journey whose name is a text to translate: the row `journeys|journey.intake|name`, its
 * translations the definition's map's (`journeys › intake › name`). The controller gets the document
 * the way the shell lends it, so a new default string lands in the same history entry as the tree's.
 */
export function withOutsideJourney(set: LanguagesBuilder): OutsideJourney {
  const held: OutsideJourney = { value: { name: "Intake" }, writes: 0 };
  const document: OutsideDocument = {
    id: "journeys",
    read: () => held.value,
    write: (value) => {
      held.value = value as OutsideJourney["value"];
      held.writes += 1;
    },
    texts: () => [{ address: addressOf.journey("intake", "name"), default: held.value.name }],
    setDefaults: (value, edits) => {
      const next = { ...(value as OutsideJourney["value"]) };
      for (const edit of edits) {
        if (edit.address.kind === "journeys" && edit.address.path.join(".") === "name") {
          next.name = edit.default;
        }
      }
      return next;
    }
  };
  set.controller.setOutsideDocuments(() => [document]);
  const text: TranslatableText = { componentId: "journey.intake", componentLabel: "Intake", propertyPath: "name", label: "Journey name", default: "Intake", address: addressOf.journey("intake", "name") };
  set.stub.state.languageInputs = { ...set.stub.state.languageInputs, extraTexts: [text] };
  return held;
}

/** What the fake PDF document holds: the layout's name text, and every write. */
export interface OutsidePdf {
  value: { name: string };
  writes: number;
}

/**
 * A PDF layout whose name is a text to translate: the row `pdf|summary|name`
 * (`pdf › summary › name` in the map). The layout is open in the fake designer with `layout` as
 * its controller, and the document's write puts the name on that controller's tree without a step
 * of its history, as the PDF mode does when a layout's new name reaches a built designer (PBM `pushName`).
 */
export function withOutsidePdfName(set: LanguagesBuilder, layout: BuilderController): OutsidePdf {
  const held: OutsidePdf = { value: { name: "Summary" }, writes: 0 };
  const document: OutsideDocument = {
    id: "pdf",
    read: () => held.value,
    write: (value) => {
      held.value = value as OutsidePdf["value"];
      held.writes += 1;
      layout.setPropertyUnrecorded(layout.rootId(), "name", held.value.name);
    },
    texts: () => [{ address: addressOf.pdf("summary", ["name"]), default: held.value.name }],
    setDefaults: (value, edits) => {
      const next = { ...(value as OutsidePdf["value"]) };
      for (const edit of edits) {
        if (edit.address.kind === "pdf" && edit.address.path.join(".") === "name") {
          next.name = edit.default;
        }
      }
      return next;
    }
  };
  set.controller.setOutsideDocuments(() => [document]);
  set.page.pdf.designer.openId = "summary";
  set.page.pdf.designer.controllers.set("summary", layout);
  const text: TranslatableText = { componentId: "summary", componentLabel: "Summary", propertyPath: "name", label: "Layout name", default: "Summary", address: addressOf.pdf("summary", ["name"]) };
  set.stub.state.languageInputs = { ...set.stub.state.languageInputs, pdfTexts: [text] };
  return held;
}
