package com.argusvane.datum.webauthn;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

/**
 * The checks against passkeys and signatures the engine itself made: the engine to Java conformance gate.
 *
 * <p>The fixture ({@code integrations/shared/fixtures/webauthn-engine.json}, written by
 * {@code integrations/shared/scripts/canonical-fixtures.ts} and copied into {@code datum-fixtures/} by the asset build)
 * holds the engine's
 * {@code registerCredential()} with a server challenge and user handle, then its
 * discoverable signing provider over the RFC 8785 text of a submission, with and without a signing
 * statement, for an ES256 and an RS256 key. The host must accept each registration and rebuild each
 * signed text byte for byte.
 */
class EngineWebAuthnFixtureTest {

    private static final JsonMapper JSON = JsonMapper.builder().build();
    private final WebAuthnVerifier verifier = new WebAuthnVerifier();

    static JsonNode fixture() {
        try (InputStream in = EngineWebAuthnFixtureTest.class.getResourceAsStream("/datum-fixtures/webauthn-engine.json")) {
            assertThat(in).as("Run npm run jvm:assets: datum-fixtures/webauthn-engine.json is missing.").isNotNull();
            return JSON.readTree(in);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    static Stream<Arguments> credentials() {
        List<Arguments> cases = new ArrayList<>();
        for (JsonNode credential : fixture().get("credentials")) {
            cases.add(Arguments.of("COSE " + credential.get("algorithm").asInt(), credential));
        }
        return cases.stream();
    }

    static Stream<Arguments> documents() {
        List<Arguments> cases = new ArrayList<>();
        for (JsonNode credential : fixture().get("credentials")) {
            for (JsonNode document : credential.get("documents")) {
                cases.add(Arguments.of("COSE " + credential.get("algorithm").asInt() + ": " + document.get("name").asString(), credential, document));
            }
        }
        return cases.stream();
    }

    private static String statementOf(JsonNode document) {
        JsonNode statement = document.get("statement");
        return statement == null || statement.isNull() ? null : statement.asString();
    }

    /** The engine's registration passes every check, and yields its key. */
    @ParameterizedTest(name = "{0}")
    @MethodSource("credentials")
    void registration(String name, JsonNode credential) {
        JsonNode fixture = fixture();
        JsonNode registration = credential.get("registration");
        assertThat(registration.get("userHandle").asString()).as("The handle the server handed out comes back.").isEqualTo(fixture.get("userHandle").asString());
        byte[] challenge = Base64Url.decode(fixture.get("challenge").asString());
        List<String> origins = List.of(fixture.get("origin").asString());
        String rpId = fixture.get("rpId").asString();
        byte[] spki = Base64.getDecoder().decode(registration.get("publicKey").asString());
        WebAuthnVerdict verdict = verifier.verifyRegistration(registration.get("response"), challenge, origins, rpId, false,
            Base64Url.decode(registration.get("id").asString()), spki);
        assertThat(verdict.valid()).as(String.valueOf(verdict.reason())).isTrue();
        assertThat(verdict.credential().credentialId()).isEqualTo(Base64Url.decode(registration.get("id").asString()));
        assertThat(verdict.credential().spki()).as("The key in the authenticator data is the one getPublicKey() gave.").isEqualTo(spki);
        assertThat(verdict.credential().algorithm()).isEqualTo(credential.get("algorithm").asInt());
        assertThat(verdict.credential().attestationFormat()).isEqualTo("none");

        // Another challenge, or another relying party, fails.
        assertThat(verifier.verifyRegistration(registration.get("response"), SoftwareAuthenticator.random(32), origins, rpId, false, null, null).valid()).isFalse();
        assertThat(verifier.verifyRegistration(registration.get("response"), challenge, origins, "example.org", false, null, null).valid()).isFalse();
    }

    /** The host rebuilds the engine's signed text, and the signature verifies. */
    @ParameterizedTest(name = "{0}")
    @MethodSource("documents")
    void signedDocument(String name, JsonNode credential, JsonNode document) {
        JsonNode fixture = fixture();
        JsonNode delivered = document.get("document");
        JsonNode signature = delivered.get("signatures").get(0);
        String scope = document.get("scope").asString();
        String statement = statementOf(document);
        assertThat(signature.get("format").get("canonicalization").asString()).isEqualTo("jcs");
        assertThat(signature.get("format").get("scope").asString()).isEqualTo(scope);
        JsonNode signedStatement = signature.get("statement");
        assertThat(signedStatement == null ? null : signedStatement.asString()).as("The engine records the statement it signed.").isEqualTo(statement);
        assertThat(signature.get("webauthn").get("userHandle").asString()).isEqualTo(fixture.get("userHandle").asString());
        assertThat(signature.get("webauthn").get("credentialId").asString()).isEqualTo(credential.get("registration").get("id").asString());

        String text = SignedText.text(delivered, scope, statement);
        assertThat(text).as("Byte for byte the text the engine signed.").isEqualTo(document.get("canonical").asString());
        List<String> origins = List.of(fixture.get("origin").asString());
        String rpId = fixture.get("rpId").asString();
        byte[] spki = Base64.getDecoder().decode(credential.get("registration").get("publicKey").asString());
        // The algorithm is the registration's (the stored key's), never the document's: the RS256 documents
        // carry webauthn.algorithm -7.
        int algorithm = credential.get("registration").get("algorithm").asInt();
        WebAuthnVerdict verdict = verifier.verifyAssertion(signature.get("webauthn"), SignedText.digest(text), origins, rpId, spki, algorithm, false);
        assertThat(verdict.valid()).as(String.valueOf(verdict.reason())).isTrue();

        // Without the statement, or with an answer changed, it does not verify.
        ObjectNode changed = (ObjectNode) delivered.deepCopy();
        ((ObjectNode) changed.get("submission").get("values")).put("fullName", "Someone else");
        for (String other : List.of(
            SignedText.text(delivered, scope, statement == null ? "A statement." : null),
            SignedText.text(changed, scope, statement))) {
            assertThat(verifier.verifyAssertion(signature.get("webauthn"), SignedText.digest(other), origins, rpId, spki, algorithm, false).valid()).isFalse();
        }
    }

    /**
     * The whole fixture through the submission verifier, in signing order: each document valid against the
     * stored passkey, its use recorded (the counter rises 1, 2, 3), and each one sent again refused as a replay.
     */
    @Test
    void theFixtureThroughTheSubmissionVerifier() {
        JsonNode fixture = fixture();
        for (JsonNode credential : fixture.get("credentials")) {
            JsonNode registration = credential.get("registration");
            WebAuthnVerdict registered = verifier.verifyRegistration(registration.get("response"), Base64Url.decode(fixture.get("challenge").asString()),
                List.of(fixture.get("origin").asString()), fixture.get("rpId").asString(), false, null, null);
            assertThat(registered.valid()).isTrue();
            InMemoryPasskeyRepository passkeys = new InMemoryPasskeyRepository();
            InMemoryPasskeyUseStore uses = new InMemoryPasskeyUseStore(passkeys);
            PasskeyRecord passkey = passkeys.create(PasskeyRecord.builder()
                .credentialId(registration.get("id").asString())
                .publicKey(registered.credential().spki())
                .algorithm(registered.credential().algorithm())
                .userHandle(fixture.get("userHandle").asString())
                .signCount(registered.signCount())
                .created(Instant.EPOCH)
                .build());
            WebAuthnSettings site = new WebAuthnSettings(fixture.get("rpId").asString(), "Petition", List.of(fixture.get("origin").asString()), null, true, false, null, null, null, null);
            for (JsonNode document : credential.get("documents")) {
                JsonNode delivered = document.get("document");
                String signedAt = delivered.get("signatures").get(0).get("webauthn").get("signedAt").asString();
                Clock clock = Clock.fixed(Instant.parse(signedAt), ZoneOffset.UTC);
                SubmissionSignatureVerifier signatures = new SubmissionSignatureVerifier(site, passkeys, uses, verifier, clock, List.of());
                FormSigning form = FormSigning.builder().mode(FormSigning.Mode.REQUIRED).scope(document.get("scope").asString())
                    .statement(statementOf(document) == null ? "" : statementOf(document)).build();
                SignatureVerification verification = signatures.verify("petition", form, delivered, (ObjectNode) delivered, PasskeySubject.anonymous());
                assertThat(verification.status()).as(document.get("name").asString() + ": " + verification.reason()).isEqualTo(SignatureVerification.Status.VALID);
                assertThat(verification.passkey().id()).isEqualTo(passkey.id());
                assertThat(signatures.recordUse(verification, "SUB-" + document.get("name").asString())).isNotNull();
                SignatureVerification again = signatures.verify("petition", form, delivered, (ObjectNode) delivered, PasskeySubject.anonymous());
                assertThat(again.code()).isEqualTo("replay");
            }
            assertThat(passkeys.find(registration.get("id").asString()).orElseThrow().signCount()).isEqualTo(credential.get("documents").size());
        }
    }
}
