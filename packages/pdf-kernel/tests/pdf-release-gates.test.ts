import { describe, expect, it } from "vitest";

import { collectReleaseGateInputs, evaluateReleaseGates, type PdfRenderProvider } from "@argusvane/datum-engine";

import { createFontProvider, createInProcessPdfProvider } from "../src/index.js";
import { createQuickJsPdfProvider } from "../src/quickjs-provider.js";
import { fonts } from "./helpers.js";

describe("release gates with the PDF providers", () => {
  it("passes pdf-render-determinism with the in-process provider", async () => {
    const inputs = await collectReleaseGateInputs({
      pdfProvider: createInProcessPdfProvider(),
      pdfFonts: createFontProvider(await fonts()),
      perfIterations: 2
    });
    expect(inputs.pdfRenderDeterminism).toEqual({ applicable: true, passed: true, providerId: "datum-pdf-kernel" });
    const report = evaluateReleaseGates(inputs);
    const gate = report.checks.find((check) => check.name === "pdf-render-determinism");
    expect(gate).toEqual({ name: "pdf-render-determinism", passed: true });
  });

  it("passes pdf-render-determinism with the QuickJS provider, the same program in the sandbox", async () => {
    const provider = await createQuickJsPdfProvider();
    try {
      const inputs = await collectReleaseGateInputs({ pdfProvider: provider, pdfFonts: createFontProvider(await fonts()), perfIterations: 2 });
      expect(inputs.pdfRenderDeterminism?.passed).toBe(true);
      expect(inputs.pdfRenderDeterminism?.applicable).toBe(true);
      expect(evaluateReleaseGates(inputs).checks.find((check) => check.name === "pdf-render-determinism")?.passed).toBe(true);
    } finally {
      provider.dispose?.();
    }
  }, 120_000);

  it("fails the gate for a provider whose bytes drift between calls, and passes as not applicable without one", async () => {
    let calls = 0;
    const drifting: PdfRenderProvider = {
      id: "drifting",
      abiVersion: "1.0.0",
      render: async () => {
        calls += 1;
        return { bytes: new TextEncoder().encode(`%PDF-${calls}`), pageCount: 1, pages: [], warnings: [], providerId: "drifting" };
      }
    };
    const failing = await collectReleaseGateInputs({ pdfProvider: drifting, perfIterations: 2 });
    expect(failing.pdfRenderDeterminism).toEqual({ applicable: true, passed: false, providerId: "drifting" });
    const report = evaluateReleaseGates(failing);
    expect(report.passed).toBe(false);
    expect(report.checks.find((check) => check.name === "pdf-render-determinism")?.reason).toContain("drifting");

    const absent = await collectReleaseGateInputs({ perfIterations: 2 });
    expect(absent.pdfRenderDeterminism).toEqual({ applicable: false, passed: true });
    expect(evaluateReleaseGates(absent).checks.find((check) => check.name === "pdf-render-determinism")?.passed).toBe(true);
  });
});
