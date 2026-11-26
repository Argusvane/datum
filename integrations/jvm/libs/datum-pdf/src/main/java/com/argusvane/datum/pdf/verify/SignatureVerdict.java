package com.argusvane.datum.pdf.verify;

import java.util.List;
import java.util.Map;

/**
 * One signature, checked and placed: one entry of the verify report's {@code signatures} (endpoint catalog
 * {@code PdfSignatureVerdict}), member for member.
 *
 * @param field the field's name, "" for a signature no field links any more
 * @param subFilter {@code ETSI.CAdES.detached} or {@code adbe.pkcs7.detached}
 * @param byteRange the four integers of {@code /ByteRange}
 * @param value {@code valid}, {@code invalid} or {@code unchecked}: the signature value under the signer's key, checked here
 * @param valueDetail why it was not checked, or null
 * @param digestMatches the file still hashes to what was signed (the program's check)
 * @param certificateMatches the signed attributes name the signer's certificate (the program's check)
 * @param coversDocument nothing was appended after it
 * @param intact digest, binding and value all hold
 * @param signer the signer's certificate, or null
 * @param signerSource {@code signature}, {@code known} or null
 * @param trust {@code site}, {@code site_retired}, {@code trusted}, {@code self_signed} or {@code unknown}
 * @param signedDocumentId the {@code /ID} of the revision it covers, lowercase hex, or null
 * @param certification the DocMDP permissions the signed revision gives ({@code noChanges}, {@code formFilling},
 *     {@code annotations}), or null for an approval signature
 * @param timestamp its RFC 3161 token, checked, or null
 * @param reason the signed revision's reason, or null
 * @param location the signed revision's location, or null
 * @param name the signed revision's name, or null
 * @param signingTime the signed revision's {@code /M}, ISO, or null
 * @param details {@code signed} or {@code current}
 * @param changedAfter what a later revision says instead, by key
 * @param laterRevisions what the later revisions changed, or null when it covers the file or they could not be read
 * @param laterSignaturesHold every later signature its changes rest on is intact
 * @param certificationState null, {@code kept}, {@code allowed}, {@code broken} or {@code changed}
 * @param commitment the signed commitment type and statement, or null
 * @param trustedAt the instant a chain to an anchor was judged at (ISO): now, or under a signing-time policy the time
 *     the signature's verified timestamp proves; null unless {@code trust} is {@code trusted}
 */
public record SignatureVerdict(String field, String subFilter, List<Long> byteRange, String value, String valueDetail,
                               boolean digestMatches, boolean certificateMatches, boolean coversDocument, boolean intact,
                               Signer signer, String signerSource, String trust, String signedDocumentId, String certification,
                               TimestampVerdict timestamp, String reason, String location, String name, String signingTime,
                               String details, Map<String, String> changedAfter, LaterRevisions laterRevisions,
                               boolean laterSignaturesHold, String certificationState, Commitment commitment, String trustedAt) {

    /** A signer certificate summary. Times are Unix seconds, as the verify report carries them. */
    public record Signer(String subject, String issuer, String commonName, String serial, long notBefore, long notAfter, String fingerprint) {
    }

    /** The commitment type and the signer's statement. */
    public record Commitment(String type, String statement) {
    }

    /**
     * The incremental updates after a signature.
     *
     * @param revisions how many revisions follow the signed one
     * @param changes each object they added, changed or freed
     * @param permitted whether the certification's permissions allow every change (null for an approval signature)
     * @param reliedOnSignatures the later signatures the program relied on, or null when it does not say
     */
    public record LaterRevisions(int revisions, List<Change> changes, Boolean permitted, List<ReliedOn> reliedOnSignatures) {
    }

    /** One object a later update changed. */
    public record Change(String ref, String kind, String detail) {
    }

    /** A later signature the program relied on, by field and byte range. */
    public record ReliedOn(String field, List<Long> byteRange) {
    }

    SignatureVerdict withLater(boolean hold, String state) {
        return new SignatureVerdict(field, subFilter, byteRange, value, valueDetail, digestMatches, certificateMatches, coversDocument,
            intact, signer, signerSource, trust, signedDocumentId, certification, timestamp, reason, location, name, signingTime, details,
            changedAfter, laterRevisions, hold, state, commitment, trustedAt);
    }
}
