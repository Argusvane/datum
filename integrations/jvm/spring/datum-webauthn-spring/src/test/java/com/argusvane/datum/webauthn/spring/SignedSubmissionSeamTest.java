package com.argusvane.datum.webauthn.spring;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.core.DatumException;
import com.argusvane.datum.submissions.spi.AcceptedSubmission;
import com.argusvane.datum.submissions.spi.CandidateSubmission;
import com.argusvane.datum.submissions.spi.SignatureVerdict;
import com.argusvane.datum.submissions.spi.SubmissionMode;
import com.argusvane.datum.submissions.spi.SubmissionRequest;
import com.argusvane.datum.submissions.spi.SubmissionReceipt;
import com.argusvane.datum.submissions.spi.SubmissionSignatureCheck;
import com.argusvane.datum.submissions.spi.ValidationScope;
import com.argusvane.datum.webauthn.PasskeyContext;
import com.argusvane.datum.webauthn.PasskeyRecord;
import com.argusvane.datum.webauthn.PasskeyRepository;
import com.argusvane.datum.webauthn.PasskeySubject;
import com.argusvane.datum.webauthn.RegistrationCeremony;
import com.argusvane.datum.webauthn.RegistrationOptions;
import com.argusvane.datum.webauthn.WebAuthnTestKit.Authenticator;
import com.argusvane.datum.webauthn.WebAuthnTestKit;
import com.argusvane.datum.webauthn.events.SubmissionSignatureVerifiedEvent;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.assertj.AssertableApplicationContext;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.ApplicationListener;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.jdbc.datasource.init.ResourceDatabasePopulator;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

/**
 * The receiver's signature seam as the application gets it: the {@code SubmissionSignatureCheck} bean over the SQL
 * stores (H2 and the shipped migration), a passkey registered through the ceremony, a signed submission accepted,
 * its replay refused, a revoked passkey refused, and a required form with no signature refused or accepted by its
 * {@code unavailable} policy.
 */
class SignedSubmissionSeamTest {

    private static final String CONFIRM = "I confirm these answers.";
    private static final JsonMapper JSON = JsonMapper.builder().build();

    private final List<Object> events = new ArrayList<>();

    private ApplicationContextRunner site(String... more) {
        DriverManagerDataSource source = new DriverManagerDataSource("jdbc:h2:mem:" + UUID.randomUUID() + ";DB_CLOSE_DELAY=-1", "sa", "");
        new ResourceDatabasePopulator(new ClassPathResource("META-INF/datum/db/migration/h2/V400__datum_webauthn.sql")).execute(source);
        return new ApplicationContextRunner()
            .withConfiguration(AutoConfigurations.of(DatumWebAuthnAutoConfiguration.class))
            .withBean(javax.sql.DataSource.class, () -> source)
            .withBean(ApplicationListener.class, () -> (ApplicationListener<org.springframework.context.PayloadApplicationEvent<?>>) event ->
                events.add(event.getPayload()))
            .withPropertyValues("datum.webauthn.enabled=true", "datum.webauthn.rp-id=localhost", "datum.webauthn.origins=http://localhost",
                "datum.webauthn.anonymous=true", "datum.webauthn.secret=a configured secret of at least 32 bytes!",
                "datum.webauthn.forms.petition.mode=required", "datum.webauthn.forms.petition.statement=" + CONFIRM)
            .withPropertyValues(more);
    }

    private static PasskeyRecord register(AssertableApplicationContext context, Authenticator authenticator) {
        RegistrationCeremony ceremony = context.getBean(RegistrationCeremony.class);
        PasskeySubject visitor = PasskeySubject.anonymous();
        PasskeyContext made = PasskeyContext.forForm("petition", visitor, "submit", false,
            context.getBean(com.argusvane.datum.webauthn.FormSigningSource.class).forForm("petition"), "Petition signer");
        RegistrationOptions options = ceremony.challenge(made, visitor, "Ada");
        ObjectNode asked = JSON.createObjectNode();
        asked.put("challenge", options.challenge());
        asked.putObject("user").put("id", options.user().id());
        ObjectNode posted = JSON.createObjectNode();
        posted.put("token", options.token());
        posted.set("credential", authenticator.credentialFor(asked));
        return ceremony.register(made, visitor, posted, "Chrome on macOS");
    }

    private static CandidateSubmission candidate(ObjectNode document, SubmissionMode mode, Map<String, List<String>> headers) {
        ObjectNode envelope = document.has("payload") ? (ObjectNode) document.get("payload") : document;
        ObjectNode definition = JsonNodeFactory.instance.objectNode().put("id", "petition");
        ObjectNode values = envelope.has("submission") ? (ObjectNode) envelope.get("submission").get("values") : JsonNodeFactory.instance.objectNode();
        return new CandidateSubmission("petition", mode, definition, "0".repeat(64), document.deepCopy(), envelope.deepCopy(), values, "en",
            new ValidationScope("submission", null, null, null, mode == SubmissionMode.TEST), JsonNodeFactory.instance.objectNode(),
            new SubmissionRequest("application/json", headers, null, null).toContext(null));
    }

    private static CandidateSubmission candidate(ObjectNode document) {
        return candidate(document, SubmissionMode.SUBMIT, Map.of());
    }

    private static AcceptedSubmission accepted(SignatureVerdict verdict) {
        return new AcceptedSubmission("petition", "0".repeat(64), "0".repeat(64), "{}", JsonNodeFactory.instance.objectNode(), List.of(),
            JsonNodeFactory.instance.arrayNode(), List.of(), List.of(), List.of(), List.of(), null, null, verdict, "en", null,
            JsonNodeFactory.instance.arrayNode(), null, "http", "attempt-1");
    }

    private static final SubmissionReceipt RECEIPT = new SubmissionReceipt("id-1", "PETITION-1", null);

    private static String code(SignatureVerdict verdict) {
        return verdict.refusalErrors().isEmpty() ? null : verdict.refusalErrors().get(0).code();
    }

    private static ObjectNode signed(Authenticator authenticator, String name) {
        return authenticator.sign("petition", Map.of("fullName", name), Map.of("statement", CONFIRM));
    }

    @Test
    void aSignedSubmissionIsAcceptedItsUseIsRecordedAndTheEventIsPublished() {
        site().run(context -> {
            assertThat(context).hasNotFailed();
            SubmissionSignatureCheck check = context.getBean(SubmissionSignatureCheck.class);
            Authenticator authenticator = new Authenticator();
            PasskeyRecord passkey = register(context, authenticator);

            SignatureVerdict verdict = check.check(candidate(signed(authenticator, "Ada")));

            assertThat(verdict.status()).isEqualTo(SignatureVerdict.Status.VALID);
            assertThat(verdict.refuses()).isFalse();
            assertThat(verdict.details()).containsEntry("status", "valid").containsEntry("credentialId", passkey.credentialId());
            assertThat(events).as("a valid signature is published once the document is stored, not when it is judged").isEmpty();

            check.recordUse(accepted(verdict));

            assertThat(events).as("nor when its use is recorded: the handler may still fail").isEmpty();

            check.stored(accepted(verdict), RECEIPT);

            assertThat(events).hasSize(1);
            SubmissionSignatureVerifiedEvent event = (SubmissionSignatureVerifiedEvent) events.get(0);
            assertThat(event.formKey()).isEqualTo("petition");
            assertThat(event.status()).isEqualTo("valid");
            assertThat(event.credentialId()).isEqualTo(passkey.credentialId());
            assertThat(event.checks()).containsEntry("signature", true).containsEntry("origin", true).containsEntry("rpId", true);
            PasskeyRecord after = context.getBean(PasskeyRepository.class).find(passkey.credentialId()).orElseThrow();
            assertThat(after.signCount()).isEqualTo(authenticator.counter());
            assertThat(after.lastUsed()).isNotNull();
        });
    }

    /** The application's signature-check hooks as beans: a stricter check, and a refusal that propagates. */
    @org.springframework.context.annotation.Configuration(proxyBeanMethods = false)
    static class SignaturePolicy {

        static final java.util.Set<String> BLOCKED = java.util.concurrent.ConcurrentHashMap.newKeySet();

        @org.springframework.context.annotation.Bean
        com.argusvane.datum.webauthn.SignatureCheckCustomizer verifiedSigners() {
            return draft -> {
                draft.userVerificationRequired(true);
                if (BLOCKED.contains(draft.passkey().credentialId())) {
                    throw com.argusvane.datum.core.hooks.HookRefusedException.forbidden("signature.policy", "This passkey may not sign here.");
                }
            };
        }
    }

    @Test
    void theApplicationsSignatureCheckHookChecksMoreStrictlyOrRefuses() {
        site().withUserConfiguration(SignaturePolicy.class).run(context -> {
            assertThat(context).hasNotFailed();
            SubmissionSignatureCheck check = context.getBean(SubmissionSignatureCheck.class);
            Authenticator authenticator = new Authenticator();
            PasskeyRecord passkey = register(context, authenticator);
            SignatureVerdict unverified = check.check(candidate(authenticator.sign("petition", Map.of("fullName", "Ada"),
                Map.of("statement", CONFIRM, "uv", false))));
            assertThat(unverified.refuses()).isTrue();
            assertThat(code(unverified)).isEqualTo("signature.invalid");
            assertThat(unverified.details()).containsEntry("code", "userVerified");
            assertThat(check.check(candidate(signed(authenticator, "Bo"))).status()).isEqualTo(SignatureVerdict.Status.VALID);

            SignaturePolicy.BLOCKED.add(passkey.credentialId());
            try {
                org.assertj.core.api.Assertions.assertThatThrownBy(() -> check.check(candidate(signed(authenticator, "Cy"))))
                    .isInstanceOfSatisfying(com.argusvane.datum.core.hooks.HookRefusedException.class, refused -> {
                        assertThat(refused.code()).isEqualTo("signature.policy");
                        assertThat(refused.httpStatus()).isEqualTo(403);
                    });
            } finally {
                SignaturePolicy.BLOCKED.clear();
            }
            assertThat(context.getBean(PasskeyRepository.class).find(passkey.credentialId()).orElseThrow().lastUsed()).as("nothing recorded").isNull();
        });
    }

    @Test
    void theSameSignedDocumentIsRefusedTheSecondTime() {
        site().run(context -> {
            SubmissionSignatureCheck check = context.getBean(SubmissionSignatureCheck.class);
            Authenticator authenticator = new Authenticator();
            register(context, authenticator);
            ObjectNode body = signed(authenticator, "Ada");
            SignatureVerdict first = check.check(candidate(body));
            check.recordUse(accepted(first));
            check.stored(accepted(first), RECEIPT);

            SignatureVerdict again = check.check(candidate(body));

            assertThat(again.refuses()).isTrue();
            assertThat(code(again)).isEqualTo("signature.invalid");
            assertThat(events).extracting(e -> ((SubmissionSignatureVerifiedEvent) e).status()).containsExactly("valid", "invalid");
            assertThat(again.refusalErrors().get(0).message()).startsWith("This signed submission was already received.");
        });
    }

    @Test
    void twoDeliveriesThatBothPassedTheCheckClaimItOnce() {
        site().run(context -> {
            SubmissionSignatureCheck check = context.getBean(SubmissionSignatureCheck.class);
            Authenticator authenticator = new Authenticator();
            register(context, authenticator);
            ObjectNode body = signed(authenticator, "Ada");
            SignatureVerdict first = check.check(candidate(body));
            SignatureVerdict second = check.check(candidate(body));
            check.recordUse(accepted(first));

            DatumException replay = thrown(() -> check.recordUse(accepted(second)));

            assertThat(replay.httpStatus()).isEqualTo(422);
            assertThat(replay.code()).isEqualTo("signature.invalid");
            assertThat(events).as("the delivery that lost the claim is invalid at once").extracting(e -> ((SubmissionSignatureVerifiedEvent) e).status())
                .containsExactly("invalid");

            check.stored(accepted(first), RECEIPT);

            assertThat(events).as("the one that won it is valid once it is stored").extracting(e -> ((SubmissionSignatureVerifiedEvent) e).status())
                .containsExactly("invalid", "valid");
        });
    }

    /**
     * A handler that fails after the use was recorded has the use released, and the signature
     * is never published as valid for a document that was not stored; the client's retry that is stored publishes it once.
     */
    @Test
    void aUseReleasedAfterAFailedStorePublishesNothingAndTheStoredRetryOnce() {
        site().run(context -> {
            SubmissionSignatureCheck check = context.getBean(SubmissionSignatureCheck.class);
            Authenticator authenticator = new Authenticator();
            register(context, authenticator);
            ObjectNode body = signed(authenticator, "Ada");
            SignatureVerdict first = check.check(candidate(body));
            check.recordUse(accepted(first));

            check.releaseUse(accepted(first));

            assertThat(events).isEmpty();

            SignatureVerdict retry = check.check(candidate(body));
            check.recordUse(accepted(retry));
            check.stored(accepted(retry), RECEIPT);

            assertThat(events).extracting(e -> ((SubmissionSignatureVerifiedEvent) e).status()).containsExactly("valid");
        });
    }

    /** A delivery with no signature (an optional form sent unsigned) is never published, stored or not. */
    @Test
    void aStoredDeliveryWithoutASignaturePublishesNothing() {
        site().run(context -> {
            SubmissionSignatureCheck check = context.getBean(SubmissionSignatureCheck.class);
            check.stored(accepted(null), RECEIPT);
            assertThat(events).isEmpty();
        });
    }

    @Test
    void aRevokedUseAtTheStoreIsPublishedAsInvalidNotValid() {
        site().run(context -> {
            SubmissionSignatureCheck check = context.getBean(SubmissionSignatureCheck.class);
            Authenticator authenticator = new Authenticator();
            PasskeyRecord passkey = register(context, authenticator);
            SignatureVerdict pending = check.check(candidate(signed(authenticator, "Ada")));
            context.getBean(PasskeyRepository.class).revoke(passkey.id(), "admin", Instant.now());

            thrown(() -> check.recordUse(accepted(pending)));

            assertThat(events).extracting(e -> ((SubmissionSignatureVerifiedEvent) e).status()).containsExactly("invalid");
        });
    }

    @Test
    void aSignatureRefusedAsStaleIsPublishedAsInvalid() {
        site().run(context -> {
            SubmissionSignatureCheck check = context.getBean(SubmissionSignatureCheck.class);
            Authenticator authenticator = new Authenticator();
            register(context, authenticator);

            DatumException stale = thrown(() -> check.check(candidate(authenticator.sign("petition", Map.of("fullName", "Bo"),
                Map.of("statement", "Something else.")))));

            assertThat(stale.code()).isEqualTo("signature.stale");
            assertThat(events).extracting(e -> ((SubmissionSignatureVerifiedEvent) e).status()).containsExactly("invalid");
        });
    }

    /** A PDF request is a dry run like a test: a stale signature is the verdict's error in the report, not a thrown 409. */
    @Test
    void aStaleSignatureInAPdfRequestIsReportedNotThrown() {
        site().run(context -> {
            SubmissionSignatureCheck check = context.getBean(SubmissionSignatureCheck.class);
            Authenticator authenticator = new Authenticator();
            register(context, authenticator);
            ObjectNode stale = authenticator.sign("petition", Map.of("fullName", "Bo"), Map.of("statement", "Something else."));

            for (SubmissionMode mode : new SubmissionMode[] {SubmissionMode.TEST, SubmissionMode.PDF}) {
                SignatureVerdict verdict = check.check(candidate(stale, mode, Map.of()));
                assertThat(verdict.errors()).extracting(error -> error.code()).as(mode.name()).containsExactly("signature.stale");
            }
            assertThat(events).as("a dry run publishes nothing").isEmpty();
        });
    }

    @Test
    void aSubmissionTheHandlerDidNotStoreCanBeSentAgain() {
        site().run(context -> {
            SubmissionSignatureCheck check = context.getBean(SubmissionSignatureCheck.class);
            Authenticator authenticator = new Authenticator();
            PasskeyRecord passkey = register(context, authenticator);
            ObjectNode body = signed(authenticator, "Ada");
            SignatureVerdict first = check.check(candidate(body));
            check.recordUse(accepted(first));

            check.releaseUse(accepted(first));

            assertThat(context.getBean(PasskeyRepository.class).find(passkey.credentialId()).orElseThrow().signCount()).isEqualTo(passkey.signCount());
            SignatureVerdict again = check.check(candidate(body));
            assertThat(again.status()).isEqualTo(SignatureVerdict.Status.VALID);
            check.recordUse(accepted(again));
        });
    }

    @Test
    void aRevokedPasskeyIsRefusedAtTheCheckAndAtTheStore() {
        site().run(context -> {
            SubmissionSignatureCheck check = context.getBean(SubmissionSignatureCheck.class);
            PasskeyRepository passkeys = context.getBean(PasskeyRepository.class);
            Authenticator authenticator = new Authenticator();
            PasskeyRecord passkey = register(context, authenticator);
            SignatureVerdict pending = check.check(candidate(signed(authenticator, "Ada")));

            passkeys.revoke(passkey.id(), "admin", Instant.now());

            assertThat(thrown(() -> check.recordUse(accepted(pending))).code()).as("revoked between the check and the store").isEqualTo("signature.unusable");
            SignatureVerdict later = check.check(candidate(signed(authenticator, "Bo")));
            assertThat(later.refuses()).isTrue();
            assertThat(code(later)).isEqualTo("signature.unusable");
        });
    }

    @Test
    void aRequiredFormWithNoSignatureIsRefusedUnlessTheBrowserHasNoPasskeysAndTheFormAccepts() {
        Map<String, List<String>> header = Map.of("X-Datum-Signing", List.of("unavailable"));
        site().run(context -> {
            SubmissionSignatureCheck check = context.getBean(SubmissionSignatureCheck.class);
            ObjectNode unsigned = WebAuthnTestKit.envelope("petition", Map.of("fullName", "Eve"));

            assertThat(code(check.check(candidate(unsigned)))).isEqualTo("signature.required");
            assertThat(code(check.check(candidate(unsigned, SubmissionMode.SUBMIT, header)))).as("refuse is the default policy").isEqualTo("signature.required");
            assertThat(events).as("nothing was judged").isEmpty();
        });
        site("datum.webauthn.forms.petition.unavailable=accept").run(context -> {
            SubmissionSignatureCheck check = context.getBean(SubmissionSignatureCheck.class);
            ObjectNode unsigned = WebAuthnTestKit.envelope("petition", Map.of("fullName", "Eve"));

            SignatureVerdict fallback = check.check(candidate(unsigned, SubmissionMode.SUBMIT, header));

            assertThat(fallback.refuses()).isFalse();
            assertThat(fallback.details()).containsEntry("status", "unavailable");
            assertThat(code(check.check(candidate(unsigned)))).as("without the header it is still required").isEqualTo("signature.required");
        });
    }

    @Test
    void whenPasskeysAreNotSetUpARequiredFormFollowsItsPolicy() {
        site("datum.webauthn.rp-id=", "datum.webauthn.origins=").run(context -> {
            SubmissionSignatureCheck check = context.getBean(SubmissionSignatureCheck.class);

            SignatureVerdict refused = check.check(candidate(WebAuthnTestKit.envelope("petition", Map.of("fullName", "Ada"))));

            assertThat(code(refused)).isEqualTo("signature.unavailable");
        });
        site("datum.webauthn.rp-id=", "datum.webauthn.origins=", "datum.webauthn.forms.petition.unavailable=accept").run(context -> {
            SubmissionSignatureCheck check = context.getBean(SubmissionSignatureCheck.class);

            SignatureVerdict accepted = check.check(candidate(WebAuthnTestKit.envelope("petition", Map.of("fullName", "Ada"))));

            assertThat(accepted.refuses()).isFalse();
            assertThat(accepted.details()).containsEntry("status", "unavailable");
        });
    }

    @Test
    void aDryRunPublishesNoEventAndClaimsNothing() {
        site().run(context -> {
            SubmissionSignatureCheck check = context.getBean(SubmissionSignatureCheck.class);
            Authenticator authenticator = new Authenticator();
            register(context, authenticator);
            ObjectNode body = signed(authenticator, "Cy");

            assertThat(check.check(candidate(body, SubmissionMode.TEST, Map.of())).status()).isEqualTo(SignatureVerdict.Status.VALID);
            assertThat(events).isEmpty();
            assertThat(check.check(candidate(body)).status()).as("the real delivery still goes through").isEqualTo(SignatureVerdict.Status.VALID);
        });
    }

    @Test
    void aListenerThatThrowsDoesNotChangeTheVerdict() {
        ApplicationListener<org.springframework.context.PayloadApplicationEvent<?>> failing = event -> {
            if (event.getPayload() instanceof SubmissionSignatureVerifiedEvent) {
                throw new IllegalStateException("a listener's bug");
            }
        };
        site().withBean("failingListener", ApplicationListener.class, () -> failing).run(context -> {
            SubmissionSignatureCheck check = context.getBean(SubmissionSignatureCheck.class);
            Authenticator authenticator = new Authenticator();
            register(context, authenticator);

            assertThat(check.check(candidate(signed(authenticator, "Ada"))).status()).isEqualTo(SignatureVerdict.Status.VALID);
        });
    }

    /** The one guard takes a listener's failed assertion too, at the stored step as at the check. */
    @Test
    void aListenerThatFailsAnAssertionDoesNotChangeTheVerdictOrTheStoredStep() {
        ApplicationListener<org.springframework.context.PayloadApplicationEvent<?>> failing = event -> {
            if (event.getPayload() instanceof SubmissionSignatureVerifiedEvent) {
                throw new AssertionError("a listener's invariant");
            }
        };
        site().withBean("failingListener", ApplicationListener.class, () -> failing).run(context -> {
            SubmissionSignatureCheck check = context.getBean(SubmissionSignatureCheck.class);
            Authenticator authenticator = new Authenticator();
            register(context, authenticator);
            SignatureVerdict verdict = check.check(candidate(signed(authenticator, "Ada")));
            assertThat(verdict.status()).isEqualTo(SignatureVerdict.Status.VALID);
            check.recordUse(accepted(verdict));
            check.stored(accepted(verdict), RECEIPT);
        });
    }

    private static DatumException thrown(Runnable call) {
        try {
            call.run();
        } catch (DatumException e) {
            return e;
        }
        throw new AssertionError("Expected a DatumException.");
    }
}
