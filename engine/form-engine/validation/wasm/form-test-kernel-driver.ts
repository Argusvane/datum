import type { Expression } from "../../core/expressions/expression.js";
import type { FormulaFunctionSignature, FormulaProblem } from "../../core/expressions/formula-types.js";
import type { FormTestDriver, FormTestGiven, FormTestSnapshot, FormTestValue } from "../../core/form-tests/form-test-types.js";
import type { JourneyTrace } from "../../core/journey/journey-types.js";
import type { Journey } from "../../core/schema/journey.js";
import type { ComponentNode, FormDefinition } from "../../core/schema/types.js";
import { kernelCompileDefinition, kernelFormulaPolicy } from "../../core/expressions/compile.js";
import { kernelParseFormula } from "../../core/expressions/formula.js";
import { formulaFunctionSignatures } from "../../core/expressions/function-table.js";
import { kernelRulesInventory } from "../../core/expressions/inspect.js";
import { journeyReachable } from "../../core/journey/journey-path.js";
import {
  layerValidationMessages,
  readValidationMessages,
  resolveValidationMessage,
  type ValidationMessageCatalog
} from "../../core/localization/validation-messages.js";
import { supportedLocaleCodes } from "../../core/localization/supported-locales.js";
import type { FormTranslations } from "../../core/localization/translations.js";
import { readPdfConfiguration } from "../../core/schema/pdf-layout-read.js";
import { kernelOwn } from "../../core/state/submittable-fold.js";
import { selectPdfLayoutForValues } from "../../render/pdf/pdf-layout-selection.js";
import { kernelEvaluateExpression, type RuleEvaluationContext } from "../../rules/evaluator/evaluator.js";
import {
  kernelFoldSubmission,
  kernelFormTestServerAddRow,
  kernelFormTestServerAnswerFor,
  kernelFormTestServerNotScalar,
  kernelFormTestServerRowNotScalar,
  kernelFormTestServerOffered,
  kernelFormTestServerRowAnswers,
  kernelFormTestServerAnswers,
  kernelFormTestServerAnyBlocking,
  kernelFormTestServerBackPage,
  kernelFormTestServerCloseReads,
  kernelFormTestServerChange,
  kernelFormTestServerComplete,
  kernelFormTestServerMove,
  kernelFormTestServerReturning,
  kernelFormTestServerComponentIdOf,
  kernelFormTestServerDeferred,
  kernelFormTestServerEffective,
  kernelFormTestServerEvaluation,
  kernelFormTestServerFoldValues,
  kernelFormTestServerHostValue,
  kernelFormTestServerIndex,
  kernelFormTestServerKeepShown,
  kernelFormTestServerMarkTrace,
  kernelFormTestServerNextPage,
  kernelFormTestServerPage,
  kernelFormTestServerPageErrors,
  kernelFormTestServerPageOrder,
  kernelFormTestServerPut,
  kernelFormTestServerReconcile,
  kernelFormTestServerRemoveRow,
  kernelFormTestServerRequired,
  kernelFormTestServerRevealPage,
  kernelFormTestServerOnReview,
  kernelFormTestServerRowCounts,
  kernelFormTestServerRowLimit,
  kernelFormTestServerRowRefusal,
  kernelFormTestServerSeedRows,
  kernelFormTestServerSelectJourney,
  kernelFormTestServerShownBlocks,
  kernelFormTestServerSnapshotError,
  kernelFormTestServerUnreplayable,
  kernelFormTestServerValues,
  kernelFormTestServerVerdictReason,
  kernelFormTestServerWrite,
  kernelIsJourney,
  kernelNormalizeDataGrids,
  kernelPrepareDefinition,
  kernelRowKeyParts,
  type FormTestServerNavigation,
  type KernelPrepared,
  type KernelSubmissionFold
} from "./portable-kernel.js";
import { kernelOptionChoiceOf, kernelOptionSourceId, type KernelOptionSnapshot } from "./portable-options.js";
import {
  WasmValidationHost,
  type WasmSandboxPolicy,
  type WasmSubmissionContext,
  type WasmSubmissionOutcome,
  type WasmUnknownFieldsMode,
  type WasmValidationError
} from "./wasm-validation-host.js";

// The list the sandbox splices, kept importable from here where the tests and the name checks read it.
export { FORM_TEST_KERNEL_DRIVER_FUNCTIONS } from "./portable-kernel.js";

/**
 * The validation kernel's driver for form tests: the server's reading of
 * a scenario. It holds the answers itself, as a host holds a stored record, and asks the
 * kernel (`WasmValidationHost.run`, in process or a sandbox program) for every fact a snapshot
 * reports: each snapshot and each move comes from a run over the current answers with
 * `reportFold` set and the scenario's journey and day in the context. Nothing here works a
 * verdict, a path or a state out on its own; what the outcome does not carry (requiredness,
 * the id-keyed settled view, the effective state of components the error filter cannot act
 * on) is read from the kernel's own fold (`kernelFoldSubmission`) over the very inputs the run
 * took, which is the reading the outcome summarises.
 *
 * The logic is split the way the kernel's own modules are: the `kernelFormTestServer*`
 * functions are kernel-shaped (top-level declarations, records without a prototype, own reads
 * only, no clock, no locale, no throws: a refusal is a return value), live in
 * `portable-kernel.ts` and are spliced into the sandbox program, where the `test` op
 * (`kernelFormTestOp`) walks a scenario with them exactly as this driver
 * does. {@link createFormTestKernelDriver} is ordinary engine code around them: it awaits the
 * host, words messages from the form's catalogs and picks the PDF layout through the renderer's
 * selection; the op carries kernel-shaped copies of those two readings, held to these by
 * `engine/tests/form-tests/kernel-test-op.test.ts`. A change to this driver's walk is a change
 * to the op's too.
 *
 * Readings this side takes, each the browser runtime's counterpart:
 * - The answers are flat value-path keys, as the runtime keeps them, and each repeating
 *   section's entries a list of row objects posted at its collection path (`items: [{ qty }]`),
 *   which the kernel reads as `items[0].qty` (`kernelFlattenRows`); a row with no answer is
 *   posted as `{}`, so the kernel counts it, as the runtime's row list does.
 * - The errors a snapshot carries are the ones on show: what the last `check`, `continue` or
 *   `submit` found, a page's check replacing those on the page's components, as the runtime's
 *   error store keeps them. An answer written in between does not validate (the runtime's
 *   `setValue` does not either).
 * - Continue, Back and a jump follow the runtime's journey navigation: Continue checks the page
 *   (a deferred page only when it holds an error that blocks) and moves to the next page on the
 *   path as the answers then draw it, marking the page completed; Back takes the page before on
 *   the path; a jump goes only to a page at or before the frontier (`journeyReachable`). After
 *   every change to the answers the completed pages are kept to the path, and a page the path no
 *   longer takes gives way to the last one before it that it does.
 * - The `host.` givens are the runs' host context (`context.hostContext`), built as
 *   the browser's driver builds its runtime's (a dotted name nests): every rule and calculation
 *   reading `host.` is judged against it, a key no given set reading as no answer, as it does
 *   in the browser. A scenario with no `host.` given runs with no context, as a server given
 *   none: the kernel skips every rule reading `host.`, and the components whose rules read it
 *   come back `unreplayable.host` one by one. A rule scoped to the browser comes back
 *   `unreplayable.browser`, a calculation kept as sent because it reads an answer the server
 *   was not sent `unreplayable.clientDerived`. The marks are closed over
 *   rule reads: a component whose rule reads a marked one earns its reason, a page whose `when`
 *   (or a route's) reads one marks the components it places and says so for the path itself
 *   (`traceUnreplayable`: the page, the path, what was withheld or submitted skip). When a
 *   marked component can refuse an answer (it is required, or has a `requiredWhen` or
 *   `validWhen`) the snapshot says so (`verdictUnreplayable`) and the verdict expectations skip:
 *   they name no field, so the field skip cannot cover them.
 * - A data grid opens with its `initialRows` empty rows (within its bounds) as the runtime seeds
 *   them. A row action the runtime turns down (a path that is no collection, an operation the
 *   section does not allow, a row past the most it may hold, a row that is not there) comes
 *   back as the same coded refusal (`unknownCollection`, `operations.add`, `operations.remove`,
 *   `rows.max`, `rowOutOfRange`) and ends the scenario, so both sides report one reason. A
 *   refused submit on a journey takes it to the earliest page on the path holding an error that
 *   blocks (`revealErrorPage`).
 * - The start checks the givens in the order they are written and reports the first bad one
 *   (a journey the form lacks, options for a field with no source, a locale it does not offer);
 *   then the clock, then the formulas: a definition that does not compile under the policy in
 *   force (`fail`) ends the scenario as `scenario.formulaInvalid` with the first five problems.
 * - A form whose rules read the day (`today()`, `age()`, in a component, journey or PDF layout
 *   alike) and a scenario with no `given today` is a start error, `scenario.clockUnset`, as on
 *   the browser's side: a run judged by the real clock would pass today and
 *   fail tomorrow. A locale the form does not offer is `scenario.badGiven`, as `setLocale`
 *   refuses it there.
 */

/** What {@link createFormTestKernelDriver} takes beside the definition. */
export interface FormTestKernelDriverOptions {
  /** The kernel to ask: `createInProcessWasmValidationHost()` or a host over a sandbox program. */
  host: WasmValidationHost;
  /** The sandbox policy each run is made under. Absent: `WasmValidationHost.STRICT_POLICY`. */
  policy?: WasmSandboxPolicy;
  /** What the kernel does with keys the schema does not define. Absent: the kernel's `"strip"`. */
  unknownFields?: WasmUnknownFieldsMode;
  /**
   * The formula functions the host's plugins register, for the in-process readings the outcome
   * does not carry (requiredness, the settled view) and for `expect <formula>`. They must be
   * the functions the host itself was wired with, or those readings drift from the run's.
   */
  functions?: Record<string, (args: unknown[]) => unknown>;
  /** The parser's signatures for those readings. Absent: the built-in table's, plus one per function in `functions`. */
  signatures?: FormulaFunctionSignature[];
}

// The kernel-shaped half of this driver (the `kernelFormTestServer*` functions) lives in
// `portable-kernel.ts`: the sandbox's `test` op runs it there.

/** One run's outcome with the answers it was over, so a snapshot after it reads the same run. */
interface FormTestServerRun {
  outcome: WasmSubmissionOutcome;
  values: Record<string, unknown>;
}

/**
 * The validation kernel's {@link FormTestDriver}: the server's reading of a scenario.
 * One driver per scenario; `start` reads the givens and makes the first run.
 */
export function createFormTestKernelDriver(definition: FormDefinition, options: FormTestKernelDriverOptions): FormTestDriver {
  const host = options.host;
  const policy = options.policy ?? WasmValidationHost.STRICT_POLICY;
  const functions = options.functions;
  const signatures: FormulaFunctionSignature[] =
    options.signatures ?? [
      ...formulaFunctionSignatures(),
      ...Object.keys(functions ?? {}).map((name) => ({ name, min: 0, max: Number.POSITIVE_INFINITY }))
    ];
  // The tree as the run reads it: every data grid bound, every formula compiled, as
  // `runKernel` prepares it. Prepared again in `start` once the journey is known.
  const authored = kernelNormalizeDataGrids(definition.root);
  const formulaPolicy = kernelFormulaPolicy(authored.configuration, undefined);
  let prepared: KernelPrepared = kernelPrepareDefinition(authored, undefined, undefined, formulaPolicy, undefined, signatures);
  const index = kernelFormTestServerIndex(prepared.root);
  const hasLayouts = readPdfConfiguration(definition).length > 0;
  // What reads the clock anywhere in the definition (component rules, page and route
  // conditions, PDF layouts), as the browser's driver reads it: a scenario must then name the day.
  const readsClock = (() => {
    const used = kernelRulesInventory(definition, kernelParseFormula, signatures).functionsUsed;
    return used.includes("today") || used.includes("age");
  })();
  const offeredLocales = supportedLocaleCodes(definition.localization);
  // The catalogs per locale the scenario shows messages in, worked out on first use (a scenario may switch locale).
  const catalogsByLocale = new Map<string, { catalogs: Map<string, ValidationMessageCatalog | undefined>; root: ValidationMessageCatalog | undefined }>();
  const wordedFor = (shown: string) => {
    let worded = catalogsByLocale.get(shown);
    if (worded === undefined) {
      worded = {
        catalogs: messageCatalogs(definition.root, shown, definition.translations),
        root: readValidationMessages(definition.root.configuration, { locale: shown, sources: { translations: definition.translations } })
      };
      catalogsByLocale.set(shown, worded);
    }
    return worded;
  };

  const answers = kernelFormTestServerAnswers();
  const navigation: FormTestServerNavigation = { page: undefined, completed: [] };
  let journey: Journey | undefined;
  // The compiled journey the fold reads, when the kernel would read one (its shape usable).
  let foldJourney: Journey | undefined;
  let pageOrder: string[] = [];
  let today: string | undefined;
  let locale: string = typeof definition.localization?.defaultLocale === "string" ? definition.localization.defaultLocale : "en";
  let optionSnapshot: KernelOptionSnapshot | undefined;
  // The errors on show, as the run reported them: worded only when a snapshot is taken.
  let shown: WasmValidationError[] = [];
  let verdict: "accepted" | "refused" | undefined;
  let submitted: Record<string, unknown> | undefined;
  let withheld: string[] | undefined;
  let last: FormTestServerRun | undefined;
  // What the scenario's `host.` givens make; absent when it gives none.
  let hostContext: Record<string, unknown> | undefined;

  function word(error: WasmValidationError): string {
    const worded = wordedFor(locale);
    const catalog = (error.componentId !== undefined ? worded.catalogs.get(error.componentId) : undefined) ?? worded.root;
    return resolveValidationMessage(error, catalog, locale, { translations: definition.translations });
  }


  /** A kernel run over the current answers; `page` asks the kernel to scope a page's components. */
  async function run(page?: string): Promise<FormTestServerRun> {
    const values = kernelFormTestServerValues(answers);
    const context: WasmSubmissionContext = { form: definition.root, values, formId: definition.id, locale, reportFold: true };
    if (definition.translations !== undefined) {
      context.translations = definition.translations;
    }
    if (definition.kinds !== undefined) {
      context.kinds = definition.kinds;
    }
    if (journey !== undefined) {
      context.journey = journey;
      if (page !== undefined) {
        context.page = page;
      }
    }
    if (today !== undefined) {
      context.today = today;
    }
    if (hostContext !== undefined) {
      context.hostContext = hostContext;
    }
    if (options.unknownFields !== undefined) {
      context.unknownFields = options.unknownFields;
    }
    if (optionSnapshot !== undefined) {
      context.optionSnapshot = optionSnapshot;
    }
    const outcome = await host.run({ context, policy });
    last = { outcome, values };
    return last;
  }

  /** The last run, made again when the answers moved since. */
  async function current(): Promise<FormTestServerRun> {
    return last ?? (await run());
  }

  /** After an answer changed: the run is stale, and with a journey the page and completed pages follow the new path. */
  async function answersChanged(): Promise<void> {
    last = undefined;
    if (journey !== undefined) {
      const fresh = await run();
      kernelFormTestServerReconcile(navigation, fresh.outcome.trace, pageOrder);
    }
  }

  /** A page's check: the run, the errors it keeps to the page, and the errors on show replaced within the page. */
  async function checkPage(page: string): Promise<{ blocks: boolean; trace: JourneyTrace | undefined; withheld: string[] | undefined }> {
    const checked = await run(page);
    const scope = checked.outcome.pageComponentIds;
    const found = kernelFormTestServerPageErrors(checked.outcome.errors, scope);
    shown = kernelFormTestServerKeepShown(shown, found, scope);
    // What the run withheld is reported, not stored: only a `check` or a `submit` sets the
    // scenario's `withheld`, as the runtime's Continue sets nothing of the outcome.
    return {
      blocks: kernelFormTestServerAnyBlocking(found),
      trace: checked.outcome.trace,
      withheld: checked.outcome.withheld !== undefined ? [...checked.outcome.withheld] : undefined
    };
  }

  /**
   * What the definition's compile finds wrong in its formulas: the form, every journey and the
   * PDF layouts, compiled as the runtime's constructor compiles them (`compileFormDefinition`),
   * so a definition the browser refuses under `fail` is refused here too.
   */
  function formulaProblems(): FormulaProblem[] {
    return kernelCompileDefinition(authored, definition.journey, definition.pdf, kernelParseFormula, signatures, undefined).problems;
  }

  /** The kernel's fold over the inputs `judged` was run with: what the outcome summarises. */
  function fold(judged: FormTestServerRun): KernelSubmissionFold {
    return foldOver(judged.values);
  }

  /** The kernel's fold over answers as the run takes them (the same normalise, partition, day and functions). */
  function foldOver(values: Record<string, unknown>): KernelSubmissionFold {
    return kernelFoldSubmission(
      prepared.root,
      kernelFormTestServerFoldValues(prepared, values, options.unknownFields),
      foldJourney,
      kernelFormTestServerEvaluation(prepared, today, functions, hostContext),
      prepared
    );
  }

  /**
   * What the bound formulas of the data grids come to over the answers as they stand: the fold's
   * `rowBounds`, worked out in process (no sandbox run) the way the outcome's would be. Only a
   * grid with a `rules.minRows` / `rules.maxRows` formula has an entry, so a form without one
   * folds nothing here.
   */
  function rowBoundsNow(collection: string): Record<string, { min?: unknown; max?: unknown }> | undefined {
    const id = kernelOwn(index.collections, collection);
    const node = id === undefined ? undefined : kernelOwn(index.nodeById, id);
    const rules = node !== undefined && node.type === "dataGrid" ? (node.rules as Record<string, unknown> | undefined) : undefined;
    if (rules === undefined || (kernelOwn(rules, "minRows") === undefined && kernelOwn(rules, "maxRows") === undefined)) {
      return undefined;
    }
    return foldOver(kernelFormTestServerValues(answers)).rowBounds;
  }

  return {
    async start(givens: FormTestGiven[]) {
      let journeyGiven: string | undefined;
      const snapshot: KernelOptionSnapshot = {};
      let anyOptions = false;
      for (const given of givens) {
        switch (given.key) {
          case "today":
            today = given.value;
            break;
          case "locale":
            // Each given is checked where it stands, so the first bad one in source order is the
            // one reported, as the browser's driver does. `setLocale` refuses a locale the form
            // does not offer; so does this side.
            if (offeredLocales.length > 0 && !offeredLocales.includes(given.value)) {
              return { error: "scenario.badGiven", params: { given: "locale", locale: given.value } };
            }
            locale = given.value;
            break;
          case "journey": {
            const named = kernelFormTestServerSelectJourney(definition.journey, given.value);
            if (named.error !== undefined) {
              return { error: named.error, params: { journey: given.value } };
            }
            journeyGiven = given.value;
            break;
          }
          case "host":
            // The scenario's host values are the runs' host context, as a server supplies one.
            hostContext ??= Object.create(null) as Record<string, unknown>;
            kernelFormTestServerHostValue(hostContext, given.name, given.value);
            break;
          case "options": {
            const id = kernelFormTestServerComponentIdOf(index, given.path);
            const node = id !== undefined ? kernelOwn(index.nodeById, id) : undefined;
            const sourceId = node !== undefined ? kernelOptionSourceId(node.configuration) : undefined;
            if (sourceId === undefined) {
              return { error: "scenario.badGiven", params: { given: "options", path: given.path, reason: id === undefined ? "unknownField" : "noSource" } };
            }
            kernelFormTestServerPut(snapshot as Record<string, unknown>, sourceId, given.values.map((value) => ({ value: String(value) })));
            anyOptions = true;
            break;
          }
        }
      }
      optionSnapshot = anyOptions ? snapshot : undefined;
      // The journey was checked where it was given; here only the one it names (or the default) is read.
      const selected = kernelFormTestServerSelectJourney(definition.journey, journeyGiven);
      // The day is the scenario's, never the machine's.
      if (readsClock && today === undefined) {
        return { error: "scenario.clockUnset" };
      }
      // A definition whose formulas do not compile under the policy in force is no form to
      // test (the runtime's constructor refuses it the same way): the scenario ends on it.
      const problems = formulaProblems();
      if (formulaPolicy === "fail" && problems.length > 0) {
        return { error: "scenario.formulaInvalid", params: { problems: problems.slice(0, 5).map((problem) => ({ code: problem.code, where: problem.where })) } };
      }
      journey = selected.journey;
      pageOrder = kernelFormTestServerPageOrder(journey);
      // A data grid opens with its starting rows, before the first run reads the answers.
      kernelFormTestServerSeedRows(answers, index);
      if (journey !== undefined) {
        prepared = kernelPrepareDefinition(authored, journey, undefined, formulaPolicy, undefined, signatures);
        foldJourney = kernelIsJourney(prepared.journey) ? prepared.journey : undefined;
        // Nothing is completed when a journey starts: it opens on the first page on the path.
        const opened = await run();
        kernelFormTestServerReconcile(navigation, opened.outcome.trace, pageOrder);
      }
      return undefined;
    },

    async set(path: string, value: FormTestValue) {
      const id = kernelFormTestServerComponentIdOf(index, path);
      const node = id !== undefined ? kernelOwn(index.nodeById, id) : undefined;
      // A list on a field that holds one value: the runtime's write refuses it, and so does this side.
      if (kernelFormTestServerNotScalar(node?.type, value)) {
        return { refused: "value.notScalar", params: { path } };
      }
      // The group's options, to store the unpicked ones `false` as the renderer does.
      const offered = kernelFormTestServerOffered(node, optionSnapshot);
      // A write past the last row adds rows up to it, never past the most a person could add (the
      // grid's maximum as its formula resolves it now, else the cap every collection is drawn to):
      // the write is refused, worded as the add's `rows.max`, as the browser's driver words it.
      const rowParts = kernelRowKeyParts(path, index.lists);
      const limit = rowParts !== undefined ? kernelFormTestServerRowLimit(index, rowParts.collection, rowBoundsNow(rowParts.collection)) : undefined;
      if (!kernelFormTestServerWrite(answers, index.lists, path, kernelFormTestServerAnswerFor(node?.type, value, offered), limit)) {
        return { refused: "rows.max", params: { path: rowParts !== undefined ? rowParts.collection : path, max: limit } };
      }
      await answersChanged();
      return undefined;
    },

    async clear(path: string) {
      kernelFormTestServerWrite(answers, index.lists, path, undefined);
      await answersChanged();
    },

    async addRow(path: string, values?: Record<string, FormTestValue>) {
      // A list in a cell that holds one value: the runtime's add refuses it as its write does, and
      // so does this side, naming the cell of the row the add would make.
      const notScalar = kernelFormTestServerRowNotScalar(path, kernelOwn(answers.rows, path)?.length ?? 0, values, (cell) => {
        const id = kernelFormTestServerComponentIdOf(index, cell);
        return id !== undefined ? kernelOwn(index.nodeById, id)?.type : undefined;
      });
      if (notScalar !== undefined) {
        return { refused: "value.notScalar", params: { path: notScalar } };
      }
      // The refusals the runtime makes (not a collection, adding not allowed, the most rows
      // held), as the same coded reasons: the runner records them, no sentence crosses.
      const refusal = kernelFormTestServerRowRefusal(answers, index, path, "add", -1, rowBoundsNow(path));
      if (refusal !== undefined) {
        return { refused: refusal.refused, params: { ...refusal.params } };
      }
      // Each cell as a `set` of it stores it: a list on a checkbox group is the group's record.
      const cells = kernelFormTestServerRowAnswers(path, kernelOwn(answers.rows, path)?.length ?? 0, values, (cell, value) => {
        const id = kernelFormTestServerComponentIdOf(index, cell);
        const owner = id !== undefined ? kernelOwn(index.nodeById, id) : undefined;
        return kernelFormTestServerAnswerFor(owner?.type, value, kernelFormTestServerOffered(owner, optionSnapshot));
      });
      kernelFormTestServerAddRow(answers, index.lists, path, cells);
      await answersChanged();
      return undefined;
    },

    async removeRow(path: string, rowIndex: number) {
      const refusal = kernelFormTestServerRowRefusal(answers, index, path, "remove", rowIndex);
      if (refusal !== undefined) {
        return { refused: refusal.refused, params: { ...refusal.params } };
      }
      kernelFormTestServerRemoveRow(answers, index.lists, path, rowIndex);
      await answersChanged();
      return undefined;
    },

    async continue() {
      const page = navigation.page;
      if (journey === undefined || page === undefined) {
        return;
      }
      const authoredPage = kernelFormTestServerPage(journey, page);
      // An exit page neither continues nor submits; the last page submits rather than continues.
      if (authoredPage !== undefined && authoredPage.kind === "exit") {
        return;
      }
      let trace = (await current()).outcome.trace;
      if (kernelFormTestServerNextPage(trace, page) === undefined) {
        return;
      }
      // A deferred page moves on unchecked, unless an error on show that blocks stands on it.
      let validate = true;
      if (kernelFormTestServerDeferred(journey, authoredPage)) {
        const scoped = await run(page);
        validate = kernelFormTestServerShownBlocks(shown, scoped.outcome.pageComponentIds);
        trace = scoped.outcome.trace;
      }
      if (validate) {
        const checked = await checkPage(page);
        if (checked.blocks) {
          return;
        }
        trace = checked.trace;
      }
      // On the way back from a Change link: the first page not yet completed, else the review page.
      const returning = kernelFormTestServerReturning(journey, trace, navigation);
      const target = returning !== undefined ? returning : kernelFormTestServerNextPage(trace, page);
      if (target === undefined) {
        return;
      }
      kernelFormTestServerComplete(navigation, page);
      kernelFormTestServerMove(navigation, target, returning !== undefined);
    },

    async back() {
      if (journey === undefined) {
        return;
      }
      const trace = (await current()).outcome.trace;
      const returning = kernelFormTestServerReturning(journey, trace, navigation);
      const target =
        returning !== undefined && navigation.page !== undefined && navigation.completed.indexOf(navigation.page) >= 0
          ? returning
          : kernelFormTestServerBackPage(trace, navigation.page);
      if (target !== undefined) {
        kernelFormTestServerMove(navigation, target, returning !== undefined);
      }
    },

    async goTo(page: string) {
      if (journey === undefined || page === navigation.page) {
        return;
      }
      const trace = (await current()).outcome.trace;
      if (trace !== undefined && journeyReachable(trace, navigation.completed, page)) {
        kernelFormTestServerMove(navigation, page, false);
      }
    },

    async change(path: string) {
      const judged = await current();
      return kernelFormTestServerChange(
        journey,
        navigation,
        judged.outcome.trace,
        journey === undefined ? undefined : fold(judged).ownership?.pagesOf,
        kernelFormTestServerComponentIdOf(index, path),
        path
      );
    },

    async check() {
      // A check forgets the last submission, as the runtime's does (`forgetOutcome`): what
      // `expect submitted` reads is the envelope of the last `submit`, not of one before a check.
      submitted = undefined;
      if (journey !== undefined && navigation.page !== undefined) {
        const checked = await checkPage(navigation.page);
        verdict = checked.blocks ? "refused" : "accepted";
        withheld = checked.withheld;
        return;
      }
      const checked = await run();
      shown = checked.outcome.errors;
      withheld = checked.outcome.withheld !== undefined ? [...checked.outcome.withheld] : undefined;
      verdict = kernelFormTestServerAnyBlocking(checked.outcome.errors) ? "refused" : "accepted";
    },

    async submit() {
      const judged = await run();
      const outcome = judged.outcome;
      shown = outcome.errors;
      // The kernel returns `values` exactly when nothing blocked: that is the verdict.
      verdict = outcome.values !== undefined ? "accepted" : "refused";
      submitted = outcome.values !== undefined ? { ...outcome.values } : undefined;
      withheld = outcome.withheld !== undefined ? [...outcome.withheld] : undefined;
      // A refused submit takes a journey to the first page holding an error that blocks, as the
      // runtime does (`revealErrorPage`).
      // On a review page nothing moves: the page lists the errors itself.
      if (verdict === "refused" && journey !== undefined && !kernelFormTestServerOnReview(journey, navigation.page, outcome.trace)) {
        const revealed = kernelFormTestServerRevealPage(outcome.errors, index, fold(judged).ownership?.pagesOf, outcome.trace);
        if (revealed !== undefined) {
          kernelFormTestServerMove(navigation, revealed, false);
        }
      }
    },

    async snapshot(): Promise<FormTestSnapshot> {
      const judged = await current();
      const outcome = judged.outcome;
      const folded = fold(judged);
      const effective = kernelFormTestServerEffective(folded, outcome.effectiveState);
      const byPath = outcome.values ?? outcome.submittable ?? {};
      const reasons = kernelFormTestServerUnreplayable(index, outcome, today, hostContext !== undefined);
      const snapshot: FormTestSnapshot = {
        effective: { ...effective },
        required: { ...kernelFormTestServerRequired(folded, effective) },
        values: { ...folded.idValues },
        byPath: { ...byPath },
        errors: shown.map((error) => ({ ...kernelFormTestServerSnapshotError(error, word(error)) })),
        rows: { ...kernelFormTestServerRowCounts(answers, index.lists) },
        unreplayable: { ...reasons },
        // Every page the journey has, so a page named off the path can be told from a typo.
        pages: journey !== undefined ? [...pageOrder] : []
      };
      // The path a route condition draws over a component this side lacks is not the person's.
      const traceReason = journey !== undefined ? kernelFormTestServerMarkTrace(foldJourney, index, folded.ownership, reasons) : undefined;
      if (traceReason !== undefined) {
        // The components of the pages it reaches are marked now; what reads them follows.
        kernelFormTestServerCloseReads(index, reasons);
        snapshot.traceUnreplayable = traceReason;
        snapshot.unreplayable = { ...reasons };
      }
      const verdictReason = kernelFormTestServerVerdictReason(index, reasons, traceReason);
      if (verdictReason !== undefined) {
        snapshot.verdictUnreplayable = verdictReason;
      }
      if (journey !== undefined && navigation.page !== undefined) {
        snapshot.page = navigation.page;
      }
      if (outcome.trace !== undefined) {
        snapshot.trace = outcome.trace;
      }
      if (verdict !== undefined) {
        snapshot.verdict = verdict;
      }
      if (submitted !== undefined) {
        snapshot.submitted = { ...submitted };
      }
      if (withheld !== undefined) {
        snapshot.withheld = [...withheld];
      }
      if (hasLayouts) {
        const chosen = selectPdfLayoutForValues(definition, byPath, {
          today,
          functions
        }).layout;
        if (chosen !== undefined) {
          snapshot.layout = chosen.id;
        }
      }
      return snapshot;
    },

    evaluate(expression: Expression, values: Record<string, unknown>): unknown {
      const context: RuleEvaluationContext = { values, regexCache: { refuseRisky: true } };
      if (hostContext !== undefined) {
        context.hostContext = hostContext;
      }
      if (today !== undefined) {
        context.today = today;
      }
      if (functions !== undefined) {
        context.functions = functions;
      }
      return kernelEvaluateExpression(expression, context);
    },

    componentIdOf(path: string): string | undefined {
      const id = kernelFormTestServerComponentIdOf(index, path);
      // What a scenario names in an expectation: a row field's bare key (`qty`, no `[n]`) is no
      // field of the form (the kernel stores no answer there), so it fails as an unknown field
      // instead of reading nothing. The browser driver's `componentIdOf` answers the same.
      if (id !== undefined && path.indexOf("[") === -1 && kernelOwn(index.entryFields, id) === true) {
        return undefined;
      }
      return id;
    },

    typeOf(componentId: string): string | undefined {
      return kernelOwn(index.nodeById, componentId)?.type;
    }
  };
}

/**
 * Each component's message catalog as the renderer layers it: its own `messages` (and
 * `patternMessage`) over its containers' over the form's, each worded for `locale` through the
 * definition's `translations` (the root's are the form's own, every other node's its
 * component's), so `expect message on x` reads the sentence the browser would show, in the
 * scenario's locale.
 */
function messageCatalogs(
  root: ComponentNode,
  locale: string,
  translations: FormTranslations | undefined
): Map<string, ValidationMessageCatalog | undefined> {
  const catalogs = new Map<string, ValidationMessageCatalog | undefined>();
  const sources = { translations };
  const walk = (node: ComponentNode, inherited: ValidationMessageCatalog | undefined): void => {
    const own = readValidationMessages(node.configuration, { ownerId: node === root ? undefined : node.id, locale, sources });
    const layered = layerValidationMessages(own, inherited);
    catalogs.set(node.id, layered);
    for (const children of Object.values(node.children ?? {})) {
      for (const child of children) {
        walk(child, layered);
      }
    }
  };
  walk(root, undefined);
  return catalogs;
}
