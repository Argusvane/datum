package com.argusvane.datum.pdf;

import com.argusvane.datum.core.DatumException;

/**
 * A PDF operation that produced no document.
 *
 * <p>{@link #code()} is the wire code. For a refusal of the PDF program it is the kernel's own code
 * ({@code PdfKernelErrorCode} of {@code engine/form-engine/render/pdf/pdf-abi.ts}: {@code invalid_request},
 * {@code font}, {@code template}, {@code layout}, {@code unknown_component}, {@code conformance},
 * {@code attachment_budget}, {@code signature}, {@code formula_invalid}, {@code render_limit}, {@code internal},
 * {@code abi_mismatch}), answered 500 as the endpoint catalog's PDF routes and {@code http-mapping.ts}'s
 * {@code statusOf} answer every kernel failure. The host's own refusals carry their own codes:
 * {@link #LAYOUT_NOT_FOUND} (404), {@link #LAYOUT_NOT_TEMPLATE} (400), {@link #NOT_A_PDF} (400), {@link #UNREADABLE}
 * (400: the program refused a file posted to verify), {@link #NO_PDF} (500 {@code internal}: the program answered
 * without a PDF or handed out nothing to sign).
 *
 * <p>A 4xx message never repeats what the caller sent (the conformance suite's SEC-05 rule, as datum-submissions'
 * fixed-word 404): the layout-not-found words are fixed and never name the layout id.
 *
 * <p>The message is the host's words; the program's own message is kept apart on {@link #kernelMessage()} for the
 * log (messages never carry guest output). A run that gave no answer at all (time or memory budget,
 * a throw, not JSON) is not a {@code PdfException}: it stays datum-core's {@code SandboxException} with its own
 * mapping, and a server that cannot run PDFs is a {@link PdfUnavailableException}.
 */
public class PdfException extends DatumException {

    private static final long serialVersionUID = 1L;

    /** A layout id the definition does not declare (404). */
    public static final String LAYOUT_NOT_FOUND = "layout.notFound";

    /** A layout asked to be filled that is not a template layout. */
    public static final String LAYOUT_NOT_TEMPLATE = "layout.notTemplate";

    /** A file posted to verify that is not a PDF ("The file is not a PDF."). */
    public static final String NOT_A_PDF = "pdf.notAPdf";

    /** A file posted to verify that the program refused to read (encrypted, unparseable, too many signatures). */
    public static final String UNREADABLE = "pdf.unreadable";

    /** The program answered without a PDF, or handed out nothing to sign (500 {@code internal}). */
    public static final String NO_PDF = "internal";

    private final String kernelCode;
    private final String kernelMessage;

    public PdfException(String code, int httpStatus, String message, String kernelCode, String kernelMessage, Throwable cause) {
        super(code, httpStatus, message, cause);
        this.kernelCode = kernelCode;
        this.kernelMessage = kernelMessage;
    }

    /**
     * The program refused the request with its own code.
     *
     * @param kernelCode the kernel's code; also the wire code
     * @param kernelMessage the kernel's message, for the log
     */
    public static PdfException kernel(String kernelCode, String kernelMessage) {
        String code = kernelCode == null || kernelCode.isBlank() ? "internal" : kernelCode;
        return new PdfException(code, 500, "The PDF program refused the request (" + code + ").", code, kernelMessage, null);
    }

    /**
     * The host refuses to deliver a PDF for a signing reason of its own (a layout that requires a seal the server
     * cannot make, a signer that answered with something the kernel would not embed): the wire code is the kernel's
     * {@code signature}, as for the kernel's own signing refusals, so a client reads one code; the words are the host's.
     */
    public static PdfException signature(String message) {
        return new PdfException("signature", 500, message, "signature", null, null);
    }

    /** As {@link #signature(String)}, keeping the cause. */
    public static PdfException signature(String message, Throwable cause) {
        return new PdfException("signature", 500, message, "signature", null, cause);
    }

    /** The program's answer was not what the host needs. */
    public static PdfException noPdf(String message) {
        return new PdfException(NO_PDF, 500, message, null, null, null);
    }

    /**
     * The layout asked for is not the definition's: fixed words that never name the layout id the caller sent.
     */
    public static PdfException layoutNotFound() {
        return new PdfException(LAYOUT_NOT_FOUND, 404, "The form has no such PDF layout.", null, null, null);
    }

    /** A fill asked of a layout that is not a template layout (its kind is not {@code template}). */
    public static PdfException layoutNotTemplate() {
        return new PdfException(LAYOUT_NOT_TEMPLATE, 400, "The layout to fill is not a template layout.", null, null, null);
    }

    /**
     * The program refused a file posted to verify: the file is the caller's, so the answer is a 400 and not the 500
     * of other kernel refusals (the Java sample's verify endpoint answers 400 too). The kernel's code and message
     * stay on {@link #kernelCode()} and {@link #kernelMessage()} for the log.
     */
    public static PdfException unreadable(PdfException refused) {
        return new PdfException(UNREADABLE, 400, "The PDF cannot be read for verification.", refused.kernelCode(), refused.kernelMessage(),
            refused);
    }

    /** A file to verify that is not a PDF. */
    public static PdfException notAPdf() {
        return new PdfException(NOT_A_PDF, 400, "The file is not a PDF.", null, null, null);
    }

    /** The kernel's code when the program refused the request, else null. */
    public String kernelCode() {
        return kernelCode;
    }

    /** The kernel's message when the program refused the request, else null; for the log, never a response. */
    public String kernelMessage() {
        return kernelMessage;
    }
}
