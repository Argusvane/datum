package com.argusvane.datum.pdf;

import java.util.Objects;

/**
 * A PDF the program made, before it leaves the service: what a {@link PdfResultValidator} sees. Read only (a
 * {@link PdfResult}'s bytes are copied on every read).
 *
 * @param op the op that made it: {@code document} (an issued PDF before its seal, or a prepared one), {@code render},
 *     {@code fill} or {@code sign}
 * @param formKey the form the PDF is of, or null
 * @param result the PDF and what the program said about it; for an issued PDF the server will seal, the unsealed render
 *     (the seal adds its signature, a few kilobytes, and changes no page)
 * @param toBeSealed whether the server's key (or a test certificate) seals it once every validator let it go
 */
public record PdfResultCandidate(String op, String formKey, PdfResult result, boolean toBeSealed) {

    public PdfResultCandidate {
        Objects.requireNonNull(op, "op");
        Objects.requireNonNull(result, "result");
    }

    /** The PDF's size in bytes (of the unsealed render, for one the server seals). */
    public int sizeBytes() {
        return result.bytes().length;
    }
}
