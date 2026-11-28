package com.argusvane.datum.pdf.verify;

import com.argusvane.datum.core.contracts.PdfAttachmentReport;
import com.argusvane.datum.timestamp.TimestampToken;
import com.argusvane.datum.timestamp.TsaCertificateRules;
import java.security.GeneralSecurityException;
import java.security.Signature;
import java.security.cert.CertPathBuilder;
import java.security.cert.CertStore;
import java.security.cert.CertStore;
import java.security.cert.CollectionCertStoreParameters;
import java.security.cert.PKIXBuilderParameters;
import java.security.cert.PKIXRevocationChecker;
import java.security.cert.TrustAnchor;
import java.security.cert.X509CertSelector;
import java.security.cert.X509Certificate;
import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Date;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

/**
 * The host's half of verifying a PDF, over the program's {@code verify} answer.
 *
 * <p>The program reads each signature: its byte range, whether the digest over it matches, whether the signer's
 * certificate is the one the signature names, the signed revision's details and what later revisions changed. The
 * signature value itself is checked here with {@code java.security} over the signed attributes and the signer's key
 * ({@link #checkValue}); the signer is placed ({@link #trust}): this server's certificate (now, or a retired one), one
 * that chains to a trust anchor (PKIX, under the {@link PdfTrustPolicy}: its anchors, revocation checking and validation
 * time), a self-signed one, or unknown.
 *
 * <p>A timestamp is never taken on its word: rather than verify the TSA's signature from the pieces the program
 * reports (the signed attributes and the value), the token itself (the report's {@code token}) is read again with datum-timestamp's {@link TimestampToken} and checked as a whole by
 * {@link TimestampToken#verifyOver} over this signature's value (the imprint, the TSTInfo content type, the
 * messageDigest, the TSA's signature with a certificate the token carries or the server knows, the
 * signingCertificate binding and genTime within that certificate's validity). The program's own flags
 * ({@code coversSignature}, {@code contentTypeMatches}, {@code messageDigestMatches}, {@code certificateMatches}) and
 * the digest list ({@link #TIMESTAMP_DIGESTS}: SHA-256/384/512) must hold too: both sides must agree before a token is
 * {@code verified}.
 *
 * <p>This host stores no PDFs, so the report names no issued record: it carries the file's SHA-256 and document key
 * for the application to look its own records up.
 *
 * <p>Not final: a host may extend it (to log, to add to a report) and hand its own to {@code PdfService}; what
 * makes a chain trusted is the {@link PdfTrustPolicy} it is built with, the default being {@link PdfTrustPolicy#standard()}.
 */
public class PdfVerifier {

    private static final Logger LOG = LoggerFactory.getLogger(PdfVerifier.class);

    /** Signature algorithms by OID: the JCA algorithms tried (the ones the PDF kernel signs with or reads). */
    static final Map<String, List<String>> ALGORITHMS = Map.of(
        "1.2.840.113549.1.1.11", List.of("SHA256withRSA"),
        "1.2.840.113549.1.1.12", List.of("SHA384withRSA"),
        "1.2.840.113549.1.1.13", List.of("SHA512withRSA"),
        "1.2.840.10045.4.3.2", List.of("SHA256withECDSA"),
        "1.2.840.10045.4.3.3", List.of("SHA384withECDSA"),
        "1.2.840.10045.4.3.4", List.of("SHA512withECDSA"),
        // rsaEncryption and id-ecPublicKey name no digest: the signer's digest algorithm, which the report does not
        // carry, is one of these.
        "1.2.840.113549.1.1.1", List.of("SHA256withRSA", "SHA384withRSA", "SHA512withRSA"),
        "1.2.840.10045.2.1", List.of("SHA256withECDSA", "SHA384withECDSA", "SHA512withECDSA"));

    /** A timestamp SignerInfo's digest algorithms checked here: SHA-256, SHA-384, SHA-512. */
    static final Set<String> TIMESTAMP_DIGESTS = Set.of("2.16.840.1.101.3.4.2.1", "2.16.840.1.101.3.4.2.2", "2.16.840.1.101.3.4.2.3");

    /** The most certificates the program takes in {@code knownCertificates}, and the largest. */
    static final int MAX_KNOWN = 64;
    static final int MAX_KNOWN_BYTES = 16 * 1024;

    private static final Pattern DOCUMENT_KEY = Pattern.compile("^[0-9a-f]{32}$");

    private final PdfTrust trust;
    private final PdfTrustPolicy policy;
    private final JsonMapper json;

    /** A verifier under the standard policy: the configured anchors, no revocation checking, judged now. */
    public PdfVerifier(PdfTrust trust, JsonMapper json) {
        this(trust, PdfTrustPolicy.standard(), json);
    }

    /**
     * @param trust what the server knows: its signers, their history, the configured anchors, its timestamp authority's
     *     certificates, the clock
     * @param policy what makes a chain trusted
     */
    public PdfVerifier(PdfTrust trust, PdfTrustPolicy policy, JsonMapper json) {
        this.trust = Objects.requireNonNull(trust, "trust");
        this.policy = Objects.requireNonNull(policy, "policy");
        this.json = Objects.requireNonNull(json, "json");
    }

    /** What the server knows. */
    public PdfTrust trust() {
        return trust;
    }

    /** What makes a chain trusted. */
    public PdfTrustPolicy policy() {
        return policy;
    }

    /** The policy's anchors, never null. */
    private List<X509Certificate> anchors() {
        return nonNull(policy.anchors(trust));
    }

    /**
     * The certificates the server knows, for the program to find signers in ({@code knownCertificates}): its
     * timestamp authority's (now and retired) and the trust anchors, DER base64, each once. Knowing is not trusting.
     * At most {@link #MAX_KNOWN} of at most 16 KiB each, the kernel's limits, so a long anchor list cannot turn every
     * verification into an {@code invalid_request}.
     */
    public List<String> knownCertificates() {
        Map<String, String> known = new LinkedHashMap<>();
        List<X509Certificate> all = new ArrayList<>(nonNull(trust.siteTimestampCertificates().get()));
        all.addAll(anchors());
        for (X509Certificate certificate : all) {
            try {
                byte[] der = certificate.getEncoded();
                if (der.length <= MAX_KNOWN_BYTES && known.size() < MAX_KNOWN) {
                    known.putIfAbsent(Certificates.fingerprint(certificate), Base64.getEncoder().encodeToString(der));
                }
            } catch (GeneralSecurityException e) {
                // A certificate that cannot be encoded helps no one find a signer.
            }
        }
        return List.copyOf(known.values());
    }

    /**
     * Completes the program's answer for a file, after the program ran.
     *
     * @param sha256 the file's SHA-256, lowercase hex
     * @param size its length
     * @param answer the program's {@code verify} reply
     */
    public PdfVerification complete(String sha256, long size, ObjectNode answer) {
        List<SignatureVerdict> signatures = new ArrayList<>();
        for (JsonNode report : answer.path("signatures").isArray() ? answer.path("signatures").values() : List.<JsonNode>of()) {
            if (report.isObject()) {
                signatures.add(signature((ObjectNode) report));
            }
        }
        // A later signature the program counted as a permitted change must hold itself: the program checks its
        // digest, never its value.
        List<SignatureVerdict> placed = new ArrayList<>();
        for (SignatureVerdict signature : signatures) {
            boolean hold = laterSignaturesHold(signature, signatures);
            placed.add(signature.withLater(hold, certificationState(signature.certification(), signature.coversDocument(),
                signature.changedAfter(), signature.laterRevisions(), hold)));
        }
        String key = null;
        String keySource = null;
        for (SignatureVerdict signature : placed) {
            if (signature.intact() && isDocumentKey(signature.signedDocumentId())) {
                key = signature.signedDocumentId();
                keySource = "signed";
                break;
            }
        }
        JsonNode current = answer.get("documentId");
        if (key == null && current != null && current.isString() && isDocumentKey(current.stringValue())) {
            key = current.stringValue();
            keySource = "current";
        }
        List<String> warnings = new ArrayList<>();
        for (JsonNode warning : answer.path("warnings").isArray() ? answer.path("warnings").values() : List.<JsonNode>of()) {
            if (warning.isObject() && warning.path("message").isString()) {
                warnings.add(warning.path("message").stringValue());
            }
        }
        List<PdfAttachmentReport> attachments = new ArrayList<>();
        for (JsonNode attachment : answer.path("attachments").isArray() ? answer.path("attachments").values() : List.<JsonNode>of()) {
            if (attachment.isObject()) {
                try {
                    attachments.add(json.treeToValue(attachment, PdfAttachmentReport.class));
                } catch (RuntimeException e) {
                    // An entry of another shape is not reported rather than reported wrong.
                }
            }
        }
        long failed = placed.stream().filter(signature -> !signature.intact()).count();
        if (failed > 0) {
            // This host keeps no signing log: an INFO line says a verified file did not hold.
            LOG.info("Datum PDF verify: {} of {} signature(s) do not hold (SHA-256 {}).", failed, placed.size(), sha256);
        }
        return new PdfVerification(sha256, size, placed, key, keySource, warnings, attachments, PdfTrustPolicy.Summary.of(policy));
    }

    private static boolean isDocumentKey(String value) {
        return value != null && DOCUMENT_KEY.matcher(value).matches();
    }

    /** One signature, checked and placed. */
    SignatureVerdict signature(ObjectNode report) {
        X509Certificate certificate = null;
        JsonNode signerNode = report.get("signer");
        if (signerNode != null && signerNode.isObject() && signerNode.path("certificate").isString()) {
            certificate = Certificates.fromBase64(signerNode.path("certificate").stringValue());
        }
        SignatureVerdict.Signer signer = certificate == null ? null : new SignatureVerdict.Signer(Certificates.subject(certificate),
            Certificates.issuer(certificate), Certificates.commonName(certificate), Certificates.serial(certificate),
            Certificates.notBefore(certificate), Certificates.notAfter(certificate), Certificates.fingerprint(certificate));
        ValueCheck value = checkValue(report, certificate);
        boolean digest = isTrue(report.get("digestMatches"));
        boolean binding = isTrue(report.get("certificateMatches"));
        List<X509Certificate> carried = certificates(report.get("certificates"));
        TimestampVerdict timestamp = null;
        JsonNode timestampNode = report.get("timestamp");
        if (timestampNode != null && timestampNode.isObject()) {
            timestamp = timestamp((ObjectNode) timestampNode, report);
        }
        boolean coversDocument = isTrue(report.get("coversDocument"));
        // The top-level entries are the file as it is now. A later revision may define this signature's dictionary
        // again: what was signed is the program's signedRevision, read from the revision the range ends with.
        Details details = details(report);
        String source = "current".equals(text(report.get("details"))) ? "current" : "signed";
        JsonNode signedRevision = report.get("signedRevision");
        if (source.equals("signed") && !coversDocument && signedRevision != null && signedRevision.isObject()) {
            details = details(signedRevision);
        }
        Map<String, String> changed = new LinkedHashMap<>();
        JsonNode changedAfter = report.get("changedAfter");
        if (source.equals("signed") && changedAfter != null && changedAfter.isObject()) {
            for (Map.Entry<String, JsonNode> entry : changedAfter.properties()) {
                JsonNode now = entry.getValue();
                String said;
                if (now.isObject()) {
                    said = now.path("permissions").isString() ? now.path("permissions").stringValue() : null;
                } else if (now.isString()) {
                    said = now.stringValue();
                } else {
                    said = null;
                }
                changed.put(entry.getKey(), said);
            }
        }
        SignatureVerdict.LaterRevisions later = coversDocument ? null : laterRevisions(report.get("laterRevisions"));
        SignatureVerdict.Commitment commitment = null;
        JsonNode commitmentNode = report.get("commitment");
        if (commitmentNode != null && commitmentNode.isObject()) {
            JsonNode type = commitmentNode.get("type");
            commitment = new SignatureVerdict.Commitment(type == null || type.isNull() ? "" : type.asString(""),
                text(commitmentNode.get("statement")));
        }
        JsonNode signerSource = report.get("signerSource");
        String place = signerSource != null && signerSource.isString()
            && (signerSource.stringValue().equals("signature") || signerSource.stringValue().equals("known")) ? signerSource.stringValue() : null;
        boolean intact = digest && binding && "valid".equals(value.state());
        Instant at = chainTime(timestamp, timestampNode);
        String standing = certificate == null ? "unknown" : trust(certificate, carried, at);
        // The time is the claim "a chain to an anchor held at this instant", so it is written only when one did:
        // a site signer, a self-signed or an unknown one had no chain judged, and a time there would be a false claim (and
        // would make two reports of the same file under the default policy differ).
        String trustedAt = "trusted".equals(standing) ? at.toString() : null;
        return new SignatureVerdict(textOr(report.get("field"), ""), textOr(report.get("subFilter"), ""), integers(report.get("byteRange")),
            value.state(), value.why(), digest, binding, coversDocument, intact, signer, place, standing, text(report.get("signedDocumentId")),
            details.certification(), timestamp, details.reason(), details.location(), details.name(), details.signingTime(), source,
            changed, later, true, certificationState(details.certification(), coversDocument, changed, later, true), commitment, trustedAt);
    }

    /**
     * The time a signer's chain is judged at, under the policy: now, or with {@link PdfTrustPolicy.ValidationTime#SIGNING_TIME}
     * the genTime of the signature's timestamp when that token verified whole and its authority is this server's or
     * trusted. The genTime is the one this host reads from the token it checked (signed by the authority), and the
     * program's report must say the same second, as both sides must agree everywhere else. A token from an authority nobody
     * here vouches for proves no time, and the signature's own {@code /M} is only the signer's claim: each of these, a
     * disagreement, and a proven time after now leave the chain judged now, never earlier.
     */
    Instant chainTime(TimestampVerdict timestamp, JsonNode report) {
        Instant now = trust.clock().instant();
        if (policy.validationTime() != PdfTrustPolicy.ValidationTime.SIGNING_TIME || timestamp == null || !timestamp.verified()
            || !("site".equals(timestamp.trust()) || "trusted".equals(timestamp.trust())) || report == null) {
            return now;
        }
        Instant proven;
        try {
            proven = TimestampToken.parse(Certificates.decode(text(report.get("token")))).genTime();
        } catch (RuntimeException e) {
            return now;
        }
        Instant reported = instant(timestamp.time());
        if (proven == null || reported == null || proven.getEpochSecond() != reported.getEpochSecond() || proven.isAfter(now)) {
            return now;
        }
        return proven;
    }

    /** A signature dictionary's entries as the program reports them: the texts and the DocMDP permissions. */
    record Details(String reason, String location, String name, String signingTime, String certification) {
    }

    private static Details details(JsonNode entries) {
        return new Details(text(entries.get("reason")), text(entries.get("location")), text(entries.get("name")),
            text(entries.get("signingTime")), text(entries.path("certification").get("permissions")));
    }

    /** What the program found the incremental updates after a signature changed ({@code laterRevisions}). */
    static SignatureVerdict.LaterRevisions laterRevisions(JsonNode report) {
        if (report == null || !report.isObject() || !isInt(report.get("revisions"))) {
            return null;
        }
        List<SignatureVerdict.Change> changes = new ArrayList<>();
        for (JsonNode change : report.path("changes").isArray() ? report.path("changes").values() : List.<JsonNode>of()) {
            if (change.isObject() && change.path("kind").isString()) {
                changes.add(new SignatureVerdict.Change(textOr(change.get("ref"), ""), change.path("kind").stringValue(), text(change.get("detail"))));
            }
        }
        List<SignatureVerdict.ReliedOn> relied = null;
        JsonNode reliedNode = report.get("reliedOnSignatures");
        if (reliedNode != null && reliedNode.isArray()) {
            relied = new ArrayList<>();
            for (JsonNode one : reliedNode.values()) {
                // One that cannot be read matches no signature, so it fails.
                relied.add(one.isObject()
                    ? new SignatureVerdict.ReliedOn(one.path("field").isString() ? one.path("field").stringValue() : "", integers(one.get("byteRange")))
                    : new SignatureVerdict.ReliedOn("", List.of()));
            }
        }
        JsonNode permitted = report.get("permitted");
        return new SignatureVerdict.LaterRevisions(report.get("revisions").intValue(), changes,
            permitted != null && permitted.isBoolean() ? permitted.booleanValue() : null, relied);
    }

    /**
     * Whether the later signatures a signature's changes rest on all hold.
     * Each one the program relied on must be intact in the same report; a program that names none: every signature
     * whose {@code /Contents} starts after the end of this one's signed revision must be intact.
     */
    public static boolean laterSignaturesHold(SignatureVerdict signature, List<SignatureVerdict> all) {
        List<SignatureVerdict.ReliedOn> relied = signature.laterRevisions() == null ? null : signature.laterRevisions().reliedOnSignatures();
        if (relied != null) {
            for (SignatureVerdict.ReliedOn one : relied) {
                List<SignatureVerdict> found = all.stream().filter(other -> other.byteRange().equals(one.byteRange())).toList();
                if (found.isEmpty() || found.stream().anyMatch(other -> !other.intact())) {
                    return false;
                }
            }
            return true;
        }
        List<Long> range = signature.byteRange();
        if (range.size() != 4) {
            return true;
        }
        long end = range.get(2) + range.get(3);
        for (SignatureVerdict other : all) {
            if (other.byteRange().size() == 4 && other.byteRange().get(1) >= end && !other.intact()) {
                return false;
            }
        }
        return true;
    }

    /**
     * Whether a certification still holds for the file as it is (ISO 32000-1 12.8.2.2, DocMDP: a later change is
     * judged against the certification's permissions). Null (not a certification); {@code kept} (nothing after it); {@code allowed}; {@code broken};
     * {@code changed} (changed after it and the later revisions could not be read: never a pass).
     */
    public static String certificationState(String certification, boolean coversDocument, Map<String, String> changedAfter,
                                            SignatureVerdict.LaterRevisions laterRevisions, boolean laterSignaturesHold) {
        if (certification == null) {
            return null;
        }
        if (coversDocument) {
            return "kept";
        }
        if (changedAfter != null && !changedAfter.isEmpty()) {
            // The signature's own dictionary says otherwise now: no permission allows that.
            return "broken";
        }
        if (certification.equals("noChanges")) {
            // No change at all is allowed, and bytes were added after it.
            return "broken";
        }
        if (!laterSignaturesHold) {
            return "broken";
        }
        if (laterRevisions == null) {
            return "changed";
        }
        boolean rewritten = laterRevisions.changes().stream().anyMatch(change -> "signature-dictionary".equals(change.kind()));
        if (rewritten || Boolean.FALSE.equals(laterRevisions.permitted())) {
            return "broken";
        }
        return Boolean.TRUE.equals(laterRevisions.permitted()) ? "allowed" : "changed";
    }

    /**
     * A signature's timestamp, checked, with the token checked whole here
     * ({@link TimestampToken#verifyOver}) as well as by the program's flags.
     *
     * @param report the signature report's {@code timestamp}
     * @param signature the signature report (its {@code signature} is the value the token must cover)
     */
    TimestampVerdict timestamp(ObjectNode report, ObjectNode signature) {
        String time = textOr(report.get("time"), "");
        String tsa = text(report.get("tsa"));
        boolean coversSignature = isTrue(report.get("coversSignature"));
        JsonNode sourceNode = report.get("signerSource");
        String signerSource = sourceNode != null && sourceNode.isString()
            && (sourceNode.stringValue().equals("token") || sourceNode.stringValue().equals("known")) ? sourceNode.stringValue() : null;
        TimestampVerdict unreadable = new TimestampVerdict(time, tsa, coversSignature, false, "invalid", false, null, signerSource, "unreadable");
        byte[] token = Certificates.decode(text(report.get("token")));
        // What a timestamp needs to be judged at all: the token, the TSA's signed attributes and signature value as the
        // program read them, and a time. The value the token must cover is this signature's own (the report's signature).
        byte[] signedAttributes = Certificates.decode(text(report.get("toBeVerified")));
        byte[] tsaValue = Certificates.decode(text(report.get("signature")));
        byte[] value = Certificates.decode(text(signature.get("signature")));
        Instant genTime = instant(time);
        if (token == null || token.length == 0 || signedAttributes == null || signedAttributes.length == 0 || tsaValue == null
            || tsaValue.length == 0 || value == null || value.length == 0 || genTime == null) {
            return unreadable;
        }
        TimestampToken parsed;
        try {
            parsed = TimestampToken.parse(token);
        } catch (RuntimeException e) {
            return unreadable;
        }
        List<X509Certificate> candidates = new ArrayList<>(nonNull(trust.siteTimestampCertificates().get()));
        candidates.addAll(anchors());
        TimestampToken.Verification verification;
        try {
            verification = parsed.verifyOver(value, candidates);
        } catch (RuntimeException e) {
            return unreadable;
        }
        // The program's conditions for the TSA's signature to be checked at all (its digest and its two attribute
        // flags), then this host's own check of the token.
        boolean programHolds = TIMESTAMP_DIGESTS.contains(textOr(report.get("digestAlgorithm"), ""))
            && isTrue(report.get("contentTypeMatches")) && isTrue(report.get("messageDigestMatches"));
        X509Certificate signer = programHolds && verification.problem() != TimestampToken.Problem.SIGNATURE ? verification.signer() : null;
        String problem;
        if (!coversSignature || verification.problem() == TimestampToken.Problem.IMPRINT) {
            problem = "imprint";
        } else if (signer == null) {
            problem = "signature";
        } else if (!isTrue(report.get("certificateMatches")) || verification.problem() == TimestampToken.Problem.BINDING) {
            problem = "binding";
        } else if (verification.problem() == TimestampToken.Problem.TIME || !Certificates.validAt(signer, genTime)) {
            problem = "time";
        } else {
            problem = null;
        }
        String placed = "invalid";
        if (problem == null) {
            Set<String> site = new HashSet<>();
            for (X509Certificate certificate : nonNull(trust.siteTimestampCertificates().get())) {
                site.add(Certificates.fingerprint(certificate));
            }
            if (site.contains(Certificates.fingerprint(signer))) {
                placed = "site";
            } else if (TsaCertificateRules.problem(signer, trust.clock().instant()).isEmpty()
                && chainsToAnchor(signer, parsed.certificates(), trust.clock().instant())) {
                // The authority's own chain is judged now under every policy: its genTime is its own word.
                placed = "trusted";
            } else {
                placed = "unknown";
            }
        }
        TimestampVerdict.Signer who = signer == null ? null
            : new TimestampVerdict.Signer(Certificates.subject(signer), Certificates.commonName(signer), Certificates.fingerprint(signer));
        return new TimestampVerdict(time, tsa, coversSignature, problem == null, placed, "site".equals(placed), who, signerSource, problem);
    }

    /** The token's genTime as the program reports it (ISO), or null when it does not read as a time. */
    private static Instant instant(String time) {
        if (time == null || time.isEmpty()) {
            return null;
        }
        try {
            return Instant.parse(time);
        } catch (DateTimeParseException e) {
            return null;
        }
    }

    /** A signature value's state ({@code valid}, {@code invalid} or {@code unchecked}) and, when unchecked, why. */
    record ValueCheck(String state, String why) {
    }

    /** Checks a signature value with the signer's public key. */
    static ValueCheck checkValue(ObjectNode report, X509Certificate certificate) {
        if (certificate == null) {
            return new ValueCheck("unchecked", "The signature carries no signer certificate.");
        }
        byte[] signed = Certificates.decode(text(report.get("toBeVerified")));
        byte[] value = Certificates.decode(text(report.get("signature")));
        if (signed == null || signed.length == 0 || value == null || value.length == 0) {
            return new ValueCheck("unchecked", "The signature has no signed attributes to check.");
        }
        String oid = textOr(report.get("signatureAlgorithm"), "");
        List<String> algorithms = ALGORITHMS.get(oid);
        if (algorithms == null) {
            return new ValueCheck("unchecked", "The signature algorithm " + (oid.isEmpty() ? "?" : oid) + " is not checked here.");
        }
        for (String algorithm : algorithms) {
            try {
                Signature verifier = Signature.getInstance(algorithm);
                verifier.initVerify(certificate.getPublicKey());
                verifier.update(signed);
                if (verifier.verify(value)) {
                    return new ValueCheck("valid", null);
                }
            } catch (GeneralSecurityException | RuntimeException e) {
                // A failed verify is an answer, not an error: the next algorithm is tried, then the value is invalid.
            }
        }
        return new ValueCheck("invalid", null);
    }

    /** Where a signer's certificate stands, its chain judged now. */
    String trust(X509Certificate certificate, List<X509Certificate> carried) {
        return trust(certificate, carried, trust.clock().instant());
    }

    /** Where a signer's certificate stands, a chain to an anchor judged at the time given (the policy's). */
    String trust(X509Certificate certificate, List<X509Certificate> carried, Instant at) {
        String fingerprint = Certificates.fingerprint(certificate);
        for (X509Certificate current : nonNull(trust.siteSigners().get())) {
            if (Certificates.fingerprint(current).equals(fingerprint)) {
                return "site";
            }
        }
        for (X509Certificate retired : trust.retiredSigners()) {
            if (Certificates.fingerprint(retired).equals(fingerprint)) {
                return "site_retired";
            }
        }
        if (chainsToAnchor(certificate, carried, at)) {
            return "trusted";
        }
        return Certificates.selfSigned(certificate) ? "self_signed" : "unknown";
    }

    /** {@link #chainsToAnchor(X509Certificate, List, Instant)} now. */
    boolean chainsToAnchor(X509Certificate certificate, List<X509Certificate> carried) {
        return chainsToAnchor(certificate, carried, trust.clock().instant());
    }

    /**
     * Whether a certificate chains to a trust anchor, for any purpose: a PKIX path build from the carried certificates (and the policy's stores) to one of
     * the policy's anchors, signatures, validity at the time given and CA constraints checked. Revocation is checked when
     * the policy asks, by the JDK's {@link PKIXRevocationChecker} as the policy sets it up (the standard policy checks
     * none, as before). An anchor that is the certificate itself holds while the certificate is valid at that time (an
     * anchor is trusted as it is: no revocation check applies to it). Any failure of the build, revocation included, is
     * "does not chain": never trusted on an error.
     */
    boolean chainsToAnchor(X509Certificate certificate, List<X509Certificate> carried, Instant at) {
        List<X509Certificate> anchors = anchors();
        if (anchors.isEmpty()) {
            return false;
        }
        String fingerprint = Certificates.fingerprint(certificate);
        for (X509Certificate anchor : anchors) {
            if (Certificates.fingerprint(anchor).equals(fingerprint)) {
                return Certificates.validAt(certificate, at);
            }
        }
        try {
            Set<TrustAnchor> trusted = new HashSet<>();
            for (X509Certificate anchor : anchors) {
                trusted.add(new TrustAnchor(anchor, null));
            }
            X509CertSelector target = new X509CertSelector();
            target.setCertificate(certificate);
            PKIXBuilderParameters parameters = new PKIXBuilderParameters(trusted, target);
            parameters.setDate(Date.from(at));
            CertPathBuilder builder = CertPathBuilder.getInstance("PKIX");
            if (policy.revocationChecking()) {
                // The JDK's checker, added explicitly: it then checks revocation whatever the RevocationEnabled flag says.
                PKIXRevocationChecker checker = (PKIXRevocationChecker) builder.getRevocationChecker();
                policy.configureRevocation(checker);
                parameters.setRevocationEnabled(true);
                parameters.addCertPathChecker(checker);
            } else {
                parameters.setRevocationEnabled(false);
            }
            for (CertStore store : policy.certStores() == null ? List.<CertStore>of() : policy.certStores()) {
                parameters.addCertStore(store);
            }
            List<X509Certificate> pool = new ArrayList<>();
            pool.add(certificate);
            for (X509Certificate one : carried) {
                if (!Certificates.fingerprint(one).equals(fingerprint)) {
                    pool.add(one);
                }
            }
            parameters.addCertStore(CertStore.getInstance("Collection", new CollectionCertStoreParameters(pool)));
            builder.build(parameters);
            return true;
        } catch (GeneralSecurityException | RuntimeException e) {
            return false;
        }
    }

    /** Certificates a report carries, read; the ones that do not read are skipped. */
    static List<X509Certificate> certificates(JsonNode list) {
        List<X509Certificate> out = new ArrayList<>();
        if (list != null && list.isArray()) {
            for (JsonNode der : list.values()) {
                X509Certificate certificate = der.isString() ? Certificates.fromBase64(der.stringValue()) : null;
                if (certificate != null) {
                    out.add(certificate);
                }
            }
        }
        return out;
    }

    private static List<X509Certificate> nonNull(List<X509Certificate> list) {
        return list == null ? List.of() : list;
    }

    private static boolean isTrue(JsonNode node) {
        return node != null && node.isBoolean() && node.booleanValue();
    }

    private static boolean isInt(JsonNode node) {
        return node != null && node.isIntegralNumber() && node.canConvertToInt();
    }

    private static String text(JsonNode node) {
        return node != null && node.isString() ? node.stringValue() : null;
    }

    private static String textOr(JsonNode node, String fallback) {
        return node != null && node.isString() ? node.stringValue() : fallback;
    }

    /** The integers of a list; anything else in it is skipped. */
    static List<Long> integers(JsonNode list) {
        List<Long> out = new ArrayList<>();
        if (list != null && list.isArray()) {
            for (JsonNode item : list.values()) {
                if (item.isIntegralNumber() && item.canConvertToLong()) {
                    out.add(item.longValue());
                }
            }
        }
        return out;
    }
}
