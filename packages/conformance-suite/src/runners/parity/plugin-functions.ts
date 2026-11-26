import {
  formulaFunctionParity,
  WasmValidationHost,
  type FormulaFunctionParityReport,
  type FormulaFunctionVector,
  type WasmPlugin
} from "@argusvane/datum-engine";
import { QuickJsWasmHostAdapter, toSourcePlugin } from "@argusvane/datum-quickjs-wasm-host";

export interface PluginFunctionParityOptions {
  /** The program file whose sandbox runs the function. */
  programText: string;
  /** The plugin that contributes the function (function-backed; its source is derived for the sandbox). */
  plugin: WasmPlugin & { functions: Record<string, (args: unknown[]) => unknown> };
  /** The contribution's name and in-process `evaluate`. */
  contribution: { name: string; evaluate(args: unknown[]): unknown };
  vectors: FormulaFunctionVector[];
}

function literal(value: unknown): string {
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  throw new Error("pluginFunctionParity vectors take number, string and boolean arguments (they become formula literals)");
}

/**
 * The engine's `formulaFunctionParity` for a plugin function, with the sandbox side supplied by the
 * program file under test: each call becomes a `value` rule over literals, run through the
 * program, and the field's value is the function's answer. Arguments are scalars.
 */
export async function pluginFunctionParity(options: PluginFunctionParityOptions): Promise<FormulaFunctionParityReport> {
  const host = await WasmValidationHost.create([toSourcePlugin(options.plugin)], { adapter: new QuickJsWasmHostAdapter({ program: options.programText }) });
  try {
    return await formulaFunctionParity(options.contribution as never, options.vectors, async (name, args) => {
      const formula = `${name}(${args.map(literal).join(", ")})`;
      const root = { id: "form", type: "form", configuration: { formulaErrors: "fail" }, children: { content: [{ id: "r", type: "hidden", configuration: {}, rules: { value: formula } }] } };
      const outcome = await host.run({ context: { formId: "plugin-function-parity", values: {}, locale: "en", form: root } as never, policy: WasmValidationHost.STRICT_POLICY });
      return (outcome as unknown as { values?: { r?: unknown } }).values?.r;
    });
  } finally {
    host.dispose();
  }
}
