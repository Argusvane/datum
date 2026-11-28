package com.argusvane.datum.pdf.verify;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.core.contracts.DatumJson;
import com.argusvane.datum.pdf.TestAssets;
import com.argusvane.datum.timestamp.InMemoryTsaLog;
import com.argusvane.datum.timestamp.TimestampAuthority;
import com.argusvane.datum.timestamp.TimestampToken;
import com.argusvane.datum.timestamp.TsaKey;
import com.argusvane.datum.timestamp.TsaKeyMaterial;
import java.nio.charset.StandardCharsets;
import java.security.Signature;
import java.security.cert.X509Certificate;
import java.time.Clock;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * The host's half of verifying a PDF (signature value, signer placement, timestamp check, certification state) over
 * {@code verify} reports shaped as the kernel's ({@code PdfSignatureReport}, {@code PdfTimestampReport}), with
 * real signatures by the PDF kernel's signing fixtures and real tokens from datum-timestamp's authority: a seal and
 * its verification, a later change and a certification, foreign signers, a timestamp.
 */
class PdfVerifierTest {

    private static final byte[] SIGNED = "the DER signed attributes of a signature".getBytes(StandardCharsets.US_ASCII);
    private static final String SHA256_RSA = "1.2.840.113549.1.1.11";
    private static final String ECDSA_SHA256 = "1.2.840.10045.4.3.2";
    private static final String SHA256 = "2.16.840.1.101.3.4.2.1";

    private static PdfVerifier verifier(PdfTrust trust) {
        return new PdfVerifier(trust, DatumJson.mapper());
    }

    private static PdfVerifier plain() {
        return verifier(PdfTrust.none(Clock.systemUTC()));
    }

    static byte[] sign(String fixture, String jca, byte[] data) throws Exception {
        Signature signature = Signature.getInstance(jca);
        signature.initSign(TestAssets.identity(fixture).privateKey());
        signature.update(data);
        return signature.sign();
    }

    static String b64(byte[] bytes) {
        return Base64.getEncoder().encodeToString(bytes);
    }

    static String der(X509Certificate certificate) throws Exception {
        return b64(certificate.getEncoded());
    }

    /** A signature report as the kernel writes one, for a fixture's signature over {@link #SIGNED}. */
    static ObjectNode report(String fixture, String oid, byte[] value) throws Exception {
        TsaKey key = TestAssets.identity(fixture);
        ObjectNode report = TestAssets.JSON.createObjectNode();
        report.put("field", "Signature1");
        report.put("subFilter", "ETSI.CAdES.detached");
        report.putArray("byteRange").add(0).add(100).add(200).add(50);
        report.put("coversDocument", true);
        report.put("digestMatches", true);
        report.put("certificateMatches", true);
        ObjectNode signer = report.putObject("signer");
        signer.put("certificate", der(key.leaf()));
        report.put("signerSource", "signature");
        ArrayNode certificates = report.putArray("certificates");
        for (X509Certificate certificate : key.chain()) {
            certificates.add(der(certificate));
        }
        report.put("signatureAlgorithm", oid);
        report.put("toBeVerified", b64(SIGNED));
        report.put("signature", b64(value));
        report.put("signingTime", "2026-09-05T10:11:12Z");
        report.put("reason", "Submitted through the web form");
        report.put("location", "Ottawa");
        report.putObject("certification").put("permissions", "noChanges");
        report.put("details", "signed");
        report.put("signedDocumentId", "2d711642b726b04401627ca9fbac32f5");
        return report;
    }

    static ObjectNode rsaReport() throws Exception {
        return report("rsa2048", SHA256_RSA, sign("rsa2048", "SHA256withRSA", SIGNED));
    }

    // ------------------------------------------------------------------------------------------------- the value

    @Test
    void theValueIsCheckedWithTheSignersKey() throws Exception {
        SignatureVerdict rsa = plain().signature(rsaReport());
        assertThat(rsa.value()).isEqualTo("valid");
        assertThat(rsa.valueDetail()).isNull();
        assertThat(rsa.intact()).isTrue();

        SignatureVerdict ec = plain().signature(report("p256", ECDSA_SHA256, sign("p256", "SHA256withECDSA", SIGNED)));
        assertThat(ec.value()).isEqualTo("valid");
        SignatureVerdict p384 = plain().signature(report("p384", ECDSA_SHA256, sign("p384", "SHA256withECDSA", SIGNED)));
        assertThat(p384.value()).isEqualTo("valid");

        // rsaEncryption names no digest: every SHA-2 digest is tried.
        SignatureVerdict bare = plain().signature(report("rsa2048", "1.2.840.113549.1.1.1", sign("rsa2048", "SHA384withRSA", SIGNED)));
        assertThat(bare.value()).isEqualTo("valid");
    }

    @Test
    void aValueThatDoesNotVerifyIsInvalidAndTheSignatureNotIntact() throws Exception {
        byte[] value = sign("rsa2048", "SHA256withRSA", SIGNED);
        value[10] ^= 0x01;
        SignatureVerdict verdict = plain().signature(report("rsa2048", SHA256_RSA, value));
        assertThat(verdict.value()).isEqualTo("invalid");
        assertThat(verdict.intact()).isFalse();
        // Another key's value under this certificate.
        SignatureVerdict other = plain().signature(report("rsa2048", SHA256_RSA, sign("chain-leaf", "SHA256withRSA", SIGNED)));
        assertThat(other.value()).isEqualTo("invalid");
        // An EC value under an RSA algorithm is an answer, not an error.
        SignatureVerdict mismatched = plain().signature(report("p256", SHA256_RSA, sign("p256", "SHA256withECDSA", SIGNED)));
        assertThat(mismatched.value()).isEqualTo("invalid");
    }

    @Test
    void whatCannotBeCheckedIsUncheckedAndSaysWhy() throws Exception {
        ObjectNode unknown = rsaReport();
        unknown.put("signatureAlgorithm", "1.2.3");
        SignatureVerdict algorithm = plain().signature(unknown);
        assertThat(algorithm.value()).isEqualTo("unchecked");
        assertThat(algorithm.valueDetail()).isEqualTo("The signature algorithm 1.2.3 is not checked here.");
        assertThat(algorithm.intact()).isFalse();

        ObjectNode unsigned = rsaReport();
        unsigned.putNull("signer");
        SignatureVerdict noSigner = plain().signature(unsigned);
        assertThat(noSigner.value()).isEqualTo("unchecked");
        assertThat(noSigner.valueDetail()).isEqualTo("The signature carries no signer certificate.");
        assertThat(noSigner.signer()).isNull();
        assertThat(noSigner.trust()).isEqualTo("unknown");

        ObjectNode empty = rsaReport();
        empty.put("toBeVerified", "");
        assertThat(plain().signature(empty).valueDetail()).isEqualTo("The signature has no signed attributes to check.");
        ObjectNode notBase64 = rsaReport();
        notBase64.put("signature", "%%%");
        assertThat(plain().signature(notBase64).value()).isEqualTo("unchecked");
    }

    @Test
    void intactNeedsTheDigestTheBindingAndTheValue() throws Exception {
        ObjectNode tampered = rsaReport();
        tampered.put("digestMatches", false);
        SignatureVerdict digest = plain().signature(tampered);
        assertThat(digest.value()).as("the value still verifies over the attributes").isEqualTo("valid");
        assertThat(digest.intact()).isFalse();
        ObjectNode unbound = rsaReport();
        unbound.put("certificateMatches", false);
        assertThat(plain().signature(unbound).intact()).isFalse();
        ObjectNode notBoolean = rsaReport();
        notBoolean.put("digestMatches", "true");
        assertThat(plain().signature(notBoolean).intact()).as("only a JSON true counts").isFalse();
    }

    @Test
    void theSignerIsSummarisedAsTheVerifyReportCarriesIt() throws Exception {
        SignatureVerdict verdict = plain().signature(rsaReport());
        assertThat(verdict.signer().subject()).isEqualTo("C=CA, O=Datum, CN=Datum demo signer");
        assertThat(verdict.signer().issuer()).isEqualTo("C=CA, O=Datum, CN=Datum demo signer");
        assertThat(verdict.signer().commonName()).isEqualTo("Datum demo signer");
        assertThat(verdict.signer().serial()).matches("^[0-9A-F]+$");
        assertThat(verdict.signer().notAfter()).isGreaterThan(verdict.signer().notBefore());
        assertThat(verdict.signer().fingerprint()).isEqualTo(Certificates.fingerprint(TestAssets.certificate("rsa2048")));
        assertThat(verdict.signerSource()).isEqualTo("signature");
        assertThat(verdict.field()).isEqualTo("Signature1");
        assertThat(verdict.byteRange()).containsExactly(0L, 100L, 200L, 50L);
        assertThat(verdict.certification()).isEqualTo("noChanges");
        assertThat(verdict.certificationState()).isEqualTo("kept");
        assertThat(verdict.reason()).isEqualTo("Submitted through the web form");
    }

    // ------------------------------------------------------------------------------------------------- the signer's place

    @Test
    void theSignerIsPlacedByFingerprintAnchorOrSelfSignature() throws Exception {
        X509Certificate rsa = TestAssets.certificate("rsa2048");
        assertThat(plain().signature(rsaReport()).trust()).isEqualTo("self_signed");
        PdfVerifier site = verifier(new PdfTrust(() -> List.of(rsa), List.of(), List.of(), List::of, Clock.systemUTC()));
        assertThat(site.signature(rsaReport()).trust()).isEqualTo("site");
        PdfVerifier retired = verifier(new PdfTrust(List::of, List.of(rsa), List.of(), List::of, Clock.systemUTC()));
        assertThat(retired.signature(rsaReport()).trust()).isEqualTo("site_retired");

        // testForeignSigners: unknown, then trusted through the intermediate it carries, then another root vouches for nothing.
        ObjectNode leaf = report("chain-leaf", SHA256_RSA, sign("chain-leaf", "SHA256withRSA", SIGNED));
        assertThat(plain().signature(leaf).trust()).isEqualTo("unknown");
        X509Certificate ca = TestAssets.certificate("demo-ca");
        PdfVerifier anchored = verifier(new PdfTrust(List::of, List.of(), List.of(ca), List::of, Clock.systemUTC()));
        SignatureVerdict trusted = anchored.signature(leaf);
        assertThat(trusted.trust()).isEqualTo("trusted");
        assertThat(trusted.intact()).isTrue();
        PdfVerifier elsewhere = verifier(new PdfTrust(List::of, List.of(), List.of(rsa), List::of, Clock.systemUTC()));
        assertThat(elsewhere.signature(leaf).trust()).isEqualTo("unknown");
        // The anchor is the leaf's own issuer: nothing needs carrying (openssl's CAfile check builds the same path).
        ObjectNode bareLeaf = leaf.deepCopy();
        bareLeaf.putArray("certificates").add(der(TestAssets.certificate("chain-leaf")));
        assertThat(anchored.signature(bareLeaf).trust()).isEqualTo("trusted");
        // An anchor that is the certificate itself holds while it is valid now.
        assertThat(verifier(new PdfTrust(List::of, List.of(), List.of(rsa), List::of, Clock.systemUTC())).signature(rsaReport()).trust())
            .isEqualTo("trusted");
        X509Certificate expired = TestAssets.certificate("expired");
        ObjectNode old = report("expired", SHA256_RSA, sign("expired", "SHA256withRSA", SIGNED));
        assertThat(verifier(new PdfTrust(List::of, List.of(), List.of(expired), List::of, Clock.systemUTC())).signature(old).trust())
            .isEqualTo("self_signed");
    }

    // ------------------------------------------------------------------------------------------------- the details and later revisions

    @Test
    void theSignedRevisionsDetailsWinAndWhatChangedAfterIsNamed() throws Exception {
        ObjectNode report = rsaReport();
        report.put("coversDocument", false);
        report.put("reason", "Approved by the Director");
        report.put("signingTime", "2020-01-01T00:00:00Z");
        ObjectNode signed = report.putObject("signedRevision");
        signed.put("reason", "Issued for R-1");
        signed.put("location", "Ottawa");
        signed.put("signingTime", "2026-09-05T10:11:12Z");
        signed.putObject("certification").put("permissions", "formFilling");
        ObjectNode changed = report.putObject("changedAfter");
        changed.put("reason", "Approved by the Director");
        changed.put("signingTime", "2020-01-01T00:00:00Z");
        changed.putNull("contactInfo");
        changed.putObject("certification").put("permissions", "noChanges");
        ObjectNode later = report.putObject("laterRevisions");
        later.put("revisions", 1);
        later.putArray("changes").addObject().put("ref", "7 0 R").put("kind", "signature-dictionary").put("detail", "redefined");
        later.put("permitted", false);
        later.putArray("reliedOnSignatures");
        SignatureVerdict verdict = plain().signature(report);
        assertThat(verdict.reason()).isEqualTo("Issued for R-1");
        assertThat(verdict.signingTime()).isEqualTo("2026-09-05T10:11:12Z");
        assertThat(verdict.certification()).isEqualTo("formFilling");
        assertThat(verdict.details()).isEqualTo("signed");
        assertThat(verdict.changedAfter()).containsEntry("reason", "Approved by the Director").containsEntry("signingTime", "2020-01-01T00:00:00Z")
            .containsEntry("contactInfo", null).containsEntry("certification", "noChanges");
        assertThat(verdict.laterRevisions().changes()).extracting(SignatureVerdict.Change::kind).containsExactly("signature-dictionary");
        assertThat(verdict.laterRevisions().permitted()).isFalse();
        assertThat(verdict.certificationState()).isEqualTo("broken");

        // "current": only the file's latest is known, and nothing is said changed.
        ObjectNode current = report.deepCopy();
        current.put("details", "current");
        SignatureVerdict latest = plain().signature(current);
        assertThat(latest.reason()).isEqualTo("Approved by the Director");
        assertThat(latest.changedAfter()).isEmpty();
        assertThat(latest.details()).isEqualTo("current");

        // A signature that covers the file has no later revisions, whatever the report says.
        ObjectNode whole = rsaReport();
        whole.set("laterRevisions", later.deepCopy());
        assertThat(plain().signature(whole).laterRevisions()).isNull();
    }

    @Test
    void anAppendedCommentIsNoRevisionAndTheCertificationAllowsIt() throws Exception {
        ObjectNode report = rsaReport();
        report.put("coversDocument", false);
        report.putObject("certification").put("permissions", "formFilling");
        report.putObject("changedAfter");
        ObjectNode later = report.putObject("laterRevisions");
        later.put("revisions", 0);
        later.putArray("changes");
        later.put("permitted", true);
        later.putArray("reliedOnSignatures");
        SignatureVerdict verdict = plain().signature(report);
        assertThat(verdict.laterRevisions().revisions()).isZero();
        assertThat(verdict.laterRevisions().reliedOnSignatures()).isEmpty();
        assertThat(verdict.certificationState()).isEqualTo("allowed");
    }

    private static SignatureVerdict.LaterRevisions later(int revisions, List<String> kinds, Boolean permitted) {
        List<SignatureVerdict.Change> changes = new ArrayList<>();
        kinds.forEach(kind -> changes.add(new SignatureVerdict.Change("9 0 R", kind, null)));
        return new SignatureVerdict.LaterRevisions(revisions, changes, permitted, null);
    }

    @Test
    void certificationStateFollowsTheDocMdpRuleCaseForCase() {
        Map<String, String> none = Map.of();
        assertThat(PdfVerifier.certificationState(null, false, none, null, true)).isNull();
        assertThat(PdfVerifier.certificationState("formFilling", true, none, null, true)).isEqualTo("kept");
        assertThat(PdfVerifier.certificationState("noChanges", true, none, null, true)).isEqualTo("kept");
        // The later revisions could not be read: undecided, but nothing at all may follow a noChanges certification.
        assertThat(PdfVerifier.certificationState("annotations", false, none, null, true)).isEqualTo("changed");
        assertThat(PdfVerifier.certificationState("noChanges", false, none, null, true)).isEqualTo("broken");
        // The signed dictionary says otherwise now, whatever the analysis.
        Map<String, String> reason = Map.of("reason", "x");
        assertThat(PdfVerifier.certificationState("annotations", false, reason, null, true)).isEqualTo("broken");
        assertThat(PdfVerifier.certificationState("annotations", false, reason, later(1, List.of("annotation"), true), true)).isEqualTo("broken");
        assertThat(PdfVerifier.certificationState("annotations", false, none, later(1, List.of("annotation", "page-annots"), true), true))
            .isEqualTo("allowed");
        assertThat(PdfVerifier.certificationState("formFilling", false, none, later(1, List.of("annotation"), false), true)).isEqualTo("broken");
        // A rewritten signature, even were it called permitted.
        assertThat(PdfVerifier.certificationState("annotations", false, none, later(1, List.of("signature-dictionary"), true), true)).isEqualTo("broken");
        assertThat(PdfVerifier.certificationState("noChanges", false, none, later(1, List.of(), true), true)).isEqualTo("broken");
        assertThat(PdfVerifier.certificationState("noChanges", false, none, later(0, List.of(), true), true)).isEqualTo("broken");
        assertThat(PdfVerifier.certificationState("formFilling", false, none, later(1, List.of(), null), true)).isEqualTo("changed");
        assertThat(PdfVerifier.certificationState(null, false, none, later(1, List.of("other"), null), true)).isNull();
        // A later signature the program counted as permitted must hold itself.
        SignatureVerdict.LaterRevisions signing = later(1, List.of("signature-field", "acroform", "page-annots"), true);
        assertThat(PdfVerifier.certificationState("formFilling", false, none, signing, true)).isEqualTo("allowed");
        assertThat(PdfVerifier.certificationState("formFilling", false, none, signing, false)).isEqualTo("broken");
        assertThat(PdfVerifier.certificationState("annotations", false, none, null, false)).isEqualTo("broken");
        assertThat(PdfVerifier.certificationState("formFilling", true, none, null, false)).isEqualTo("kept");
    }

    private static SignatureVerdict one(List<Long> range, boolean intact, SignatureVerdict.LaterRevisions laterRevisions) {
        return new SignatureVerdict("", "", range, intact ? "valid" : "invalid", null, true, true, false, intact, null, null, "unknown", null,
            null, null, null, null, null, null, "signed", Map.of(), laterRevisions, true, null, null, null);
    }

    @Test
    void laterSignaturesHoldWhenEveryLaterSignatureIsIntact() {
        SignatureVerdict first = one(List.of(0L, 100L, 200L, 50L), true, null);
        SignatureVerdict earlier = one(List.of(0L, 40L, 60L, 10L), false, null);
        assertThat(PdfVerifier.laterSignaturesHold(first, List.of(first, one(List.of(0L, 300L, 400L, 10L), true, null)))).isTrue();
        assertThat(PdfVerifier.laterSignaturesHold(first, List.of(first, one(List.of(0L, 300L, 400L, 10L), false, null)))).isFalse();
        assertThat(PdfVerifier.laterSignaturesHold(first, List.of(earlier, first))).as("one signed before it does not count").isTrue();
        List<Long> second = List.of(0L, 300L, 400L, 10L);
        SignatureVerdict.LaterRevisions relied = new SignatureVerdict.LaterRevisions(1, List.of(new SignatureVerdict.Change("9 0 R", "signature-field", null)),
            true, List.of(new SignatureVerdict.ReliedOn("Signature2", second)));
        SignatureVerdict named = one(List.of(0L, 100L, 200L, 50L), true, relied);
        SignatureVerdict unrelated = one(List.of(0L, 500L, 600L, 10L), false, null);
        // Only the ones relied on, when named.
        assertThat(PdfVerifier.laterSignaturesHold(named, List.of(named, one(second, true, null), unrelated))).isTrue();
        assertThat(PdfVerifier.laterSignaturesHold(named, List.of(named, one(second, false, null)))).isFalse();
        assertThat(PdfVerifier.laterSignaturesHold(named, List.of(named))).as("one relied on and not in the report").isFalse();
    }

    @Test
    void anUnreadableReliedOnEntryMatchesNoSignature() {
        ObjectNode later = TestAssets.JSON.createObjectNode();
        later.put("revisions", 1);
        later.putArray("changes").addObject().put("kind", "signature-field").put("ref", "4 0 R");
        later.putArray("reliedOnSignatures").add("garbage");
        SignatureVerdict.LaterRevisions read = PdfVerifier.laterRevisions(later);
        assertThat(read.reliedOnSignatures()).containsExactly(new SignatureVerdict.ReliedOn("", List.of()));
        assertThat(read.permitted()).isNull();
        ObjectNode noCount = TestAssets.JSON.createObjectNode();
        noCount.put("revisions", "1");
        assertThat(PdfVerifier.laterRevisions(noCount)).isNull();
    }

    // ------------------------------------------------------------------------------------------------- the whole answer

    @Test
    void theReportCarriesTheDocumentKeyAnIntactSignatureSignedElseTheFilesOwn() throws Exception {
        ObjectNode answer = TestAssets.JSON.createObjectNode();
        answer.put("ok", true);
        answer.put("op", "verify");
        ArrayNode signatures = answer.putArray("signatures");
        signatures.add(rsaReport());
        answer.putArray("attachments").addObject().put("name", "submission.json").put("sha256", "q83vEjRWeJA=").put("size", 42)
            .put("relationship", "Data");
        answer.putArray("warnings").addObject().put("code", "signature.certificate").put("message", "The certificate is self-signed.");
        answer.put("documentId", "ffffffffffffffffffffffffffffffff");
        PdfVerification report = plain().complete("abc", 1234, answer);
        assertThat(report.sha256()).isEqualTo("abc");
        assertThat(report.bytes()).isEqualTo(1234);
        assertThat(report.documentId()).isEqualTo("2d711642b726b04401627ca9fbac32f5");
        assertThat(report.documentIdSource()).isEqualTo("signed");
        assertThat(report.warnings()).containsExactly("The certificate is self-signed.");
        assertThat(report.attachments()).hasSize(1);
        assertThat(report.attachments().get(0).name()).isEqualTo("submission.json");
        assertThat(report.attachments().get(0).size()).isEqualTo(42L);

        // Tampered: no intact signature vouches for an id, so the file's current claim is used.
        ((ObjectNode) signatures.get(0)).put("digestMatches", false);
        PdfVerification tampered = plain().complete("abc", 1234, answer);
        assertThat(tampered.documentId()).isEqualTo("ffffffffffffffffffffffffffffffff");
        assertThat(tampered.documentIdSource()).isEqualTo("current");
        answer.put("documentId", "not a key");
        assertThat(plain().complete("abc", 1234, answer).documentId()).isNull();
    }

    @Test
    void aSecondSignatureThatDoesNotHoldBreaksTheCertificationItRestsOn() throws Exception {
        ObjectNode first = rsaReport();
        first.put("coversDocument", false);
        first.putObject("certification").put("permissions", "formFilling");
        ObjectNode later = first.putObject("laterRevisions");
        later.put("revisions", 1);
        later.putArray("changes").addObject().put("ref", "12 0 R").put("kind", "signature-field");
        later.put("permitted", true);
        ArrayNode relied = later.putArray("reliedOnSignatures");
        relied.addObject().put("field", "Signature2").putArray("byteRange").add(0).add(300).add(400).add(10);
        ObjectNode second = report("p256", ECDSA_SHA256, sign("p256", "SHA256withECDSA", SIGNED));
        second.put("field", "Signature2");
        second.putArray("byteRange").add(0).add(300).add(400).add(10);
        second.putNull("certification");
        ObjectNode answer = TestAssets.JSON.createObjectNode();
        answer.putArray("signatures").add(first).add(second);
        PdfVerification holds = plain().complete("x", 1, answer);
        assertThat(holds.signatures().get(0).laterSignaturesHold()).isTrue();
        assertThat(holds.signatures().get(0).certificationState()).isEqualTo("allowed");
        second.put("signature", b64(sign("p384", "SHA256withECDSA", SIGNED)));
        PdfVerification broken = plain().complete("x", 1, answer);
        assertThat(broken.signatures().get(1).intact()).isFalse();
        assertThat(broken.signatures().get(0).laterSignaturesHold()).isFalse();
        assertThat(broken.signatures().get(0).certificationState()).isEqualTo("broken");
    }

    // ------------------------------------------------------------------------------------------------- timestamps

    static TimestampAuthority authority() {
        return new TimestampAuthority(TsaKeyMaterial.of(TestAssets.identity("tsa")), null, null, Clock.systemUTC(), new InMemoryTsaLog(Clock.systemUTC()));
    }

    /** A signature report with a timestamp report over its value, shaped as the kernel's. */
    static ObjectNode timestamped(byte[] tokenOver) throws Exception {
        ObjectNode report = rsaReport();
        byte[] reply = authority().stamp(tokenOver, "sealing");
        TimestampToken token = TimestampToken.fromResponse(reply);
        ObjectNode timestamp = report.putObject("timestamp");
        timestamp.put("time", token.genTime().toString());
        timestamp.put("tsa", "C=CA, O=Datum, CN=Datum demo TSA");
        timestamp.put("coversSignature", token.covers(Base64.getDecoder().decode(report.path("signature").asString())));
        timestamp.put("token", b64(token.der()));
        timestamp.put("imprintAlgorithm", SHA256);
        timestamp.put("digestAlgorithm", SHA256);
        timestamp.put("toBeVerified", b64("tsa signed attributes".getBytes(StandardCharsets.US_ASCII)));
        timestamp.put("signatureAlgorithm", SHA256_RSA);
        timestamp.put("signature", b64("tsa value".getBytes(StandardCharsets.US_ASCII)));
        timestamp.putObject("signer").put("certificate", der(TestAssets.certificate("tsa")));
        timestamp.put("signerSource", "token");
        timestamp.putArray("certificates").add(der(TestAssets.certificate("tsa")));
        timestamp.put("messageDigestMatches", true);
        timestamp.put("contentTypeMatches", true);
        timestamp.put("certificateMatches", true);
        return report;
    }

    @Test
    void aTimestampIsCheckedWholeAndItsServerPlaced() throws Exception {
        byte[] value = sign("rsa2048", "SHA256withRSA", SIGNED);
        ObjectNode report = timestamped(value);
        TimestampVerdict unknown = plain().signature(report).timestamp();
        assertThat(unknown.coversSignature()).isTrue();
        assertThat(unknown.verified()).as(String.valueOf(unknown)).isTrue();
        assertThat(unknown.problem()).isNull();
        assertThat(unknown.trust()).isEqualTo("unknown");
        assertThat(unknown.site()).isFalse();
        assertThat(unknown.signer().subject()).isEqualTo("C=CA, O=Datum, CN=Datum demo TSA");
        assertThat(unknown.signer().commonName()).isEqualTo("Datum demo TSA");
        assertThat(unknown.signer().fingerprint()).isEqualTo(Certificates.fingerprint(TestAssets.certificate("tsa")));
        assertThat(unknown.signerSource()).isEqualTo("token");
        assertThat(unknown.time()).matches("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}.*");

        X509Certificate tsa = TestAssets.certificate("tsa");
        TimestampVerdict site = verifier(new PdfTrust(List::of, List.of(), List.of(), () -> List.of(tsa), Clock.systemUTC())).signature(report).timestamp();
        assertThat(site.trust()).isEqualTo("site");
        assertThat(site.site()).isTrue();
        TimestampVerdict trusted = verifier(new PdfTrust(List::of, List.of(), List.of(tsa), List::of, Clock.systemUTC())).signature(report).timestamp();
        assertThat(trusted.trust()).isEqualTo("trusted");
        assertThat(trusted.verified()).isTrue();
    }

    @Test
    void aTokenOverOtherBytesVouchesForNothing() throws Exception {
        ObjectNode report = timestamped("another signature value".getBytes(StandardCharsets.US_ASCII));
        TimestampVerdict verdict = plain().signature(report).timestamp();
        assertThat(verdict.coversSignature()).isFalse();
        assertThat(verdict.problem()).isEqualTo("imprint");
        assertThat(verdict.verified()).isFalse();
        assertThat(verdict.trust()).isEqualTo("invalid");
        // The signer is reported whenever the TSA's signature holds, the imprint aside: who stamped is a fact of its own.
        assertThat(verdict.signer()).isNotNull();
        // The program says it covers, the token says not: both must agree.
        ((ObjectNode) report.get("timestamp")).put("coversSignature", true);
        assertThat(plain().signature(report).timestamp().problem()).isEqualTo("imprint");
    }

    @Test
    void theProgramsFlagsMustHoldTooAndTheDigestBeOneCheckedHere() throws Exception {
        byte[] value = sign("rsa2048", "SHA256withRSA", SIGNED);
        ObjectNode report = timestamped(value);
        ((ObjectNode) report.get("timestamp")).put("certificateMatches", false);
        assertThat(plain().signature(report).timestamp().problem()).isEqualTo("binding");

        ObjectNode content = timestamped(value);
        ((ObjectNode) content.get("timestamp")).put("contentTypeMatches", false);
        assertThat(plain().signature(content).timestamp().problem()).isEqualTo("signature");

        ObjectNode digest = timestamped(value);
        ((ObjectNode) digest.get("timestamp")).put("messageDigestMatches", false);
        assertThat(plain().signature(digest).timestamp().problem()).isEqualTo("signature");

        ObjectNode sha1 = timestamped(value);
        ((ObjectNode) sha1.get("timestamp")).put("digestAlgorithm", "1.3.14.3.2.26");
        assertThat(plain().signature(sha1).timestamp().problem()).isEqualTo("signature");
    }

    /** The report of {@link #timestamped} with another token in it, its genTime the token's: the program's flags all true. */
    static ObjectNode withToken(byte[] value, byte[] tokenDer) throws Exception {
        ObjectNode report = timestamped(value);
        ObjectNode timestamp = (ObjectNode) report.get("timestamp");
        timestamp.put("token", b64(tokenDer));
        timestamp.put("time", TimestampToken.parse(tokenDer).genTime().toString());
        return report;
    }

    @Test
    void aTokenWhoseTsaSignatureIsForgedIsRefusedWhateverTheProgramsFlagsSay() throws Exception {
        // The host's own check of the token is what stands here: the program's flags all say true.
        byte[] value = sign("rsa2048", "SHA256withRSA", SIGNED);
        byte[] der = TimestampToken.fromResponse(authority().stamp(value, "sealing")).der();
        // The token ends with its SignerInfo's signature value (no unsigned attributes): flip a bit of it.
        der[der.length - 1] ^= 0x01;
        assertThat(TimestampToken.parse(der).covers(value)).as("still a token over this value").isTrue();
        X509Certificate tsa = TestAssets.certificate("tsa");
        ObjectNode report = withToken(value, der);
        TimestampVerdict verdict = verifier(new PdfTrust(List::of, List.of(), List.of(tsa), () -> List.of(tsa), Clock.systemUTC()))
            .signature(report).timestamp();
        assertThat(verdict.problem()).isEqualTo("signature");
        assertThat(verdict.verified()).isFalse();
        assertThat(verdict.trust()).isEqualTo("invalid");
        assertThat(verdict.site()).isFalse();
        assertThat(verdict.signer()).isNull();
    }

    @Test
    void aTokenWhoseSigningCertificateNamesAnotherCertificateIsABindingProblem() throws Exception {
        // A token signed by the TSA's key whose ESSCertIDv2 names another certificate of the same key: the signature
        // holds with the carried TSA certificate, the binding does not. The program's flags all say true.
        byte[] value = sign("rsa2048", "SHA256withRSA", SIGNED);
        TsaKey tsa = TestAssets.identity("tsa");
        X509Certificate real = tsa.leaf();
        org.bouncycastle.cert.jcajce.JcaX509v3CertificateBuilder twin = new org.bouncycastle.cert.jcajce.JcaX509v3CertificateBuilder(
            real.getSubjectX500Principal(), java.math.BigInteger.valueOf(4242), real.getNotBefore(), real.getNotAfter(),
            real.getSubjectX500Principal(), real.getPublicKey());
        twin.addExtension(org.bouncycastle.asn1.x509.Extension.extendedKeyUsage, true,
            new org.bouncycastle.asn1.x509.ExtendedKeyUsage(org.bouncycastle.asn1.x509.KeyPurposeId.id_kp_timeStamping));
        X509Certificate other = new org.bouncycastle.cert.jcajce.JcaX509CertificateConverter().getCertificate(
            twin.build(new org.bouncycastle.operator.jcajce.JcaContentSignerBuilder("SHA256withRSA").build(tsa.privateKey())));
        org.bouncycastle.operator.DigestCalculatorProvider digests = new org.bouncycastle.operator.jcajce.JcaDigestCalculatorProviderBuilder().build();
        org.bouncycastle.tsp.TimeStampTokenGenerator generator = new org.bouncycastle.tsp.TimeStampTokenGenerator(
            new org.bouncycastle.cms.jcajce.JcaSimpleSignerInfoGeneratorBuilder().build("SHA256withRSA", tsa.privateKey(), other),
            digests.get(new org.bouncycastle.asn1.x509.AlgorithmIdentifier(org.bouncycastle.asn1.nist.NISTObjectIdentifiers.id_sha256)),
            new org.bouncycastle.asn1.ASN1ObjectIdentifier("1.3.6.1.4.1.99999.1"));
        // Carries the real TSA certificate, not the one the attribute names.
        generator.addCertificates(new org.bouncycastle.cert.jcajce.JcaCertStore(List.of(real)));
        org.bouncycastle.tsp.TimeStampRequestGenerator requests = new org.bouncycastle.tsp.TimeStampRequestGenerator();
        requests.setCertReq(true);
        byte[] imprint = java.security.MessageDigest.getInstance("SHA-256").digest(value);
        byte[] der = generator.generate(requests.generate(org.bouncycastle.tsp.TSPAlgorithms.SHA256, imprint), java.math.BigInteger.TEN,
            new java.util.Date()).getEncoded();
        TimestampToken parsed = TimestampToken.parse(der);
        assertThat(parsed.signer(List.of())).as("the signature holds with the carried certificate").isEqualTo(real);
        assertThat(parsed.names(real)).isFalse();
        ObjectNode report = withToken(value, der);
        TimestampVerdict verdict = plain().signature(report).timestamp();
        assertThat(verdict.problem()).isEqualTo("binding");
        assertThat(verdict.verified()).isFalse();
        assertThat(verdict.trust()).isEqualTo("invalid");
    }

    @Test
    void aTokenThatCannotBeReadIsUnreadable() throws Exception {
        byte[] value = sign("rsa2048", "SHA256withRSA", SIGNED);
        ObjectNode missing = timestamped(value);
        ((ObjectNode) missing.get("timestamp")).remove("token");
        assertThat(plain().signature(missing).timestamp().problem()).isEqualTo("unreadable");
        ObjectNode garbage = timestamped(value);
        ((ObjectNode) garbage.get("timestamp")).put("token", b64(new byte[] {0x30, 0x03, 0x02, 0x01, 0x00}));
        assertThat(plain().signature(garbage).timestamp().problem()).isEqualTo("unreadable");
        ObjectNode time = timestamped(value);
        ((ObjectNode) time.get("timestamp")).put("time", "yesterday");
        assertThat(plain().signature(time).timestamp().problem()).isEqualTo("unreadable");
        ObjectNode attributes = timestamped(value);
        ((ObjectNode) attributes.get("timestamp")).put("toBeVerified", "");
        assertThat(plain().signature(attributes).timestamp().problem()).isEqualTo("unreadable");
        assertThat(plain().signature(attributes).timestamp().trust()).isEqualTo("invalid");
    }

    @Test
    void theKnownCertificatesAreTheTimestampServersAndTheAnchorsOnce() throws Exception {
        X509Certificate tsa = TestAssets.certificate("tsa");
        X509Certificate ca = TestAssets.certificate("demo-ca");
        PdfVerifier verifier = verifier(new PdfTrust(List::of, List.of(), List.of(ca, tsa), () -> List.of(tsa), Clock.systemUTC()));
        assertThat(verifier.knownCertificates()).containsExactly(der(tsa), der(ca));
        assertThat(plain().knownCertificates()).isEmpty();
    }

    @Test
    void certificatesReadInTheVerifyReportsFormat() throws Exception {
        String pem = TestAssets.signingPem("chain-leaf.cert.pem") + "junk\n" + TestAssets.signingPem("demo-ca.cert.pem");
        List<X509Certificate> both = com.argusvane.datum.timestamp.PemCertificates.read(pem);
        assertThat(both).hasSize(2);
        assertThat(Certificates.selfSigned(both.get(0))).isFalse();
        assertThat(Certificates.selfSigned(both.get(1))).isTrue();
        assertThat(Certificates.issuer(both.get(0))).isEqualTo("C=CA, O=Datum, CN=Datum demo CA");
        assertThat(Certificates.fromBase64("not base64")).isNull();
        assertThat(Certificates.fromDer(new byte[] {1, 2, 3})).isNull();
    }
}
