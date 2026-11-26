package com.argusvane.datum.webauthn;

import static org.assertj.core.api.Assertions.assertThat;

import java.math.BigInteger;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyPairGenerator;
import java.security.interfaces.RSAPublicKey;
import java.util.Arrays;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import tools.jackson.databind.node.ObjectNode;

/**
 * The WebAuthn verdicts on webauthn4j, against a software authenticator on the JCA: every refusal the
 * verifier makes, under the check names the wire's words read (origin, rpId and
 * userVerified have their own sentences), plus crossOrigin, the library's own rules, the pre-gate and members of other
 * types.
 */
class WebAuthnVerifierTest {

    private static final List<String> ORIGINS = List.of("http://localhost");
    private final WebAuthnVerifier verifier = new WebAuthnVerifier();

    /** A registration verifies, and yields the key the authenticator holds. */
    @ParameterizedTest
    @ValueSource(ints = {CoseKey.ES256, CoseKey.RS256})
    void registration(int algorithm) {
        SoftwareAuthenticator authenticator = new SoftwareAuthenticator(algorithm);
        byte[] challenge = SoftwareAuthenticator.random(32);
        ObjectNode record = authenticator.register(Base64Url.encode(challenge));
        WebAuthnVerdict verdict = verifier.verifyRegistration(record.get("response"), challenge, ORIGINS, "localhost", true,
            Base64Url.decode(record.get("id").asString()), Base64.getDecoder().decode(record.get("publicKey").asString()));
        assertThat(verdict.valid()).as(String.valueOf(verdict.reason())).isTrue();
        assertThat(verdict.checks()).doesNotContainValue(false);
        assertThat(verdict.credential().credentialId()).isEqualTo(authenticator.credentialId);
        assertThat(verdict.credential().spki()).isEqualTo(authenticator.spki);
        assertThat(verdict.credential().algorithm()).isEqualTo(algorithm);
        assertThat(verdict.flags().backupEligible()).isTrue();
        // Attestation none, recorded with the format and the AAGUID (all zeros: not disclosed).
        assertThat(verdict.credential().attestationFormat()).isEqualTo("none");
        assertThat(verdict.credential().aaguid()).isEqualTo("00000000-0000-0000-0000-000000000000");
        assertThat(verdict.credential().origin()).isEqualTo("http://localhost");

        // From the authenticator data alone (no attestation object).
        ObjectNode bare = (ObjectNode) record.get("response").deepCopy();
        bare.remove("attestationObject");
        WebAuthnVerdict alone = verifier.verifyRegistration(bare, challenge, ORIGINS, "localhost", true, null, null);
        assertThat(alone.valid()).as(String.valueOf(alone.reason())).isTrue();
        assertThat(alone.credential().attestationFormat()).isEmpty();
        assertThat(alone.credential().spki()).isEqualTo(authenticator.spki);
    }

    /** Each registration check fails on its own, under its name. */
    @Test
    void registrationChecks() {
        SoftwareAuthenticator authenticator = new SoftwareAuthenticator();
        byte[] challenge = SoftwareAuthenticator.random(32);
        String b64 = Base64Url.encode(challenge);
        Map<String, Object[]> cases = new LinkedHashMap<>();
        cases.put("type", new Object[] {authenticator.register(b64, Map.of("type", "webauthn.get")), null});
        cases.put("challenge", new Object[] {authenticator.register(Base64Url.encode(SoftwareAuthenticator.random(32))), null});
        cases.put("origin", new Object[] {authenticator.register(b64, Map.of("origin", "https://evil.example")), null});
        cases.put("rpId", new Object[] {authenticator.register(b64, Map.of("rpId", "evil.example")), null});
        // AT and UV without UP.
        cases.put("userPresent", new Object[] {authenticator.register(b64, Map.of("flags", 0x40 | 0x04)), null});
        cases.put("userVerified", new Object[] {authenticator.register(b64, Map.of("uv", false)), null});
        // No AT flag and no attested credential data: nothing to register.
        cases.put("attestedCredential", new Object[] {authenticator.register(b64, Map.of("flags", 0x05, "bare", true)), null});
        cases.put("credentialId", new Object[] {authenticator.register(b64), SoftwareAuthenticator.random(16)});
        cases.forEach((failed, entry) -> {
            ObjectNode record = (ObjectNode) entry[0];
            WebAuthnVerdict verdict = verifier.verifyRegistration(record.get("response"), challenge, ORIGINS, "localhost", true, (byte[]) entry[1], null);
            assertThat(verdict.valid()).as(failed).isFalse();
            assertThat(verdict.failed()).as(failed).isEqualTo(failed);
            assertThat(verdict.reason()).as(failed).isEqualTo(WebAuthnVerifier.REASONS.get(failed));
            assertThat(verdict.credential()).as(failed).isNull();
        });
        // A public key the browser reports that is not the authenticator's.
        SoftwareAuthenticator other = new SoftwareAuthenticator();
        WebAuthnVerdict verdict = verifier.verifyRegistration(authenticator.register(b64).get("response"), challenge, ORIGINS, "localhost", true, null, other.spki);
        assertThat(verdict.failed()).isEqualTo("publicKey");
        // A reported key that is no key (the ceremony passes an empty array for one that is not base64).
        assertThat(verifier.verifyRegistration(authenticator.register(b64).get("response"), challenge, ORIGINS, "localhost", true, null, new byte[0])
            .failed()).isEqualTo("publicKey");
        // An attestation object whose authData differs from the one reported.
        ObjectNode record = authenticator.register(b64);
        ((ObjectNode) record.get("response")).put("authenticatorData", other.register(b64).get("response").get("authenticatorData").asString());
        assertThat(verifier.verifyRegistration(record.get("response"), challenge, ORIGINS, "localhost", true, null, null).failed()).isEqualTo("readable");
        // No AT flag with the attested credential data still there: bytes after the authenticator data, unreadable (not the AT check).
        assertThat(verifier.verifyRegistration(authenticator.register(b64, Map.of("flags", 0x05)).get("response"), challenge, ORIGINS, "localhost", true,
            null, null).failed()).isEqualTo("readable");
        // Preferred verification: no UV is fine.
        assertThat(verifier.verifyRegistration(authenticator.register(b64, Map.of("uv", false)).get("response"), challenge, ORIGINS, "localhost", false, null, null).valid()).isTrue();
    }

    /** The library stops at its first refusal: the checks before it passed, the ones after it were not reached. */
    @Test
    void theChecksMapSaysWhatPassedAndWhatWasNotReached() {
        SoftwareAuthenticator authenticator = new SoftwareAuthenticator();
        byte[] challenge = SoftwareAuthenticator.random(32);
        WebAuthnVerdict verdict = verifier.verifyRegistration(authenticator.register(Base64Url.encode(challenge), Map.of("rpId", "evil.example"))
            .get("response"), challenge, ORIGINS, "localhost", true, null, null);
        assertThat(verdict.checks()).containsExactly(
            Map.entry("readable", true), Map.entry("type", true), Map.entry("challenge", true), Map.entry("origin", true),
            Map.entry("rpId", false), Map.entry("userPresent", false), Map.entry("userVerified", false), Map.entry("attestedCredential", true),
            Map.entry("credentialId", false), Map.entry("publicKey", false), Map.entry(WebAuthnVerifier.LIBRARY_CHECK, false));
        byte[] document = SoftwareAuthenticator.sha256("document");
        WebAuthnVerdict wrongKey = verifier.verifyAssertion(authenticator.assertion(document), document, ORIGINS, "localhost",
            new SoftwareAuthenticator().spki, CoseKey.ES256, true);
        assertThat(wrongKey.failed()).isEqualTo("signature");
        assertThat(wrongKey.checks()).containsEntry("userVerified", true).containsEntry("signature", false)
            .containsEntry(WebAuthnVerifier.LIBRARY_CHECK, false);
        WebAuthnVerdict unreadable = verifier.verifyAssertion(SoftwareAuthenticator.JSON.createObjectNode(), document, ORIGINS, "localhost",
            authenticator.spki, CoseKey.ES256, true);
        assertThat(unreadable.checks()).doesNotContainValue(true);
    }

    /** A registration made in a frame of another site (crossOrigin true) is refused at the origin check. */
    @Test
    void registrationCrossOrigin() {
        SoftwareAuthenticator authenticator = new SoftwareAuthenticator();
        byte[] challenge = SoftwareAuthenticator.random(32);
        ObjectNode response = (ObjectNode) authenticator.register(Base64Url.encode(challenge)).get("response").deepCopy();
        ObjectNode clientData = (ObjectNode) SoftwareAuthenticator.JSON.readTree(Base64Url.decode(response.get("clientDataJSON").asString()));
        clientData.put("crossOrigin", true);
        response.put("clientDataJSON", Base64Url.encode(SoftwareAuthenticator.JSON.writeValueAsString(clientData).getBytes(StandardCharsets.UTF_8)));
        WebAuthnVerdict verdict = verifier.verifyRegistration(response, challenge, ORIGINS, "localhost", true, null, null);
        assertThat(verdict.failed()).isEqualTo("origin");
        assertThat(verdict.credential()).isNull();
        // The text "true" the library reads as true as well: refused too.
        clientData.put("crossOrigin", "true");
        response.put("clientDataJSON", Base64Url.encode(SoftwareAuthenticator.JSON.writeValueAsString(clientData).getBytes(StandardCharsets.UTF_8)));
        WebAuthnVerdict text = verifier.verifyRegistration(response, challenge, ORIGINS, "localhost", true, null, null);
        assertThat(text.failed()).isEqualTo("origin");
        assertThat(text.credential()).isNull();
    }

    /**
     * The origin is exactly a configured one, as written (the old verifier's and the other hosts' rule): webauthn4j
     * compares origins after normalising them (case, the default port, a path, a query, a fragment, user info dropped),
     * so this site compares the text again, on both ceremonies, and a variant is never stored as the passkey's origin.
     */
    @Test
    void theOriginIsExactlyAConfiguredOne() {
        SoftwareAuthenticator authenticator = new SoftwareAuthenticator();
        byte[] challenge = SoftwareAuthenticator.random(32);
        byte[] document = SoftwareAuthenticator.sha256("document");
        for (String variant : List.of("http://localhost/", "http://localhost/evil/path", "HTTP://LOCALHOST", "http://Localhost",
            "http://localhost:80", "http://user:pw@localhost", "http://localhost?x=1", "http://localhost#f")) {
            WebAuthnVerdict registration = verifier.verifyRegistration(authenticator.register(Base64Url.encode(challenge), Map.of("origin", variant))
                .get("response"), challenge, ORIGINS, "localhost", true, null, null);
            assertThat(registration.failed()).as(variant).isEqualTo("origin");
            assertThat(registration.reason()).as(variant).isEqualTo(WebAuthnVerifier.REASONS.get("origin"));
            assertThat(registration.credential()).as(variant).isNull();
            WebAuthnVerdict assertion = verifier.verifyAssertion(authenticator.assertion(document, Map.of("origin", variant)), document, ORIGINS,
                "localhost", authenticator.spki, CoseKey.ES256, true);
            assertThat(assertion.failed()).as(variant).isEqualTo("origin");
            assertThat(assertion.checks().get("origin")).as(variant).isFalse();
        }
        // In the old order: an origin that is not exactly a configured one is named before the relying party, presence,
        // verification and the signature, even where the library (normalising it) refused one of those first.
        WebAuthnVerdict alsoRpId = verifier.verifyRegistration(authenticator.register(Base64Url.encode(challenge),
            Map.of("origin", "http://localhost/", "rpId", "evil.example")).get("response"), challenge, ORIGINS, "localhost", true, null, null);
        assertThat(alsoRpId.failed()).isEqualTo("origin");
        assertThat(alsoRpId.checks()).containsEntry("challenge", true).containsEntry("origin", false).containsEntry("rpId", false);
        assertThat(verifier.verifyAssertion(authenticator.assertion(document, Map.of("origin", "http://localhost/")), document, ORIGINS,
            "localhost", new SoftwareAuthenticator().spki, CoseKey.ES256, true).failed()).isEqualTo("origin");
        assertThat(verifier.verifyAssertion(authenticator.assertion(document, Map.of("origin", "http://localhost/", "uv", false)), document, ORIGINS,
            "localhost", authenticator.spki, CoseKey.ES256, true).failed()).isEqualTo("origin");
        // ... and after the type and the challenge, as before.
        assertThat(verifier.verifyAssertion(authenticator.assertion(document, Map.of("origin", "http://localhost/", "type", "webauthn.create")),
            document, ORIGINS, "localhost", authenticator.spki, CoseKey.ES256, true).failed()).isEqualTo("type");
        assertThat(verifier.verifyAssertion(authenticator.assertion(document, Map.of("origin", "http://localhost/")), SoftwareAuthenticator.sha256("other"),
            ORIGINS, "localhost", authenticator.spki, CoseKey.ES256, true).failed()).isEqualTo("challenge");
        // An origin that is no URL at all the library cannot parse: refused as unreadable (the wire's answer, 422 passkey.invalid,
        // is the origin check's).
        assertThat(verifier.verifyAssertion(authenticator.assertion(document, Map.of("origin", "http://localhost ")), document, ORIGINS,
            "localhost", authenticator.spki, CoseKey.ES256, true).failed()).isEqualTo("readable");
        assertThat(verifier.verifyRegistration(authenticator.register(Base64Url.encode(challenge), Map.of("origin", "http://localhost ")).get("response"),
            challenge, ORIGINS, "localhost", true, null, null).failed()).isEqualTo("readable");
        // A configured origin with a port is matched as written too.
        List<String> withPort = List.of("http://localhost:8080");
        assertThat(verifier.verifyAssertion(authenticator.assertion(document, Map.of("origin", "http://localhost:8080")), document, withPort,
            "localhost", authenticator.spki, CoseKey.ES256, true).valid()).isTrue();
        assertThat(verifier.verifyAssertion(authenticator.assertion(document, Map.of("origin", "http://localhost:8080/")), document, withPort,
            "localhost", authenticator.spki, CoseKey.ES256, true).failed()).isEqualTo("origin");
    }

    /** An assertion verifies with the registered key, and each check fails under its name. */
    @ParameterizedTest
    @ValueSource(ints = {CoseKey.ES256, CoseKey.RS256})
    void assertion(int algorithm) {
        SoftwareAuthenticator authenticator = new SoftwareAuthenticator(algorithm);
        byte[] challenge = SoftwareAuthenticator.sha256("document");
        ObjectNode assertion = authenticator.assertion(challenge);
        WebAuthnVerdict verdict = verifier.verifyAssertion(assertion, challenge, ORIGINS, "localhost", authenticator.spki, algorithm, true);
        assertThat(verdict.valid()).as(String.valueOf(verdict.reason())).isTrue();
        assertThat(verdict.signCount()).isEqualTo(authenticator.counter);
        assertThat(verdict.checks()).doesNotContainValue(false);

        SoftwareAuthenticator other = new SoftwareAuthenticator(algorithm);
        assertThat(verifier.verifyAssertion(assertion, challenge, ORIGINS, "localhost", other.spki, algorithm, true).failed()).isEqualTo("signature");
        assertThat(verifier.verifyAssertion(assertion, SoftwareAuthenticator.sha256("other"), ORIGINS, "localhost", authenticator.spki, algorithm, true).failed()).isEqualTo("challenge");
        assertThat(verifier.verifyAssertion(assertion, challenge, List.of("https://example.com"), "localhost", authenticator.spki, algorithm, true).failed()).isEqualTo("origin");
        assertThat(verifier.verifyAssertion(assertion, challenge, ORIGINS, "example.com", authenticator.spki, algorithm, true).failed()).isEqualTo("rpId");
        assertThat(verifier.verifyAssertion(authenticator.assertion(challenge, Map.of("type", "webauthn.create")), challenge, ORIGINS, "localhost", authenticator.spki, algorithm, true).failed()).isEqualTo("type");
        // UV, BE and BS without UP: no user presence, whatever verification says.
        ObjectNode noUp = authenticator.assertion(challenge, Map.of("flags", 0x04 | 0x08 | 0x10));
        WebAuthnVerdict absent = verifier.verifyAssertion(noUp, challenge, ORIGINS, "localhost", authenticator.spki, algorithm, false);
        assertThat(absent.failed()).isEqualTo("userPresent");
        assertThat(absent.reason()).isEqualTo(WebAuthnVerifier.REASONS.get("userPresent"));
        ObjectNode noUv = authenticator.assertion(challenge, Map.of("uv", false));
        assertThat(verifier.verifyAssertion(noUv, challenge, ORIGINS, "localhost", authenticator.spki, algorithm, true).failed()).isEqualTo("userVerified");
        assertThat(verifier.verifyAssertion(noUv, challenge, ORIGINS, "localhost", authenticator.spki, algorithm, false).valid()).isTrue();
        // The key must be of the algorithm's kind.
        int wrong = algorithm == CoseKey.ES256 ? CoseKey.RS256 : CoseKey.ES256;
        assertThat(verifier.verifyAssertion(assertion, challenge, ORIGINS, "localhost", authenticator.spki, wrong, true).failed()).isEqualTo("signature");
        // A tampered authenticator data.
        ObjectNode tampered = assertion.deepCopy();
        byte[] bytes = Base64Url.decode(assertion.get("authenticatorData").asString());
        byte[] changed = Arrays.copyOf(bytes, 37);
        ByteBuffer.wrap(changed, 33, 4).putInt(999);
        tampered.put("authenticatorData", Base64Url.encode(changed));
        assertThat(verifier.verifyAssertion(tampered, challenge, ORIGINS, "localhost", authenticator.spki, algorithm, true).failed()).isEqualTo("signature");
        // Garbage.
        ObjectNode garbage = SoftwareAuthenticator.JSON.createObjectNode().put("clientDataJSON", "!!");
        assertThat(verifier.verifyAssertion(garbage, challenge, ORIGINS, "localhost", authenticator.spki, algorithm, true).failed()).isEqualTo("readable");
    }

    /** A frame of another site, members of other types, an unknown algorithm, a key that is none. */
    @Test
    void assertionRefusalsTheHostChecksItself() {
        SoftwareAuthenticator authenticator = new SoftwareAuthenticator();
        byte[] challenge = SoftwareAuthenticator.sha256("document");
        // crossOrigin true is the origin check's, never configured away as a topOrigin; the library stops there.
        ObjectNode framed = authenticator.assertion(challenge, Map.of("crossOrigin", true, "topOrigin", "http://localhost"));
        WebAuthnVerdict verdict = verifier.verifyAssertion(framed, challenge, ORIGINS, "localhost", authenticator.spki, CoseKey.ES256, false);
        assertThat(verdict.failed()).isEqualTo("origin");
        assertThat(verdict.checks().get("signature")).as("not reached").isFalse();
        assertThat(verifier.verifyAssertion(authenticator.assertion(challenge, Map.of("crossOrigin", true)), challenge, ORIGINS, "localhost",
            authenticator.spki, CoseKey.ES256, false).failed()).isEqualTo("origin");
        // A topOrigin without crossOrigin: the library refuses it too (a frame this site never expects).
        assertThat(verifier.verifyAssertion(authenticator.assertion(challenge, Map.of("topOrigin", "https://evil.example")), challenge, ORIGINS,
            "localhost", authenticator.spki, CoseKey.ES256, false).failed()).isEqualTo("origin");
        // A member of another type is unreadable, never an error.
        ObjectNode typed = authenticator.assertion(challenge);
        typed.putArray("signature").add("not").add("text");
        assertThat(verifier.verifyAssertion(typed, challenge, ORIGINS, "localhost", authenticator.spki, CoseKey.ES256, false).failed()).isEqualTo("readable");
        ObjectNode object = authenticator.assertion(challenge);
        object.putObject("clientDataJSON");
        assertThat(verifier.verifyAssertion(object, challenge, ORIGINS, "localhost", authenticator.spki, CoseKey.ES256, false).failed()).isEqualTo("readable");
        assertThat(verifier.verifyAssertion(SoftwareAuthenticator.JSON.createArrayNode(), challenge, ORIGINS, "localhost", authenticator.spki, CoseKey.ES256, false).failed()).isEqualTo("readable");
        assertThat(verifier.verifyAssertion(null, challenge, ORIGINS, "localhost", authenticator.spki, CoseKey.ES256, false).failed()).isEqualTo("readable");
        // An algorithm other than ES256 or RS256: the signature check, never an exception.
        assertThat(verifier.verifyAssertion(authenticator.assertion(challenge), challenge, ORIGINS, "localhost", authenticator.spki, -8, false).failed()).isEqualTo("signature");
        // A stored key that is no key at all.
        assertThat(verifier.verifyAssertion(authenticator.assertion(challenge), challenge, ORIGINS, "localhost", new byte[] {1, 2, 3}, CoseKey.ES256, false).failed()).isEqualTo("signature");
        // A stored key off P-256: the signature check too, never asked of the library.
        assertThat(verifier.verifyAssertion(authenticator.assertion(challenge), challenge, ORIGINS, "localhost", offCurveSpki(), CoseKey.ES256, false).failed()).isEqualTo("signature");
        // Client data nested past the depth the verifier reads (8 levels).
        ObjectNode deep = authenticator.assertion(challenge);
        String nested = "{\"type\":\"webauthn.get\",\"challenge\":\"x\",\"origin\":\"http://localhost\",\"d\":[[[[[[[[1]]]]]]]]}";
        deep.put("clientDataJSON", Base64Url.encode(nested.getBytes(StandardCharsets.UTF_8)));
        assertThat(verifier.verifyAssertion(deep, challenge, ORIGINS, "localhost", authenticator.spki, CoseKey.ES256, false).failed()).isEqualTo("readable");
        // Client data with something after the object.
        ObjectNode trailing = authenticator.assertion(challenge);
        trailing.put("clientDataJSON", Base64Url.encode((new String(Base64Url.decode(trailing.get("clientDataJSON").asString()), StandardCharsets.UTF_8) + " {}")
            .getBytes(StandardCharsets.UTF_8)));
        assertThat(verifier.verifyAssertion(trailing, challenge, ORIGINS, "localhost", authenticator.spki, CoseKey.ES256, false).failed()).isEqualTo("readable");
        // The challenge in another spelling of the same bytes (padded): this site handed out the unpadded text.
        ObjectNode padded = authenticator.assertion(challenge, Map.of("clientData", Map.of("challenge", Base64.getUrlEncoder().encodeToString(challenge))));
        WebAuthnVerdict spelled = verifier.verifyAssertion(padded, challenge, ORIGINS, "localhost", authenticator.spki, CoseKey.ES256, false);
        assertThat(spelled.failed()).as("the library takes the padded text; this site does not").isEqualTo("challenge");
        // In the standard alphabet the library cannot read it at all.
        ObjectNode standard = authenticator.assertion(challenge, Map.of("clientData", Map.of("challenge", Base64.getEncoder().withoutPadding().encodeToString(challenge))));
        assertThat(verifier.verifyAssertion(standard, challenge, ORIGINS, "localhost", authenticator.spki, CoseKey.ES256, false).failed()).isIn("readable", "challenge");
    }

    /** An assertion whose authenticator data carries attested credential data, or bytes after its counter, is refused. */
    @Test
    void anAssertionIsNoRegistration() {
        SoftwareAuthenticator authenticator = new SoftwareAuthenticator();
        byte[] challenge = SoftwareAuthenticator.sha256("document");
        // The AT flag with nothing after the counter (the library takes it, as an Apple quirk): unreadable here.
        ObjectNode at = authenticator.assertion(challenge, Map.of("flags", 0x01 | 0x04 | 0x40));
        assertThat(verifier.verifyAssertion(at, challenge, ORIGINS, "localhost", authenticator.spki, CoseKey.ES256, false).failed()).isEqualTo("readable");
        // Bytes after the counter with no AT or ED flag.
        ObjectNode longer = authenticator.assertion(challenge);
        longer.put("authenticatorData", Base64Url.encode(Arrays.copyOf(Base64Url.decode(longer.get("authenticatorData").asString()), 38)));
        assertThat(verifier.verifyAssertion(longer, challenge, ORIGINS, "localhost", authenticator.spki, CoseKey.ES256, false).failed()).isEqualTo("readable");
    }

    /** The library's own rules that this site has no name for: refused as {@value WebAuthnVerifier#LIBRARY_CHECK}. */
    @Test
    void theLibraryRefusesWhatThisSiteHasNoNameFor() {
        SoftwareAuthenticator authenticator = new SoftwareAuthenticator();
        byte[] challenge = SoftwareAuthenticator.random(32);
        ObjectNode response = (ObjectNode) authenticator.register(Base64Url.encode(challenge)).get("response").deepCopy();
        // "none" with a statement: the library refuses it.
        byte[] authData = Base64Url.decode(response.get("authenticatorData").asString());
        Map<Object, Object> attestation = new LinkedHashMap<>();
        attestation.put("fmt", "none");
        Map<Object, Object> statement = new LinkedHashMap<>();
        statement.put("alg", -7L);
        attestation.put("attStmt", statement);
        attestation.put("authData", new TestCbor.Bytes(authData));
        response.put("attestationObject", Base64Url.encode(TestCbor.encode(attestation)));
        WebAuthnVerdict verdict = verifier.verifyRegistration(response, challenge, ORIGINS, "localhost", true, null, null);
        assertThat(verdict.valid()).isFalse();
        assertThat(verdict.failed()).isEqualTo(WebAuthnVerifier.LIBRARY_CHECK);
        assertThat(verdict.reason()).startsWith(WebAuthnVerifier.REASONS.get(WebAuthnVerifier.LIBRARY_CHECK)).endsWith("Exception)");
        assertThat(verdict.credential()).isNull();

        // A backed-up flag without backup eligibility (BS without BE): signed and well formed, the library's flag rule.
        byte[] document = SoftwareAuthenticator.sha256("document");
        ObjectNode backedUp = authenticator.assertion(document, Map.of("flags", 0x01 | 0x04 | 0x10));
        WebAuthnVerdict assertion = verifier.verifyAssertion(backedUp, document, ORIGINS, "localhost", authenticator.spki, CoseKey.ES256, true);
        assertThat(assertion.valid()).isFalse();
        assertThat(assertion.failed()).isEqualTo(WebAuthnVerifier.LIBRARY_CHECK);
        assertThat(assertion.checks().get(WebAuthnVerifier.LIBRARY_CHECK)).isFalse();
        assertThat(assertion.signCount()).isEqualTo(authenticator.counter);

        // Client data the library cannot read (a tokenBinding that is no object): unreadable.
        ObjectNode odd = authenticator.assertion(document, Map.of("clientData", Map.of("tokenBinding", List.of("not", "an", "object"))));
        WebAuthnVerdict malformed = verifier.verifyAssertion(odd, document, ORIGINS, "localhost", authenticator.spki, CoseKey.ES256, true);
        assertThat(malformed.valid()).isFalse();
        assertThat(malformed.failed()).isEqualTo("readable");
    }

    /**
     * An RSA key under 2048 bits is refused at registration even when its modulus is padded with zero bytes to
     * 256: such a key could be stored, then never sign.
     */
    @Test
    void aShortRsaKeyPaddedToLengthIsRefused() throws Exception {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA");
        generator.initialize(1024);
        RSAPublicKey weak = (RSAPublicKey) generator.generateKeyPair().getPublic();
        byte[] modulus = weak.getModulus().toByteArray();
        modulus = modulus[0] == 0 ? Arrays.copyOfRange(modulus, 1, modulus.length) : modulus;
        byte[] padded = new byte[256];
        System.arraycopy(modulus, 0, padded, 256 - modulus.length, modulus.length);
        Map<Object, Object> cose = new LinkedHashMap<>();
        cose.put(1L, 3L);
        cose.put(3L, (long) CoseKey.RS256);
        cose.put(-1L, new TestCbor.Bytes(padded));
        cose.put(-2L, new TestCbor.Bytes(weak.getPublicExponent().toByteArray()));
        assertThat(new BigInteger(1, padded).bitLength()).isLessThan(2048);

        SoftwareAuthenticator authenticator = new SoftwareAuthenticator(CoseKey.RS256);
        byte[] challenge = SoftwareAuthenticator.random(32);
        ObjectNode record = authenticator.register(Base64Url.encode(challenge), Map.of("cose", cose));
        WebAuthnVerdict verdict = verifier.verifyRegistration(record.get("response"), challenge, ORIGINS, "localhost", true, null, null);
        assertThat(verdict.valid()).isFalse();
        assertThat(verdict.failed()).isEqualTo("publicKey");
        assertThat(verdict.credential()).isNull();
    }

    /** The COSE key's refusals through a registration: other algorithms, curves, lengths, short moduli, a point off P-256. */
    @Test
    void coseKeyRefusals() {
        SoftwareAuthenticator es = new SoftwareAuthenticator();
        SoftwareAuthenticator rs = new SoftwareAuthenticator(CoseKey.RS256);
        Map<String, Map<Object, Object>> publicKey = new LinkedHashMap<>();
        Map<Object, Object> curve = new LinkedHashMap<>(es.cose());
        curve.put(-1L, 2L);
        publicKey.put("another curve", curve);
        Map<Object, Object> shortX = new LinkedHashMap<>(es.cose());
        shortX.put(-2L, new TestCbor.Bytes(new byte[31]));
        publicKey.put("a short x", shortX);
        Map<Object, Object> eddsa = new LinkedHashMap<>(es.cose());
        eddsa.put(3L, -8L);
        publicKey.put("EdDSA on an EC2 key", eddsa);
        Map<Object, Object> rsaUnderEs = new LinkedHashMap<>(rs.cose());
        rsaUnderEs.put(3L, (long) CoseKey.ES256);
        publicKey.put("an RSA key labelled ES256", rsaUnderEs);
        Map<Object, Object> small = new LinkedHashMap<>(rs.cose());
        small.put(-1L, new TestCbor.Bytes(new byte[255]));
        publicKey.put("a modulus of 255 zero bytes", small);
        Map<Object, Object> noExponent = new LinkedHashMap<>(rs.cose());
        noExponent.put(-2L, new TestCbor.Bytes(new byte[0]));
        publicKey.put("no exponent", noExponent);
        Map<Object, Object> offCurve = new LinkedHashMap<>(es.cose());
        offCurve.put(-3L, new TestCbor.Bytes(new byte[32]));
        publicKey.put("a point off P-256", offCurve);
        Map<Object, Object> unknownAlgorithm = new LinkedHashMap<>(es.cose());
        unknownAlgorithm.put(3L, -9999L);
        publicKey.put("an algorithm nobody names", unknownAlgorithm);
        byte[] challenge = SoftwareAuthenticator.random(32);
        publicKey.forEach((name, cose) -> {
            SoftwareAuthenticator authenticator = cose.get(1L).equals(3L) ? rs : es;
            WebAuthnVerdict verdict = verifier.verifyRegistration(authenticator.register(Base64Url.encode(challenge), Map.of("cose", cose)).get("response"),
                challenge, ORIGINS, "localhost", false, null, null);
            assertThat(verdict.valid()).as(name).isFalse();
            assertThat(verdict.failed()).as(name).isEqualTo("publicKey");
            assertThat(verdict.credential()).as(name).isNull();
        });
        // A CBOR list where the COSE map belongs: unreadable.
        WebAuthnVerdict list = verifier.verifyRegistration(es.register(Base64Url.encode(challenge), Map.of("cose", List.of(2L, -7L))).get("response"),
            challenge, ORIGINS, "localhost", false, null, null);
        assertThat(list.failed()).isEqualTo("readable");
        // A key type the library does not know: unreadable too.
        Map<Object, Object> unknownType = new LinkedHashMap<>(es.cose());
        unknownType.put(1L, 99L);
        assertThat(verifier.verifyRegistration(es.register(Base64Url.encode(challenge), Map.of("cose", unknownType)).get("response"),
            challenge, ORIGINS, "localhost", false, null, null).failed()).isEqualTo("readable");
        // The key reader itself: SPKIs this site takes and one off the curve, which the JCA alone would read.
        assertThat(CoseKey.readable(es.spki)).isTrue();
        assertThat(CoseKey.readable(rs.spki)).isTrue();
        assertThat(CoseKey.readable(offCurveSpki())).isFalse();
        assertThat(CoseKey.readable(new byte[] {1, 2, 3})).isFalse();
        assertThat(CoseKey.toCose(es.spki, CoseKey.RS256)).isNull();
        assertThat(CoseKey.toCose(rs.spki, CoseKey.ES256)).isNull();
    }

    /** The pre-gate in front of the library refuses what it refused before the library ever read CBOR. */
    @Test
    void malformedCborNeverReachesTheLibrary() {
        SoftwareAuthenticator authenticator = new SoftwareAuthenticator();
        byte[] challenge = SoftwareAuthenticator.random(32);
        ObjectNode response = (ObjectNode) authenticator.register(Base64Url.encode(challenge)).get("response");
        byte[] authData = Base64Url.decode(response.get("authenticatorData").asString());
        byte[] good = Base64Url.decode(response.get("attestationObject").asString());
        // The attestation object: a repeated key, a float, an indefinite map, bytes after it.
        Map<String, byte[]> objects = new LinkedHashMap<>();
        objects.put("a repeated key", concat(HexFormat.of().parseHex("a4"), TestCbor.encode("fmt"), TestCbor.encode("none"),
            TestCbor.encode("fmt"), TestCbor.encode("packed"), TestCbor.encode("attStmt"), TestCbor.encode(Map.of()), TestCbor.encode("authData"),
            TestCbor.encode(new TestCbor.Bytes(authData))));
        objects.put("a float", concat(HexFormat.of().parseHex("a4"), TestCbor.encode("fmt"), TestCbor.encode("none"),
            TestCbor.encode("attStmt"), TestCbor.encode(Map.of()), TestCbor.encode("x"), HexFormat.of().parseHex("f93c00"),
            TestCbor.encode("authData"), TestCbor.encode(new TestCbor.Bytes(authData))));
        objects.put("an indefinite map", concat(HexFormat.of().parseHex("bf"), TestCbor.encode("fmt"), TestCbor.encode("none"),
            TestCbor.encode("attStmt"), TestCbor.encode(Map.of()), TestCbor.encode("authData"), TestCbor.encode(new TestCbor.Bytes(authData)),
            HexFormat.of().parseHex("ff")));
        objects.put("bytes after it", concat(good, new byte[] {0}));
        objects.forEach((name, bytes) -> {
            ObjectNode copy = response.deepCopy();
            copy.put("attestationObject", Base64Url.encode(bytes));
            copy.remove("authenticatorData");
            assertThat(verifier.verifyRegistration(copy, challenge, ORIGINS, "localhost", false, null, null).failed()).as(name).isEqualTo("readable");
        });
        // The COSE key in the authenticator data: a repeated key (an integer key twice).
        Map<Object, Object> repeated = new LinkedHashMap<>(authenticator.cose());
        byte[] cose = TestCbor.encode(repeated);
        cose[0] = (byte) (cose[0] + 1);
        byte[] twice = concat(cose, TestCbor.encode(3L), TestCbor.encode((long) CoseKey.ES256));
        ObjectNode duplicated = (ObjectNode) authenticator.register(Base64Url.encode(challenge), Map.of("cose", new TestCbor.Raw(twice))).get("response");
        assertThat(verifier.verifyRegistration(duplicated, challenge, ORIGINS, "localhost", false, null, null).failed()).isEqualTo("readable");
        // The COSE key with another key's x and y under the text labels "-2" and "-3": the library names an integer key
        // by its digits and keeps the last, so it would read the other key. Refused, with the reported key either one.
        SoftwareAuthenticator other = new SoftwareAuthenticator();
        Map<Object, Object> folded = new LinkedHashMap<>(authenticator.cose());
        folded.put("-2", other.cose().get(-2L));
        folded.put("-3", other.cose().get(-3L));
        ObjectNode spliced = (ObjectNode) authenticator.register(Base64Url.encode(challenge), Map.of("cose", folded)).get("response");
        for (byte[] reported : Arrays.asList(null, authenticator.spki, other.spki)) {
            WebAuthnVerdict verdict = verifier.verifyRegistration(spliced, challenge, ORIGINS, "localhost", false, null, reported);
            assertThat(verdict.failed()).isEqualTo("readable");
            assertThat(verdict.credential()).isNull();
        }
        // A COSE key written with text labels only: the old reader found no key type and refused it; refused here too.
        Map<Object, Object> textLabels = new LinkedHashMap<>();
        authenticator.cose().forEach((label, value) -> textLabels.put(String.valueOf(label), value));
        assertThat(verifier.verifyRegistration(authenticator.register(Base64Url.encode(challenge), Map.of("cose", textLabels)).get("response"),
            challenge, ORIGINS, "localhost", false, null, null).failed()).isEqualTo("readable");
    }

    /** The authenticator data layout: lengths, the credential id's bounds, the CBOR after it, nothing after that. */
    @Test
    void authenticatorDataLayout() {
        assertThat(WebAuthnVerifier.laidOut(new byte[36])).isFalse();
        byte[] at = new byte[54];
        at[32] = 0x41;
        assertThat(WebAuthnVerifier.laidOut(at)).isFalse();
        byte[] zeroLength = new byte[60];
        zeroLength[32] = 0x41;
        assertThat(WebAuthnVerifier.laidOut(zeroLength)).as("a credential id of 0 bytes").isFalse();
        byte[] tooLong = new byte[2000];
        tooLong[32] = 0x41;
        tooLong[53] = 0x04;
        tooLong[54] = 0x00;
        assertThat(WebAuthnVerifier.laidOut(tooLong)).as("a credential id of 1024 bytes").isFalse();
        byte[] plain = new byte[37];
        plain[32] = 0x05;
        assertThat(WebAuthnVerifier.laidOut(plain)).isTrue();
        assertThat(WebAuthnVerifier.laidOut(Arrays.copyOf(plain, 38))).as("a byte after the counter").isFalse();
        // ED: an extensions map after the counter, and nothing else.
        byte[] extensions = concat(plain, TestCbor.encode(Map.of("credProtect", 1L)));
        extensions[32] = (byte) 0x85;
        assertThat(WebAuthnVerifier.laidOut(extensions)).isTrue();
        byte[] noExtensions = plain.clone();
        noExtensions[32] = (byte) 0x85;
        assertThat(WebAuthnVerifier.laidOut(noExtensions)).as("ED with no extensions").isFalse();
        byte[] listExtensions = concat(plain, TestCbor.encode(List.of(1L)));
        listExtensions[32] = (byte) 0x85;
        assertThat(WebAuthnVerifier.laidOut(listExtensions)).as("extensions that are no map").isFalse();
        // A credential id of 1023 bytes is the longest taken.
        SoftwareAuthenticator authenticator = new SoftwareAuthenticator();
        authenticator.credentialId = SoftwareAuthenticator.random(1023);
        byte[] challenge = SoftwareAuthenticator.random(32);
        assertThat(verifier.verifyRegistration(authenticator.register(Base64Url.encode(challenge)).get("response"), challenge, ORIGINS, "localhost",
            false, null, null).valid()).isTrue();
        authenticator.credentialId = SoftwareAuthenticator.random(1024);
        assertThat(verifier.verifyRegistration(authenticator.register(Base64Url.encode(challenge)).get("response"), challenge, ORIGINS, "localhost",
            false, null, null).failed()).isEqualTo("readable");
    }

    /** Base64url both ways on the JDK codec; the standard alphabet is refused. */
    @Test
    void base64Url() {
        byte[] bytes = {(byte) 0xfb, (byte) 0xff, (byte) 0xfe};
        assertThat(Base64Url.encode(bytes)).isEqualTo("-__-");
        assertThat(Base64Url.decode("-__-")).isEqualTo(bytes);
        assertThat(Base64Url.decode("+//+")).isNull();
        assertThat(Base64Url.decode("not base64!")).isNull();
        assertThat(Base64Url.decode("")).isEmpty();
        assertThat(Base64Url.decode("YQ==")).isEqualTo("a".getBytes(StandardCharsets.US_ASCII));
        assertThat(Base64Url.decode("YQ")).isEqualTo("a".getBytes(StandardCharsets.US_ASCII));
        assertThat(Base64Url.decode("Y")).isNull();
    }

    /** A P-256 SPKI whose point is (x, 0): not on the curve. */
    static byte[] offCurveSpki() {
        byte[] x = ((TestCbor.Bytes) new SoftwareAuthenticator().cose().get(-2L)).bytes();
        return concat(HexFormat.of().parseHex("3059301306072a8648ce3d020106082a8648ce3d03010703420004"), x, new byte[32]);
    }

    static byte[] concat(byte[]... parts) {
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        for (byte[] part : parts) {
            out.writeBytes(part);
        }
        return out.toByteArray();
    }
}
