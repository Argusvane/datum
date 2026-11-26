// The page side of the extra probes (extras.mjs): what the tester's cases
// do not reach. Mounts a form through the engine renderer with the GCDS binding, a runtime of its
// own (so a probe can add validation stages: a warning, an async check) and keeps handles for
// the probe to read. Built with the binding by extras.mjs.
import { SubmissionModeRegistry } from "../../../engine/form-engine/core/submission/submission-modes.js";
import type { ValidationResult, ValidationStage } from "../../../engine/form-engine/core/schema/contracts.js";
import type { FormDefinition } from "../../../engine/form-engine/core/schema/types.js";
import { componentDrawingOf, withComponentDrawing } from "../../../engine/form-engine/plugins/component-adapters.js";
import { gcdsPlugin } from "../src/plugin.js";
import { createDatumBinding, createDatumFeatures } from "../../../engine/form-engine/render/live/datum/options.js";
import { lit } from "../../../engine/form-engine/render/live/lit.js";
import { mountLive, type LiveContext, type LiveFeature } from "../../../engine/form-engine/render/live/mount.js";
import { FormRuntime } from "../../../engine/form-engine/runtime/browser/form-runtime.js";
import { createFieldConstraintsStage } from "../../../engine/form-engine/validation/core/field-constraints.js";
import { ValidationPipeline } from "../../../engine/form-engine/validation/core/validation-pipeline.js";

export { lit };

/** The Datum binding the GCDS binding is created with (`createBinding(lit, datum)`) and mounted behind. */
export const datum = createDatumBinding();

export interface ProbeOptions {
  definition: FormDefinition;
  binding: ReturnType<typeof createDatumBinding>;
  assets?: unknown;
  locale?: string;
  preset?: Record<string, unknown>;
  mode?: "interactive" | "readonly" | "disabled";
  /** `advice:<severity>:<componentId>` and `remote:<path>` stages. */
  stages?: string[];
  /** The host's receipt, drawn by the form-notices feature. */
  notice?: Record<string, unknown>;
  /** The form's own heading level (the host's `headingLevel`). */
  headingLevel?: number;
  /** Records the date state's missingParts the adapter was handed, in `window.__seen`. */
  spyDate?: boolean;
}

const pendingAnswers: Array<() => void> = [];

function stageOf(spec: string): ValidationStage {
  const [kind, a, b] = spec.split(":");
  if (kind === "advice") {
    return { id: `advice-${b}`, version: "1", validate: () => ({ errors: [{ code: "short", componentId: b as string, path: b as string, severity: a as "warning" | "info", stage: `advice-${b}`, source: "client", message: "That is short." }] }) };
  }
  return {
    id: `remote-${a}`,
    version: "1",
    kind: "async",
    paths: () => [a as string],
    validate: () => new Promise<ValidationResult>((done) => pendingAnswers.push(() => done({ errors: [] })))
  };
}

export const answerPending = (): void => {
  for (const answer of pendingAnswers.splice(0)) answer();
};

let current: { runtime: FormRuntime; form: ReturnType<typeof mountLive>; host: HTMLElement; context?: LiveContext } | undefined;

export async function mountProbe(options: ProbeOptions) {
  if (options.spyDate) {
    const date = options.binding.components.date as unknown as { template: (s: { missingParts: unknown }, on: unknown) => unknown };
    const original = date.template.bind(date);
    date.template = (s, on) => {
      (window as unknown as { __seen: unknown }).__seen = s.missingParts;
      return original(s, on);
    };
  }
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
  const stages = (options.stages ?? []).map(stageOf);
  const runtime = new FormRuntime(options.definition, { submissionModes: modes, validationPipeline: new ValidationPipeline([createFieldConstraintsStage(options.definition.root), ...stages]) });
  if (options.locale) runtime.setLocale(options.locale);
  for (const [path, value] of Object.entries(options.preset ?? {})) runtime.setValue(path, value);
  const host = document.createElement("div");
  document.getElementById("stage")!.append(host);
  const events: unknown[] = [];
  for (const type of ["datum-binding-error", "datum-form-action"]) host.addEventListener(type, (event) => events.push({ type, detail: (event as CustomEvent).detail }));
  const probe: LiveFeature = { id: "probe", start(live) { if (current) current.context = live; } };
  const form = mountLive(host.attachShadow({ mode: "open" }), {
    runtime,
    // The package's plugin lies over the binding, as a host that registers both draws.
    binding: withComponentDrawing(options.binding, componentDrawingOf(gcdsPlugin.components ?? [], { lit, datum })),
    datum,
    ...(options.assets ? { assets: options.assets as never } : {}),
    ...(options.mode ? { mode: options.mode } : {}),
    features: [...createDatumFeatures({}, { formNotices: { notice: () => options.notice as never, headingLevel: () => options.headingLevel ?? 1 } }), probe]
  });
  current = { runtime, form, host };
  (window as unknown as { __probe: unknown }).__probe = { runtime, form, host, events, root: host.shadowRoot };
  await form.ready;
  await form.updated();
  return true;
}
