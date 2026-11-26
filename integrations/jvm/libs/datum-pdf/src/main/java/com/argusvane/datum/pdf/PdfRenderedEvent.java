package com.argusvane.datum.pdf;

/**
 * A PDF left the service: published for each PDF a caller receives, after any seal.
 *
 * <p>Delivery: synchronously on the caller's thread with Spring's default multicaster, after the PDF is
 * made and before it is answered; nothing is stored, so there is no transaction to wait for. Best effort for a record:
 * a listener that throws is logged and the PDF is delivered all the same, so a listener cannot veto or gate the release
 * (a {@link PdfResultValidator} can). The bytes are the delivered PDF, a copy per call.
 *
 * @param formKey the form the PDF is of, or null when the caller named none
 * @param op the kernel op that made it ({@code document}, {@code render}, {@code fill}, {@code complete})
 * @param bytes the PDF as delivered
 * @param layoutId the layout that printed, or "" when the op names none
 * @param signed whether it carries the server's seal (or, for {@code complete}, a completed signature)
 * @param timestamped whether that signature carries an RFC 3161 token
 */
public record PdfRenderedEvent(String formKey, String op, byte[] bytes, String layoutId, boolean signed, boolean timestamped) {

    public PdfRenderedEvent {
        bytes = bytes.clone();
    }

    @Override
    public byte[] bytes() {
        return bytes.clone();
    }
}
