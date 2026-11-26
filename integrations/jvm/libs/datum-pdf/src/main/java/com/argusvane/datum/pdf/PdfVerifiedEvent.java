package com.argusvane.datum.pdf;

import com.argusvane.datum.pdf.verify.PdfTrustPolicy;
import com.argusvane.datum.pdf.verify.SignatureVerdict;
import java.util.List;

/**
 * A PDF was checked: published by {@link PdfService#verify} once the verifier completed the report, with
 * what the report says about the file and never the file itself, so an audit log of verifications is a listener rather
 * than a {@code PdfVerifier} subclass (the subclass seam stays). Not published for a file refused before a
 * report (413 past the cap, 400 not a PDF or one the program cannot read).
 *
 * <p>Delivery: synchronously on the caller's thread with Spring's default multicaster, before the report
 * is answered; nothing is stored, so there is no transaction to wait for. A listener that throws is logged and never
 * changes the report; it cannot veto (a rule over the report is the caller's, after {@code verify}).
 *
 * @param sha256 the file's SHA-256, lowercase hex, as the report names it
 * @param size the file's length in bytes
 * @param documentId the document key an intact signature signed, else the file's current one, else null
 * @param signatures each signature as the report places it (the signer's certificate summary, never its key or the bytes)
 * @param trustPolicy the trust policy the signers were placed under
 */
public record PdfVerifiedEvent(String sha256, long size, String documentId, List<SignatureVerdict> signatures,
                               PdfTrustPolicy.Summary trustPolicy) {

    public PdfVerifiedEvent {
        signatures = List.copyOf(signatures);
    }
}
