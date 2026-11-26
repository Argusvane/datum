package com.argusvane.datum.pdf;

/**
 * How a PDF was sealed: with the server's certificate, or, for answers that were never submitted, with a throwaway
 * test certificate ({@link TestSeal}, the dry run's PDFs).
 *
 * @param fingerprint the signer certificate's SHA-256, lowercase hex
 * @param subject its subject, as {@code Certificates.subject} writes it (the verify report's order)
 * @param timestamped whether an RFC 3161 token is in the signature (never for a test seal)
 * @param field the signature field
 * @param sha256 the SHA-256 of the sealed file, lowercase hex
 * @param test whether the certificate is a throwaway {@link TestSeal} one and not the server's: such a PDF says
 *     nothing about what this server issued
 */
public record PdfSeal(String fingerprint, String subject, boolean timestamped, String field, String sha256, boolean test) {
}
