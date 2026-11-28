import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

import { createQuickJsPdfProvider } from "@argusvane/datum-pdf-kernel/quickjs";

import { statusFor } from "../../judge.js";
import type { PdfReport, ResultStatus, VectorResult } from "../../report/model.js";
import { matchesSelector } from "../../vectors/index.js";
import type { Gate, Vector } from "../../vectors/schema.js";
import { compareAbi } from "../program/detect-abi.js";
import {
  checkAttachmentNames,
  checkBidi,
  checkFilespec,
  checkMetadata,
  checkMissingGlyph,
  checkNoActiveContent,
  checkOverflow,
  checkRefusedTypes,
  checkRenderCaps,
  checkPdfA,
  checkSealedSignature,
  checkSizeHonesty,
  checkSizeMismatch,
  checkTemplateFill,
  checkTextIntegrity,
  type CheckContext,
  type Outcome,
  type PdfProvider
} from "./checks.js";
import { findVeraPdf } from "./inspect.js";
import { loadFonts, loadPdfLib, loadPdfjs } from "./libs.js";

/** The PDF ABI the OUT class needs: a program of this major, at this version or later. */
export const OUTPUT_SAFETY_ABI = "1.0.0";

const CHECKS: Record<string, (ctx: CheckContext) => Promise<Outcome>> = {
  "OUT-01": checkTextIntegrity,
  "OUT-02": checkNoActiveContent,
  "OUT-03": checkFilespec,
  "OUT-04": checkAttachmentNames,
  "OUT-05": checkSizeHonesty,
  "OUT-06": checkBidi,
  "OUT-07": checkOverflow,
  "OUT-08": checkMissingGlyph,
  "OUT-09": checkTemplateFill,
  "OUT-10": checkMetadata,
  "OUT-11": checkPdfA,
  "OUT-12": checkSealedSignature,
  "OUT-13": checkRenderCaps,
  "OUT-14": checkSizeMismatch,
  "OUT-15": checkRefusedTypes
};

export interface PdfProgramInput {
  /** The program's text (a datum-pdf.program.js). */
  text: string;
  /** Where it came from, for the report. */
  path: string;
}

export interface PdfRunOptions {
  /** The program to run. Ignored for execution when `provider` is given (tests), but still described in the report. */
  program: PdfProgramInput;
  /** Replaces the QuickJS provider (tests run the in-process kernel as a positive control). */
  provider?: PdfProvider;
  /** False runs the checks against a program of another PDF ABI instead of reporting the class pending (the mutation tests). Default true. */
  enforceAbi?: boolean;
  catalogue: readonly Vector[];
  gate?: "release" | "full";
  only?: readonly string[];
  skip?: readonly string[];
  onResult?: (result: VectorResult) => void;
}

export interface PdfRunOutput {
  results: VectorResult[];
  report: PdfReport;
}

function openssl(): boolean {
  return spawnSync("openssl", ["version"], { stdio: "ignore" }).status === 0;
}

async function tool(load: () => Promise<unknown>): Promise<boolean> {
  try {
    await load();
    return true;
  } catch {
    return false;
  }
}

/** Why a program cannot answer the OUT class, or null when it can. */
export function pendingReason(abi: string | null): string | null {
  if (abi === null || !/^\d+\.\d+\.\d+$/.test(abi)) {
    return "the program did not answer a PDF ABI";
  }
  if (abi.split(".")[0] !== OUTPUT_SAFETY_ABI.split(".")[0] || compareAbi(abi, OUTPUT_SAFETY_ABI) < 0) {
    return `the program answers PDF ABI ${abi}; the OUT class needs ${OUTPUT_SAFETY_ABI} or a later version of its major (rebuild it from the current kernel)`;
  }
  return null;
}

/** Runs the OUT vectors against a PDF program. Never throws for a program that misbehaves: that is the finding. */
export async function runPdfVectors(options: PdfRunOptions): Promise<PdfRunOutput> {
  const gate = options.gate ?? "release";
  const selected = options.catalogue.filter(
    (vector) => vector.class === "output" && (options.only === undefined || options.only.length === 0 || options.only.some((s) => matchesSelector(vector, s))) && !(options.skip ?? []).some((s) => matchesSelector(vector, s))
  );
  const fonts = await loadFonts();
  const tools = {
    fonts: fonts.length > 0 ? "DejaVu Sans (embedded)" : "standard-14 only",
    pdfjs: await tool(loadPdfjs),
    pdfLib: await tool(loadPdfLib),
    verapdf: findVeraPdf() !== undefined,
    openssl: openssl()
  };
  const report: PdfReport = {
    path: options.program.path,
    bytes: Buffer.byteLength(options.program.text),
    sha256: createHash("sha256").update(options.program.text).digest("hex"),
    abi: null,
    pending: null,
    tools
  };
  const results: VectorResult[] = [];
  const emit = (result: VectorResult): void => {
    results.push(result);
    options.onResult?.(result);
  };
  const base = (vector: Vector) => ({
    id: vector.id,
    title: vector.title,
    class: vector.class,
    severity: vector.severity,
    attacker: vector.attacker,
    runner: "pdf" as const,
    expected: vector.predicate ?? vector.title,
    observed: null,
    limitMs: vector.limits.programMs ?? null
  });

  let provider: PdfProvider | undefined = options.provider;
  let startupError: string | null = null;
  let ownsProvider = false;
  try {
    if (provider === undefined) {
      const created = await createQuickJsPdfProvider({ program: options.program.text });
      provider = created;
      ownsProvider = true;
    }
    const capabilities = await provider.capabilities();
    report.abi = capabilities.abi;
    if (options.enforceAbi !== false) {
      report.pending = pendingReason(capabilities.abi);
    }
  } catch (error) {
    startupError = error instanceof Error ? error.message : String(error);
  }

  if (provider === undefined || startupError !== null) {
    for (const vector of selected) {
      emit({
        ...base(vector),
        status: "ERROR",
        gate: vector.gate.status,
        blockedBy: null,
        durationMs: 0,
        notes: `the PDF program did not start or answer capabilities: ${startupError ?? "no provider"}`
      });
    }
    return { results, report };
  }

  const capabilities = { abi: report.abi ?? "", kernelVersion: "" };
  const context: CheckContext = { provider, fonts, capabilities };
  try {
    for (const vector of selected) {
      if (report.pending !== null && gate === "release") {
        emit({
          ...base(vector),
          status: "SKIP",
          gate: "pending",
          blockedBy: `PDF ABI ${OUTPUT_SAFETY_ABI}`,
          durationMs: 0,
          notes: `pending: ${report.pending}; run with --gate full to see what the program does anyway`
        });
        continue;
      }
      const effective: Gate = report.pending !== null ? { status: "pending", blockedBy: `PDF ABI ${OUTPUT_SAFETY_ABI}` } : vector.gate;
      const check = CHECKS[vector.id];
      const started = performance.now();
      let outcome: Outcome;
      if (check === undefined) {
        outcome = { verdict: "skip", detail: `no check is implemented for ${vector.id}` };
      } else {
        try {
          outcome = await check(context);
        } catch (error) {
          const missing = error instanceof Error && error.name === "MissingLibrary";
          outcome = missing
            ? { verdict: "skip", detail: (error as Error).message }
            : { verdict: "fail", detail: `the program refused or crashed on a request the check expected it to answer: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}` };
        }
      }
      const durationMs = Math.round(performance.now() - started);
      const limit = vector.limits.programMs ?? null;
      if (outcome.verdict === "pass" && limit !== null && durationMs > limit) {
        outcome = { verdict: "fail", detail: `took ${durationMs} ms, over the ${limit} ms bound (${outcome.detail})` };
      }
      let status: ResultStatus;
      if (outcome.verdict === "skip") {
        status = "SKIP";
      } else {
        status = statusFor({ pass: outcome.verdict === "pass", warn: false }, effective);
      }
      emit({
        ...base(vector),
        status,
        gate: effective.status,
        blockedBy: effective.status === "pending" ? effective.blockedBy : null,
        durationMs,
        notes: outcome.detail
      });
    }
  } finally {
    if (ownsProvider && "dispose" in provider) {
      (provider as { dispose(): void }).dispose();
    }
  }
  return { results, report };
}
