package com.argusvane.datum.pdf;

import com.argusvane.datum.core.contracts.PdfSigningHandoff;
import java.util.List;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * A PDF and what the program said about it.
 *
 * @param bytes the PDF (the prepared file when {@code signing} is set)
 * @param pageCount its pages, as the program counted them
 * @param layoutId the layout that printed ({@code document} ABI 3.11), or "" when the op names none
 * @param layoutKind {@code generated}, {@code template} or {@code derived}, or null
 * @param layoutChoice how the layout was chosen (ABI 3.11), or null
 * @param warnings the program's warnings and the host's ({@code sealing.unavailable}, {@code sealing.timestamp}),
 *     each {@code {code, message, ...}}
 * @param elapsedMs the wall time of the runs, slot waits excluded
 * @param signing what the host must sign when the request carried a signature and it is not completed yet, or null
 * @param seal how the PDF was sealed (the server's key, or a throwaway test certificate), or null
 * @param answer the program's whole reply except its {@code bytes} (fields, areas, pdfa, attachments, ...)
 */
public record PdfResult(byte[] bytes, int pageCount, String layoutId, String layoutKind, JsonNode layoutChoice,
                        List<ObjectNode> warnings, double elapsedMs, PdfSigningHandoff signing, PdfSeal seal, ObjectNode answer) {

    public PdfResult {
        bytes = bytes.clone();
        warnings = List.copyOf(warnings);
    }

    @Override
    public byte[] bytes() {
        return bytes.clone();
    }

    /** Whether the server's key sealed it (a throwaway {@link TestSeal} certificate is not the server's). */
    public boolean signed() {
        return seal != null && !seal.test();
    }

    /** Whether an RFC 3161 token is in the seal. */
    public boolean timestamped() {
        return seal != null && seal.timestamped();
    }

    PdfResult withSeal(byte[] sealed, List<ObjectNode> allWarnings, double elapsed, PdfSeal sealedWith) {
        return new PdfResult(sealed, pageCount, layoutId, layoutKind, layoutChoice, allWarnings, elapsed, null, sealedWith, answer);
    }

    PdfResult withWarnings(List<ObjectNode> allWarnings) {
        return new PdfResult(bytes, pageCount, layoutId, layoutKind, layoutChoice, allWarnings, elapsedMs, signing, seal, answer);
    }
}
