package com.argusvane.datum.pdf;

/**
 * Adjusts a PDF request before it runs (SPI; the {@code *Customizer} of the lifecycle
 * hook model): the document's identity and time ({@code env}), the render options, the
 * {@code hostContext} the layout's text may read, the {@code attachments} budget or files, and the fonts. The beans
 * run in the framework's order (declare {@code @Order} where the relative order matters; equal orders keep registration order), each over what the one before left.
 *
 * <p>Never the ABI, the op, the program, the form or the answers: the customizer sees a {@link PdfRequestDraft} that
 * holds only the five members, and only those the op carries ({@code document} all five; {@code build}
 * hostContext and attachments; {@code render} env, options, fonts; {@code layout} env and fonts; {@code fill} env,
 * options, attachments, fonts; {@code sign} env and fonts). The ops that make no document ({@code capabilities},
 * {@code inspect}, {@code complete}, {@code timestampRequest}, {@code verify}) are never customized. A customizer
 * that throws fails the request: it is the application's code, and a PDF made without its adjustment could carry
 * the wrong identity.
 *
 * <p>In the hook model this is the PDF's {@code *Customizer}: it refuses by throwing
 * {@link com.argusvane.datum.core.hooks.HookRefusedException} (403, 409 or 422 with the errors body, before any
 * run), and anything else it throws is a 500. Its after-the-run counterpart is {@link PdfResultValidator}.
 */
@FunctionalInterface
public interface PdfRequestCustomizer {

    /** Adjusts the draft in place. */
    void customize(PdfRequestDraft draft);
}
