package com.argusvane.datum.pdf;

import java.time.Instant;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * How one PDF is made: the fonts, the render options and, for {@link PdfService#renderSubmission}, what the request
 * says about the document (its form, translations, the option lists the host resolved, its identity and time).
 * Every member is optional; {@link #defaults()} is all of them unset.
 *
 * @param fonts which faces the request carries; null for the service's default ({@code datum.pdf.fonts})
 * @param compact object streams and a compressed cross-reference ({@code options.compact})
 * @param tagged overrides the document's own tagging ({@code options.tagged})
 * @param pdfa a PDF/A claim object, or a JSON {@code false} for an ordinary PDF whatever the layout says
 *     ({@code options.pdfa})
 * @param formKey the form the PDF is of, for {@link PdfRenderedEvent} and the request customizers; may be null
 * @param translations the form's host translation catalog ({@code translations}), or null; the
 *     definition's own map is not an option: {@link PdfService#renderSubmission} sends it as {@code formTranslations}
 * @param optionSnapshot the resolved data-source options per component id ({@code optionSnapshot}), or null
 * @param documentId the document's identity ({@code env.documentId}, hashed into the trailer {@code /ID}): a
 *     submission's id, so a verifier finds the record; null for a random one
 * @param createdAt the creation time ({@code env.createdAt}, the signature's {@code /M}): when the answers were
 *     received; null for now
 * @param hostContext the values the form's {@code host.} names read ({@code hostContext}): the server's own,
 *     the same its answers were judged under (the PDF routes ask the {@code HostContextProvider}), never the browser's;
 *     null for none. A request customizer may still adjust it ({@link PdfRequestDraft#hostContext})
 */
public record PdfOptions(PdfFonts.Pack fonts, Boolean compact, Boolean tagged, JsonNode pdfa, String formKey,
                         JsonNode translations, ObjectNode optionSnapshot, String documentId, Instant createdAt, ObjectNode hostContext) {

    private static final PdfOptions DEFAULTS = new PdfOptions(null, null, null, null, null, null, null, null, null, null);

    /** Nothing set. */
    public static PdfOptions defaults() {
        return DEFAULTS;
    }

    /** The caller's pack, {@link PdfFonts.Pack#DEFAULT} when unset (the service uses {@code datum.pdf.fonts} instead). */
    public PdfFonts.Pack fontPack() {
        return fonts == null ? PdfFonts.Pack.DEFAULT : fonts;
    }

    public PdfOptions withFonts(PdfFonts.Pack pack) {
        return new PdfOptions(pack, compact, tagged, pdfa, formKey, translations, optionSnapshot, documentId, createdAt, hostContext);
    }

    public PdfOptions withRenderOptions(Boolean compact, Boolean tagged, JsonNode pdfa) {
        return new PdfOptions(fonts, compact, tagged, pdfa, formKey, translations, optionSnapshot, documentId, createdAt, hostContext);
    }

    public PdfOptions withFormKey(String key) {
        return new PdfOptions(fonts, compact, tagged, pdfa, key, translations, optionSnapshot, documentId, createdAt, hostContext);
    }

    public PdfOptions withTranslations(JsonNode catalog) {
        return new PdfOptions(fonts, compact, tagged, pdfa, formKey, catalog, optionSnapshot, documentId, createdAt, hostContext);
    }

    public PdfOptions withOptionSnapshot(ObjectNode snapshot) {
        return new PdfOptions(fonts, compact, tagged, pdfa, formKey, translations, snapshot, documentId, createdAt, hostContext);
    }

    public PdfOptions withDocument(String id, Instant created) {
        return new PdfOptions(fonts, compact, tagged, pdfa, formKey, translations, optionSnapshot, id, created, hostContext);
    }

    /** The same options with this host context (null: none). */
    public PdfOptions withHostContext(ObjectNode context) {
        return new PdfOptions(fonts, compact, tagged, pdfa, formKey, translations, optionSnapshot, documentId, createdAt,
            context == null ? null : context.deepCopy());
    }

    /** Whether any render option is set (the request then carries {@code options}). */
    boolean hasRenderOptions() {
        return compact != null || tagged != null || pdfa != null;
    }
}
