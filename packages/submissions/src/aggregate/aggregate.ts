import type { FormDefinition } from "@argusvane/datum-engine";

import { answerText } from "../answer-text.js";
import { recordValuesOf } from "../record-values.js";
import type { SubmissionRecord } from "../types.js";
import { walkValueFields, type FieldDescriptor } from "./field-index.js";

/**
 * Statistics over a form's records, computed from the records
 * themselves — they are the truth, they work offline, and a delete changes the numbers. Pure
 * functions over `SubmissionRecord[]`, each one small enough to read: how many came in per
 * day, how a choice was answered, what a number's spread is, how often a field was answered
 * at all, and the breakdowns by locale and form version. An answer is read as the verdict
 * judged it (`recordValuesOf`), never an answer the fold withheld.
 */
export interface DayCount {
  /** `YYYY-MM-DD`, UTC. */
  day: string;
  accepted: number;
  rejected: number;
}

export interface CategoryCount {
  value: string;
  count: number;
}

export interface CategoricalDistribution {
  field: FieldDescriptor;
  /** Records whose answer was present. */
  answered: number;
  counts: CategoryCount[];
  /** Answers beyond the top `limit` values, folded together. */
  other: number;
}

export interface NumericSummary {
  field: FieldDescriptor;
  count: number;
  min: number;
  max: number;
  mean: number;
  median: number;
  p90: number;
  sum: number;
}

export interface CompletionRate {
  field: FieldDescriptor;
  answered: number;
  /** `answered / total`, 0 when there are no records. */
  rate: number;
}

export interface AggregateSpec {
  /** Component ids to profile; every field when absent. */
  fields?: string[];
  /** Days to cover in `perDay`, ending today; every day with records when absent. */
  days?: number;
  /** Values listed per choice field; the rest are folded into `other`. */
  topValues?: number;
  /** Count rejected records as well; only accepted ones by default. */
  includeRejected?: boolean;
  now?: Date;
}

export interface AggregateResult {
  total: number;
  accepted: number;
  rejected: number;
  /** `accepted / total`, 0 when there are no records. */
  acceptanceRate: number;
  perDay: DayCount[];
  byLocale: CategoryCount[];
  byVersion: CategoryCount[];
  bySource: CategoryCount[];
  completion: CompletionRate[];
  choices: CategoricalDistribution[];
  numbers: NumericSummary[];
  /** Fields with a kind statistics have nothing to say about (files, text), listed so a reader knows they were seen. */
  skipped: FieldDescriptor[];
}

function valueAt(values: Record<string, unknown>, path: string): unknown {
  if (path in values) {
    return values[path];
  }
  // Nested answers: `applicant.firstName` may be stored flat or as an object.
  let current: unknown = values;
  for (const part of path.split(".")) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function isAnswered(value: unknown): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === "object") {
    return Object.keys(value as object).length > 0;
  }
  return true;
}

function counted(values: Iterable<string>): CategoryCount[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

export function countPerDay(records: readonly SubmissionRecord[], options: { days?: number; now?: Date } = {}): DayCount[] {
  const byDay = new Map<string, DayCount>();
  for (const record of records) {
    const day = record.receivedAt.slice(0, 10);
    const entry = byDay.get(day) ?? { day, accepted: 0, rejected: 0 };
    entry[record.status] += 1;
    byDay.set(day, entry);
  }
  if (options.days === undefined) {
    return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
  }
  const out: DayCount[] = [];
  const end = options.now ?? new Date();
  for (let offset = options.days - 1; offset >= 0; offset -= 1) {
    const day = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate() - offset)).toISOString().slice(0, 10);
    out.push(byDay.get(day) ?? { day, accepted: 0, rejected: 0 });
  }
  return out;
}

export function categoricalDistribution(records: readonly SubmissionRecord[], field: FieldDescriptor, limit = 10): CategoricalDistribution {
  const answers: string[] = [];
  let answered = 0;
  for (const record of records) {
    const value = valueAt(recordValuesOf(record), field.valuePath);
    if (!isAnswered(value)) {
      continue;
    }
    answered += 1;
    if (Array.isArray(value)) {
      // An entry that is no answer (null) is not a category.
      answers.push(...value.filter((entry) => entry !== null && entry !== undefined).map(answerText));
    } else {
      answers.push(answerText(value));
    }
  }
  const all = counted(answers);
  const counts = all.slice(0, limit);
  const other = all.slice(limit).reduce((sum, entry) => sum + entry.count, 0);
  return { field, answered, counts, other };
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) {
    return Number.NaN;
  }
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  const weight = position - low;
  return sorted[low]! * (1 - weight) + sorted[high]! * weight;
}

export function numericSummary(records: readonly SubmissionRecord[], field: FieldDescriptor): NumericSummary | undefined {
  const numbers: number[] = [];
  for (const record of records) {
    const value = valueAt(recordValuesOf(record), field.valuePath);
    const number = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
    if (Number.isFinite(number)) {
      numbers.push(number);
    }
  }
  if (numbers.length === 0) {
    return undefined;
  }
  numbers.sort((a, b) => a - b);
  const sum = numbers.reduce((total, entry) => total + entry, 0);
  return {
    field,
    count: numbers.length,
    min: numbers[0]!,
    max: numbers[numbers.length - 1]!,
    mean: sum / numbers.length,
    median: quantile(numbers, 0.5),
    p90: quantile(numbers, 0.9),
    sum
  };
}

export function completionRate(records: readonly SubmissionRecord[], field: FieldDescriptor): CompletionRate {
  let answered = 0;
  for (const record of records) {
    if (isAnswered(valueAt(recordValuesOf(record), field.valuePath))) {
      answered += 1;
    }
  }
  return { field, answered, rate: records.length === 0 ? 0 : answered / records.length };
}

export function byLocale(records: readonly SubmissionRecord[]): CategoryCount[] {
  return counted(records.map((record) => record.locale));
}

export function byVersion(records: readonly SubmissionRecord[]): CategoryCount[] {
  return counted(records.map((record) => record.formVersion));
}

export function bySource(records: readonly SubmissionRecord[]): CategoryCount[] {
  return counted(records.map((record) => record.source));
}

/** Everything the Stats view draws, in one pass over the records. */
export function aggregate(records: readonly SubmissionRecord[], definition: FormDefinition, spec: AggregateSpec = {}): AggregateResult {
  const accepted = records.filter((record) => record.status === "accepted");
  const rejected = records.filter((record) => record.status === "rejected");
  const counted = spec.includeRejected ? [...records] : accepted;
  const wanted = spec.fields ? new Set(spec.fields) : undefined;
  const fields = walkValueFields(definition).filter((field) => !wanted || wanted.has(field.componentId));
  const choices: CategoricalDistribution[] = [];
  const numbers: NumericSummary[] = [];
  const skipped: FieldDescriptor[] = [];
  for (const field of fields) {
    if (field.kind === "choice" || field.kind === "multi" || field.kind === "boolean") {
      choices.push(categoricalDistribution(counted, field, spec.topValues ?? 10));
    } else if (field.kind === "number") {
      const summary = numericSummary(counted, field);
      if (summary) {
        numbers.push(summary);
      } else {
        skipped.push(field);
      }
    } else {
      skipped.push(field);
    }
  }
  return {
    total: records.length,
    accepted: accepted.length,
    rejected: rejected.length,
    acceptanceRate: records.length === 0 ? 0 : accepted.length / records.length,
    perDay: countPerDay(records, { ...(spec.days !== undefined ? { days: spec.days } : {}), ...(spec.now ? { now: spec.now } : {}) }),
    byLocale: byLocale(counted),
    byVersion: byVersion(counted),
    bySource: bySource(counted),
    completion: fields.map((field) => completionRate(counted, field)),
    choices,
    numbers,
    skipped
  };
}
