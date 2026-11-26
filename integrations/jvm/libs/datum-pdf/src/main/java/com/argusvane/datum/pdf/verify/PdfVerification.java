package com.argusvane.datum.pdf.verify;

import com.argusvane.datum.core.contracts.PdfAttachmentReport;
import java.util.List;

/**
 * A PDF checked: the verify report (endpoint catalog {@code PdfVerifyReport}); it names no issued record (this host
 * stores no PDFs: {@code sha256} and {@code documentId} are what an application looks its own records up by).
 *
 * @param sha256 the file's SHA-256, lowercase hex
 * @param bytes its size
 * @param signatures each signature, checked and placed
 * @param documentId the document key (the trailer {@code /ID}'s first element, 32 lowercase hex digits) an intact
 *     signature signed, else the file's current one, else null
 * @param documentIdSource {@code signed}, {@code current} or null
 * @param warnings the program's warning messages
 * @param attachments the embedded files the program listed (name, SHA-256 base64, size)
 * @param trustPolicy the trust policy the signers and timestamp authorities were placed under: its name,
 *     whether revocation was checked, and when chains were judged ({@code now} or {@code signing-time})
 */
public record PdfVerification(String sha256, long bytes, List<SignatureVerdict> signatures, String documentId, String documentIdSource,
                              List<String> warnings, List<PdfAttachmentReport> attachments, PdfTrustPolicy.Summary trustPolicy) {

    public PdfVerification {
        signatures = List.copyOf(signatures);
        warnings = List.copyOf(warnings);
        attachments = List.copyOf(attachments);
    }
}
