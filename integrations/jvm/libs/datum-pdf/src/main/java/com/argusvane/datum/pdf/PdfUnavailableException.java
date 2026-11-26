package com.argusvane.datum.pdf;

import com.argusvane.datum.core.ProgramUnavailableException;

/**
 * PDFs cannot be made on this server now: the runtime is down, the PDF program is missing or did not prove its ABI,
 * or the engine cannot run it here ({@code DatumSandbox.canRunPdf} is false, as on Endive's JVM bytecode fallback: the
 * PDF program needs a native runner). 503 {@code server.unavailable}, as datum-core's
 * {@link ProgramUnavailableException} it extends (endpoint catalog: the PDF routes' 503).
 */
public class PdfUnavailableException extends ProgramUnavailableException {

    private static final long serialVersionUID = 1L;

    public PdfUnavailableException(String message) {
        super(message);
    }

    public PdfUnavailableException(String message, Throwable cause) {
        super(message, cause);
    }
}
