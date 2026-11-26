/**
 * `try_it { action: 'settings' }`: how Try it's
 * stand-in server answers Submit (`setTrySubmission`) and stand-in option lists for data sources
 * (`setSimulatedDataSource`), both session state held by the controller and never the
 * definition. The change is journaled in the outside journal (`settings`),
 * so Undo all, Stop, `end_session { undo: true }` and the notice's Undo put back what the agent
 * replaced, and the result names the one call that reverses it (`reverse`).
 *
 * The settings are checked before anything is set: `normalizeTrySubmission` would keep the old
 * value of anything out of range silently, so a bad value is `bad-input` here, never a no-op. A
 * stand-in list is read exactly as the Settings panel reads its box (`parseSimulatedOptions`,
 * moved below the shell for this), under the same caps.
 *
 * Imported only by `agentpart-try.ts`. Pure over the controller; nothing at import time.
 */
import type { BuilderController } from "../../builder/controller/builder-controller.js";
import { parseSimulatedOptions } from "../../builder/controller/simulated-options.js";
import { normalizeTrySubmission, type TrySubmissionSettings, type TrySubmissionUpdate } from "../../builder/controller/try-submission.js";
import { readSourceId } from "../../core/schema/data-source-capability.js";
import { MAX_IMPORTED_OPTIONS } from "../../core/schema/inline-options.js";
import type { ComponentNode } from "../../core/schema/types.js";
import { ToolRefusal } from "../tool-types.js";
import { SENTINEL_TOOLS, type BuilderCallScope } from "./context.js";
import type { SimulatedItems } from "./outside-journal.js";
import { badInput, tooLarge } from "./try-fields.js";
import type { ReverseCall, TryItResult } from "./types.js";

/** At most this many data sources per call. */
export const SOURCES_CAP = 20;
/** The `known` list of an `unknown-source` refusal, and the read's source list. */
const KNOWN_CAP = 50;
const SOURCES_LISTED_CAP = 100;
const USED_BY_CAP = 10;

const SUBMISSION_KEYS = ["outcome", "delayMs", "statusText", "statusPlacement", "refusalMessage", "afterAccept", "receipt"] as const;
const RECEIPT_KEYS = ["kind", "title", "message", "detailLabel", "referencePattern", "placement"] as const;

/** One `sources[]` item as the schema admits it. */
interface SourceInput {
  sourceId?: unknown;
  options?: unknown;
  clear?: unknown;
}

/** What a settings call plans before it sets anything. */
export interface SettingsPlan {
  update?: TrySubmissionUpdate;
  sources: Array<{ sourceId: string; items: SimulatedItems | undefined }>;
  warnings: string[];
}

/** Every component id that reads each data source (`configuration.data.sourceId`), in document order. */
function readersOf(root: ComponentNode): Map<string, string[]> {
  const readers = new Map<string, string[]>();
  const visit = (node: ComponentNode): void => {
    const sourceId = readSourceId(node.configuration);
    if (sourceId !== undefined) {
      readers.set(sourceId, [...(readers.get(sourceId) ?? []), node.id]);
    }
    for (const children of Object.values(node.children ?? {})) {
      for (const child of children ?? []) {
        visit(child);
      }
    }
  };
  visit(root);
  return readers;
}

/** The ids a stand-in list may be given: the wired and host ids (`dataSourceIds`), then any a component reads. */
export function knownSourceIds(controller: BuilderController): string[] {
  return [...new Set([...controller.dataSourceIds(), ...readersOf(controller.snapshot()).keys()])];
}

/** `settings.sources`: each known source, whether a stand-in, the site or nothing answers it. */
export function sourcesState(controller: BuilderController): NonNullable<TryItResult["settings"]>["sources"] {
  const readers = readersOf(controller.snapshot());
  const host = new Set(controller.hostDataSourceIdList());
  const simulated = controller.simulatedDataSources();
  return knownSourceIds(controller)
    .slice(0, SOURCES_LISTED_CAP)
    .map((sourceId) => {
      const items = simulated.get(sourceId);
      const entry: NonNullable<TryItResult["settings"]>["sources"][number] = {
        sourceId,
        state: items !== undefined ? "simulated" : host.has(sourceId) ? "host" : "missing",
        usedBy: (readers.get(sourceId) ?? []).slice(0, USED_BY_CAP)
      };
      if (items !== undefined) {
        entry.simulatedOptions = items.length;
      }
      return entry;
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Checks a settings call and reads its lists : at least one
 * of `trySubmission` / `sources`; each source with `sourceId` and exactly one of `options` /
 * `clear: true`; placements not empty; at most 20 sources of at most 2 000 options. Throws
 * `bad-input`, `too-large` or `unknown-source`; nothing has been set yet.
 */
export function planSettings(scope: BuilderCallScope, input: Record<string, unknown>): SettingsPlan {
  const warnings: string[] = [];
  const problems: Array<{ key: string; expected: string }> = [];
  const submission = input.trySubmission;
  const sources = input.sources;
  if (submission === undefined && sources === undefined) {
    throw badInput([{ key: "trySubmission", expected: "trySubmission or sources for action 'settings'" }]);
  }
  let update: TrySubmissionUpdate | undefined;
  if (isRecord(submission)) {
    for (const key of Object.keys(submission)) {
      if (!(SUBMISSION_KEYS as readonly string[]).includes(key)) {
        warnings.push(`ignored unknown argument: trySubmission.${key}`);
      }
    }
    const receipt = submission.receipt;
    if (isRecord(receipt)) {
      for (const key of Object.keys(receipt)) {
        if (!(RECEIPT_KEYS as readonly string[]).includes(key)) {
          warnings.push(`ignored unknown argument: trySubmission.receipt.${key}`);
        }
      }
      if (Array.isArray(receipt.placement) && receipt.placement.length === 0) {
        problems.push({ key: "trySubmission.receipt.placement", expected: "at least one of top, bottom" });
      }
    }
    if (Array.isArray(submission.statusPlacement) && submission.statusPlacement.length === 0) {
      problems.push({ key: "trySubmission.statusPlacement", expected: "at least one of top, bottom" });
    }
    update = {};
    for (const key of SUBMISSION_KEYS) {
      if (key !== "receipt" && submission[key] !== undefined) {
        (update as Record<string, unknown>)[key] = submission[key];
      }
    }
    if (isRecord(receipt)) {
      const partial: Record<string, unknown> = {};
      for (const key of RECEIPT_KEYS) {
        if (receipt[key] !== undefined) {
          partial[key] = receipt[key];
        }
      }
      update.receipt = partial;
    }
  }
  const planned: SettingsPlan["sources"] = [];
  if (Array.isArray(sources)) {
    if (sources.length > SOURCES_CAP) {
      throw tooLarge("sources", SOURCES_CAP, sources.length);
    }
    sources.forEach((raw: unknown, at) => {
      const item = (isRecord(raw) ? raw : {}) as SourceInput;
      for (const key of Object.keys(item)) {
        if (key !== "sourceId" && key !== "options" && key !== "clear") {
          warnings.push(`ignored unknown argument: sources[${at}].${key}`);
        }
      }
      if (typeof item.sourceId !== "string" || item.sourceId === "") {
        problems.push({ key: `sources[${at}].sourceId`, expected: "required" });
      }
      const clears = item.clear === true;
      if (item.options === undefined && !clears) {
        problems.push({ key: `sources[${at}]`, expected: "options, or clear: true" });
      } else if (item.options !== undefined && clears) {
        problems.push({ key: `sources[${at}]`, expected: "exactly one of options and clear: true" });
      }
    });
  }
  if (problems.length > 0) {
    throw badInput(problems);
  }
  if (Array.isArray(sources)) {
    const controller = scope.controller;
    const known = knownSourceIds(controller);
    const host = new Set(controller.hostDataSourceIdList());
    for (const [at, raw] of (sources as SourceInput[]).entries()) {
      const sourceId = raw.sourceId as string;
      if (!known.includes(sourceId)) {
        throw new ToolRefusal(
          "unknown-source",
          `No data source has the id "${sourceId}" in this builder.`,
          `Use one of the listed data-source ids (${SENTINEL_TOOLS.describeBuilder} dataSourceIds).`,
          { sourceId, known: known.slice(0, KNOWN_CAP) }
        );
      }
      if (raw.clear === true) {
        planned.push({ sourceId, items: undefined });
        continue;
      }
      const options = raw.options as unknown[];
      if (options.length > MAX_IMPORTED_OPTIONS) {
        throw tooLarge(`sources[${at}].options`, MAX_IMPORTED_OPTIONS, options.length);
      }
      // Read exactly as the Settings panel's box reads a JSON list (its caps, its words).
      const items = parseSimulatedOptions(JSON.stringify(options), scope.words);
      if (typeof items === "string") {
        throw badInput([{ key: `sources[${at}].options`, expected: items }]);
      }
      planned.push({ sourceId, items });
      if (host.has(sourceId)) {
        warnings.push(`host-source: the site's list for ${sourceId} is replaced in the builder's preview only`);
      }
    }
  }
  const plan: SettingsPlan = { sources: planned, warnings };
  if (update !== undefined) {
    plan.update = update;
  }
  return plan;
}

/** The submission settings' keys a change moved: `"trySubmission.outcome"`, `"trySubmission.receipt.title"`. */
export function submissionChanges(before: TrySubmissionSettings, after: TrySubmissionSettings): string[] {
  const changed: string[] = [];
  for (const key of SUBMISSION_KEYS) {
    if (key === "receipt") {
      for (const inner of RECEIPT_KEYS) {
        if (JSON.stringify(before.receipt[inner]) !== JSON.stringify(after.receipt[inner])) {
          changed.push(`trySubmission.receipt.${inner}`);
        }
      }
      continue;
    }
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      changed.push(`trySubmission.${key}`);
    }
  }
  return changed;
}

/** What `setTrySubmission` would leave, without setting it. */
export function previewSubmission(before: TrySubmissionSettings, update: TrySubmissionUpdate): TrySubmissionSettings {
  return normalizeTrySubmission(update, before);
}

/** A stand-in list as `options` takes it back: `{ value, label }` objects. */
function optionsOf(items: SimulatedItems): Array<{ value: string; label: unknown }> {
  return items.map((item) => ({ value: String(item.value), label: item.label }));
}

/**
 * The one call that puts back what this call changed: the
 * submission settings' changed keys at their earlier values, each source's earlier list (or
 * `clear: true` where there was none).
 */
export function reverseOf(
  before: TrySubmissionSettings | undefined,
  changedKeys: readonly string[],
  sources: ReadonlyArray<{ sourceId: string; before: SimulatedItems | undefined }>
): ReverseCall & { tool: "try_it" } {
  const input: Record<string, unknown> = { action: "settings" };
  if (before !== undefined && changedKeys.length > 0) {
    const submission: Record<string, unknown> = {};
    const receipt: Record<string, unknown> = {};
    for (const key of changedKeys) {
      const [, name, inner] = key.split(".");
      if (name === "receipt" && inner !== undefined) {
        receipt[inner] = (before.receipt as unknown as Record<string, unknown>)[inner];
      } else if (name !== undefined) {
        submission[name] = (before as unknown as Record<string, unknown>)[name];
      }
    }
    if (Object.keys(receipt).length > 0) {
      submission.receipt = receipt;
    }
    input.trySubmission = JSON.parse(JSON.stringify(submission)) as unknown;
  }
  if (sources.length > 0) {
    input.sources = sources.map((source) => (source.before === undefined ? { sourceId: source.sourceId, clear: true } : { sourceId: source.sourceId, options: JSON.parse(JSON.stringify(optionsOf(source.before))) as unknown }));
  }
  return { tool: "try_it", input };
}
