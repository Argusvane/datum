import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentActionDetail } from "../form-engine/agent/registrar.js";
import { PdfKernelError } from "../form-engine/render/pdf/pdf-abi.js";
import type { DownloadPdfResult } from "../form-engine/render/web-component/pdf-download.js";
import { TRAVEL_CLAIM_FORM, TRAVEL_CLAIM_LAYOUTS, agentSetup as baseSetup, pdfDownloadResult, personTypes, type AgentSetup, type AgentSetupOptions } from "./fixtures/agent-form.js";

/**
 * `download_pdf` and `describe_form.pdf`:
 * the signer refusal before anything renders, the layout and locale checks, the dry run that
 * paints nothing, the repeat guard and `again`, the seam that admits `layoutId` and `locale`
 * alone, `delivered` from `cancelled`, the chunk and kernel failures worded without kernel text,
 * the registrar's stale gate, and no bytes, fill report or PDF warning message in any result.
 */

type Row = Record<string, unknown>;

const FILLED = { traveller: "Ana Lopez", amount: 120 };

/** Every registrar call of the test, so afterEach can search every download_pdf result. */
const calls: Array<Promise<unknown>> = [];

/** `agentSetup`, with every result its registrar answers kept for the deep search below. */
function agentSetup(definition: Parameters<typeof baseSetup>[0], options: AgentSetupOptions = {}): AgentSetup {
  const setup = baseSetup(definition, options);
  const execute = setup.registrar.execute.bind(setup.registrar);
  setup.registrar.execute = (name, input, callOptions) => {
    const result = execute(name, input, callOptions);
    calls.push(result.catch(() => undefined));
    return result;
  };
  return setup;
}

afterEach(async () => {
  vi.useRealTimers();
  // Every download_pdf result of the test: never the bytes, a fill
  // report, a signature, the document model or a PdfWarning's words.
  const results = await Promise.all(calls.splice(0));
  expect(results.length, "every test calls a tool through the tracked registrar").toBeGreaterThan(0);
  for (const result of results) {
    if ((result as Row | undefined)?.tool === "download_pdf") {
      expectNoPdfInternals(result, ["kernel says", "secret", "private-path", "datum-form-pdf-service"]);
    }
  }
});

function pdfSetup(download: (options: { layoutId?: string; locale?: string }) => Promise<DownloadPdfResult> = () => Promise.resolve(pdfDownloadResult()), extra: AgentSetupOptions = {}, signed = false): { setup: AgentSetup; download: ReturnType<typeof vi.fn> } {
  const spy = vi.fn(download);
  const setup = agentSetup(TRAVEL_CLAIM_FORM, { ...extra, host: { pdf: { layouts: TRAVEL_CLAIM_LAYOUTS, signed, download: spy }, ...(extra.host ?? {}) } });
  return { setup, download: spy };
}

/** Every string and key in a value, depth first. */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) {
      strings(item, out);
    }
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Row)) {
      out.push(key);
      strings(item, out);
    }
  }
  return out;
}

/** Never the bytes, a fill report, a signature, the document model or a PdfWarning message. */
function expectNoPdfInternals(result: unknown, words: readonly string[] = []): void {
  const all = strings(result);
  for (const key of ["bytes", "fields", "areas", "signature", "attachments", "document", "message"].filter((key) => key !== "message" || (result as Row).ok === true)) {
    expect(all, `${key} in ${JSON.stringify(result).slice(0, 200)}`).not.toContain(key);
  }
  for (const word of words) {
    for (const text of all) {
      expect(text).not.toContain(word);
    }
  }
}

describe("download_pdf refusals before anything renders", () => {
  it("signature-required { pdf-signer } when the page signs its PDFs: no render, no dry run, permanent", async () => {
    const { setup, download } = pdfSetup(undefined, {}, true);
    personTypes(setup.runtime, FILLED);
    const check = vi.spyOn(setup.runtime, "checkValues");
    const result = await setup.refused("download_pdf");
    expect(result).toMatchObject({
      code: "signature-required",
      retryable: false,
      message: "This page signs every PDF it makes, so an assistant cannot make one.",
      hint: "This page signs its PDFs, which is the person's act; tell them to use the form's PDF button themselves.",
      details: { because: "pdf-signer" }
    });
    expect(download).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
  });

  it("feature-off without the pdf feature, no-pdf without PDF support", async () => {
    const off = pdfSetup(undefined, { host: { allows: { pdf: false } } });
    expect(await off.setup.refused("download_pdf")).toMatchObject({ code: "feature-off", details: { feature: "pdf" } });
    expect(off.download).not.toHaveBeenCalled();
    expect(await agentSetup(TRAVEL_CLAIM_FORM).refused("download_pdf")).toMatchObject({
      code: "no-pdf",
      hint: "This page does not make PDFs of the form; tell the person.",
      details: {}
    });
  });

  it("unknown-layout lists the form's layouts and never lets the chooser derive one; locale-unsupported for a language the form lacks", async () => {
    const { setup, download } = pdfSetup();
    personTypes(setup.runtime, FILLED);
    const layout = await setup.refused("download_pdf", { layoutId: "invoice" });
    expect(layout).toMatchObject({
      code: "unknown-layout",
      hint: "Use one of the listed layout ids, or leave layoutId out to let the form choose.",
      details: { layoutId: "invoice", layouts: [{ id: "claim-summary", label: "Claim summary" }, { id: "receipt", label: "Receipt" }] }
    });
    const locale = await setup.refused("download_pdf", { locale: "de" });
    expect(locale).toMatchObject({ code: "locale-unsupported", details: { locale: "de", supported: [{ code: "en" }, { code: "fr" }] } });
    expect(download).not.toHaveBeenCalled();
  });

  it("pdf-blocked words the problems as check does and paints nothing on the form", async () => {
    const { setup, download } = pdfSetup();
    personTypes(setup.runtime, { traveller: "Ana Lopez" });
    const validate = vi.spyOn(setup.runtime, "validate");
    const result = await setup.refused("download_pdf");
    expect(result).toMatchObject({
      code: "pdf-blocked",
      retryable: false,
      message: "The answers have 1 problem, so no PDF was made.",
      hint: "Fix the listed problems with set_answers, then call download_pdf again."
    });
    const errors = (result.details as Row).errors as Row[];
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ path: "amount", id: "amount", label: "Amount", code: "required", severity: "error" });
    expect(validate).not.toHaveBeenCalled();
    expect(setup.runtime.errors()).toEqual([]);
    expect(download).not.toHaveBeenCalled();
  });

  it("an expectedRevision behind the form is stale before the body: nothing renders", async () => {
    const { setup, download } = pdfSetup();
    personTypes(setup.runtime, FILLED);
    const described = await setup.ok("describe_form");
    personTypes(setup.runtime, { trip_start: "2026-10-02" });
    expect((await setup.refused("download_pdf", { expectedRevision: described.revision as number })).code).toBe("stale");
    expect(download).not.toHaveBeenCalled();
  });
});

describe("download_pdf delivered", () => {
  it("hands the seam layoutId and locale and nothing else, and reports the layout, pages and file without the bytes", async () => {
    const { setup, download } = pdfSetup(() => Promise.resolve(pdfDownloadResult({ layoutId: "receipt", layoutChoice: "asked", fileName: "travel-claim-receipt-fr.pdf", pageCount: 1 })));
    personTypes(setup.runtime, FILLED);
    const result = await setup.ok("download_pdf", { layoutId: "receipt", locale: "fr" });
    expect(download).toHaveBeenCalledTimes(1);
    const options = download.mock.calls[0]?.[0] as Row;
    expect(Object.keys(options).sort()).toEqual(["layoutId", "locale"]);
    expect(options).toEqual({ layoutId: "receipt", locale: "fr" });
    expect(result).toMatchObject({
      ok: true,
      tool: "download_pdf",
      changed: true,
      undoable: false,
      delivered: "download",
      fileName: "travel-claim-receipt-fr.pdf",
      layoutId: "receipt",
      layoutLabel: "Receipt",
      layoutChoice: "asked",
      pageCount: 1,
      locale: "fr"
    });
    expect(result.next).toEqual(["Tell the person the PDF 'travel-claim-receipt-fr.pdf' is downloading."]);
    expectNoPdfInternals(result);
    expect(setup.host.calls.filter((call) => call.method === "announce").map((call) => call.args[0])).toContain("An assistant downloaded a PDF of the form");
    const action = setup.host.calls
      .filter((call) => call.method === "emit" && call.args[0] === "datum-agent-action")
      .map((call) => call.args[1] as AgentActionDetail)
      .find((detail) => detail.tool === "download_pdf");
    expect(action).toMatchObject({ consequential: true });
  });

  it("with neither argument the seam gets an empty request and the form's own choice is reported", async () => {
    const { setup, download } = pdfSetup();
    personTypes(setup.runtime, FILLED);
    const result = await setup.ok("download_pdf");
    expect(download.mock.calls[0]?.[0]).toEqual({});
    expect(result).toMatchObject({ layoutId: "claim-summary", layoutLabel: "Claim summary", layoutChoice: "default", locale: "en" });
  });

  it("delivered: page when a datum-pdf listener cancelled; pdf-failed { delivery } when nothing reached anybody", async () => {
    const page = pdfSetup(() => Promise.resolve(pdfDownloadResult({ downloaded: false, cancelled: true })));
    personTypes(page.setup.runtime, FILLED);
    const taken = await page.setup.ok("download_pdf");
    expect(taken).toMatchObject({ delivered: "page", next: ["Tell the person the page has the PDF; it went where this site sends PDFs."] });

    const nowhere = pdfSetup(() => Promise.resolve(pdfDownloadResult({ downloaded: false, cancelled: false })));
    personTypes(nowhere.setup.runtime, FILLED);
    const failed = await nowhere.setup.refused("download_pdf");
    expect(failed).toMatchObject({ code: "pdf-failed", hint: "The PDF could not be made; tell the person.", details: { what: "delivery" } });
    // Nothing was delivered, so a second try is not "already downloaded".
    expect((await nowhere.setup.refused("download_pdf")).code).toBe("pdf-failed");
  });

  it("already-downloaded on the same revision, layout and language; again: true, another layout or a write allow it", async () => {
    const { setup, download } = pdfSetup();
    personTypes(setup.runtime, FILLED);
    await setup.ok("download_pdf");
    const repeat = await setup.refused("download_pdf");
    expect(repeat).toMatchObject({
      code: "already-downloaded",
      retryable: false,
      hint: "The person already has this PDF; call again with again: true only if they asked for another copy.",
      details: { layoutId: "claim-summary" }
    });
    expect(typeof (repeat.details as Row).at).toBe("number");
    // The same layout at the same revision in another language is another PDF (the key's locale part).
    expect((await setup.ok("download_pdf", { locale: "fr" })).locale).toBe("fr");
    expect((await setup.ok("download_pdf", { again: true })).delivered).toBe("download");
    expect((await setup.ok("download_pdf", { layoutId: "receipt" })).ok).toBe(true);
    await setup.ok("set_answers", { answers: { trip_start: "2026-10-02" } });
    expect((await setup.ok("download_pdf")).ok).toBe(true);
    expect(download).toHaveBeenCalledTimes(5);
  });

  it("PDF warnings come back as codes and component ids only, at most 20, never the kernel's words", async () => {
    const warnings = Array.from({ length: 23 }, (_, index) => ({ code: `text-clipped-${index}`, message: `The kernel says clipped secret ${index}`, componentId: index % 2 === 0 ? "traveller" : undefined, blockId: "b1" }));
    const { setup } = pdfSetup(() => Promise.resolve(pdfDownloadResult({ warnings: warnings as DownloadPdfResult["warnings"] })));
    personTypes(setup.runtime, FILLED);
    const result = await setup.ok("download_pdf");
    const listed = result.pdfWarnings as Row[];
    expect(listed).toHaveLength(20);
    expect(listed[0]).toEqual({ code: "text-clipped-0", componentId: "traveller" });
    expect(listed[1]).toEqual({ code: "text-clipped-1" });
    expect(result.morePdfWarnings).toBe(3);
    expect(result).not.toHaveProperty("warnings");
    expectNoPdfInternals(result, ["kernel says", "secret", "blockId"]);
  });

  it("a derived layout reports layoutId \"\" and choice derived", async () => {
    const { setup } = pdfSetup(() => Promise.resolve(pdfDownloadResult({ layoutId: "derived-form", layoutChoice: "derived" })));
    personTypes(setup.runtime, FILLED);
    expect(await setup.ok("download_pdf")).toMatchObject({ layoutId: "", layoutChoice: "derived" });
  });
});

describe("download_pdf failures", () => {
  it("chunk-unavailable { pdf } (retryable) for a PDF service that did not load", async () => {
    const { setup } = pdfSetup(() => Promise.reject(Object.assign(new Error("The PDF service (datum-form-pdf-service-abc.js) could not be loaded: 404"), { name: "ChunkLoadError" })));
    personTypes(setup.runtime, FILLED);
    const result = await setup.refused("download_pdf");
    expect(result).toMatchObject({ code: "chunk-unavailable", retryable: true, details: { what: "pdf", state: "failed" } });
    expectNoPdfInternals(result, ["datum-form-pdf-service"]);
  });

  it("kernel failures give their code, template failures say template, and no kernel text is returned", async () => {
    const kernel = pdfSetup(() => Promise.reject(new PdfKernelError("font", "Font Noto failed at /fonts/private-path.ttf")));
    personTypes(kernel.setup.runtime, FILLED);
    const font = await kernel.setup.refused("download_pdf");
    expect(font).toMatchObject({ code: "pdf-failed", details: { what: "rendering", code: "font" } });
    expectNoPdfInternals(font, ["Noto", "private-path"]);

    const template = pdfSetup(() => Promise.reject(new PdfKernelError("template", "Template field Line 7 is broken")));
    personTypes(template.setup.runtime, FILLED);
    const broken = await template.setup.refused("download_pdf");
    expect(broken).toMatchObject({ code: "pdf-failed", details: { what: "template" } });
    expectNoPdfInternals(broken, ["Line 7"]);

    const other = pdfSetup(() => Promise.reject(new Error("Unexpected: kernel crashed with secret")));
    personTypes(other.setup.runtime, FILLED);
    const crashed = await other.setup.refused("download_pdf");
    expect(crashed).toMatchObject({ code: "pdf-failed", details: { what: "rendering" } });
    expectNoPdfInternals(crashed, ["secret"]);

    const support = pdfSetup(() => Promise.reject(new Error('No PDF support: set the "pdf" attribute (e.g. pdf="auto") or assign pdfSupport')));
    personTypes(support.setup.runtime, FILLED);
    expect((await support.setup.refused("download_pdf")).code).toBe("no-pdf");
  });

  it("busy { pdf } while the agent's own timed-out download still runs; the 60 s budget answers timeout with stillRunning", async () => {
    vi.useFakeTimers();
    let finish: ((value: DownloadPdfResult) => void) | undefined;
    // The first download hangs until `finish`; later ones answer at once.
    const { setup } = pdfSetup(() =>
      finish === undefined
        ? new Promise<DownloadPdfResult>((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(pdfDownloadResult())
    );
    personTypes(setup.runtime, FILLED);
    const first = setup.execute("download_pdf");
    // The memo build and the dry run come first, then the 60 s budget starts.
    await vi.advanceTimersByTimeAsync(61_000);
    expect(await first).toMatchObject({ ok: false, code: "timeout", retryable: true, details: { afterMs: 60_000, stillRunning: true } });
    expect(await setup.refused("download_pdf", { again: true })).toMatchObject({ code: "busy", details: { because: "pdf" } });
    finish?.(pdfDownloadResult());
    await vi.advanceTimersByTimeAsync(0);
    expect((await setup.ok("download_pdf", { again: true })).ok).toBe(true);
  });
});

describe("describe_form.drafts and describe_form.pdf", () => {
  it("lists the layouts, whether a download would work and whether the page signs, with the guidance lines; no wouldPrint", async () => {
    const { setup } = pdfSetup();
    const result = await setup.ok("describe_form");
    expect(result.pdf).toEqual({
      canDownload: true,
      signed: false,
      layouts: [
        { id: "claim-summary", label: "Claim summary", kind: "generated", isDefault: true, conditional: false },
        { id: "receipt", label: "Receipt", kind: "generated", isDefault: false, conditional: false }
      ]
    });
    const guidance = result.guidance as string[];
    expect(guidance).toContain("download_pdf gives the person the PDF when they ask for it; the form's checks run first.");
    expect(guidance).not.toContain("PDFs from this page are signed; the person makes them with the form's PDF button.");
    expect(guidance.at(-1)).toMatch(/^For more than a couple of writes, call begin_session first/u);
    expect(JSON.stringify(result)).not.toContain("wouldPrint");
    expect(result.agentAccess).toBe("on");

    const signed = pdfSetup(undefined, {}, true);
    const signedResult = await signed.setup.ok("describe_form");
    expect(signedResult.pdf).toMatchObject({ canDownload: false, signed: true });
    expect(signedResult.guidance as string[]).toContain("PDFs from this page are signed; the person makes them with the form's PDF button.");
    expect(signedResult.guidance as string[]).not.toContain("download_pdf gives the person the PDF when they ask for it; the form's checks run first.");
  });

  it("drafts says where the draft is kept and that it autosaves, with the site guidance line; both blocks absent when not applicable", async () => {
    const kept = await agentSetup(TRAVEL_CLAIM_FORM, { drafts: {} }).ok("describe_form");
    expect(kept.drafts).toEqual({ store: "page", autosave: true });
    expect(kept.guidance as string[]).toContain("This form keeps a draft on the site and saves it as answers change, yours included; use drafts only when the person asks.");
    const plain = await agentSetup(TRAVEL_CLAIM_FORM).ok("describe_form");
    expect(plain).not.toHaveProperty("drafts");
    expect(plain).not.toHaveProperty("pdf");
    expect((plain.guidance as string[]).some((line) => line.includes("draft") || line.includes("PDF"))).toBe(false);
    const off = await agentSetup(TRAVEL_CLAIM_FORM, { drafts: {}, host: { allows: { drafts: false, pdf: false }, pdf: { layouts: TRAVEL_CLAIM_LAYOUTS } } }).ok("describe_form");
    expect(off).not.toHaveProperty("drafts");
    expect(off).not.toHaveProperty("pdf");
  });
});
