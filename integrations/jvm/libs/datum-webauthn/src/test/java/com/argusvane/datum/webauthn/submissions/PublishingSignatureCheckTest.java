package com.argusvane.datum.webauthn.submissions;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.core.DatumEventPublisher;
import com.argusvane.datum.core.DatumException;
import com.argusvane.datum.submissions.spi.AcceptedSubmission;
import com.argusvane.datum.submissions.spi.CandidateSubmission;
import com.argusvane.datum.submissions.spi.SignatureVerdict;
import com.argusvane.datum.submissions.spi.SubmissionMode;
import com.argusvane.datum.submissions.spi.SubmissionReceipt;
import com.argusvane.datum.submissions.spi.SubmissionRequest;
import com.argusvane.datum.submissions.spi.ValidationScope;
import com.argusvane.datum.webauthn.FormSigning;
import com.argusvane.datum.webauthn.PasskeySubjectResolver;
import com.argusvane.datum.webauthn.TestSite;
import com.argusvane.datum.webauthn.events.SubmissionSignatureVerifiedEvent;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

/**
 * {@link PublishingSignatureCheck} guards the publisher it is given, with no Spring binding in between:
 * a non-Spring host that hands over a bus whose listener throws keeps every verdict, refusal and stored step unchanged.
 * The Spring binding guards as well, so only a library-level test notices if this class's own guard is lost.
 */
class PublishingSignatureCheckTest {

    private static final String CONFIRM = "I confirm these answers.";

    private final TestSite site = new TestSite();
    private final FormSigning form = FormSigning.builder().mode(FormSigning.Mode.REQUIRED).statement(CONFIRM).build();
    private final List<Object> attempted = new ArrayList<>();

    /** A listener that throws an Error behind the host's default publisher, the guarded one. */
    private final DatumEventPublisher throwing = DatumEventPublisher.guarded(event -> {
        attempted.add(event);
        throw new AssertionError("audit listener broke");
    });

    private PublishingSignatureCheck check() {
        return check(throwing);
    }

    private PublishingSignatureCheck check(DatumEventPublisher events) {
        return new PublishingSignatureCheck(
            new PasskeySignatureCheck(site.signatures(), site.settings(), key -> form, PasskeySubjectResolver.byPrincipalName()), events);
    }

    /**
     * The check uses the publisher it is given as given, so an application's own
     * publisher that throws on the valid event reaches the caller of {@code stored}.
     */
    @Test
    void anApplicationsOwnPublisherThatThrowsReachesTheCaller() {
        PublishingSignatureCheck check = check(event -> {
            attempted.add(event);
            throw new IllegalStateException("outbox down");
        });
        var authenticator = site.authenticator();
        site.register(authenticator);
        SignatureVerdict verdict = check.check(candidate(site.signed(authenticator, Map.of("fullName", "Ada"), Map.of("statement", CONFIRM))));
        check.recordUse(accepted(verdict));
        assertThatThrownBy(() -> check.stored(accepted(verdict), new SubmissionReceipt("r-1", null, null)))
            .isInstanceOf(IllegalStateException.class).hasMessage("outbox down");
        assertThat(attempted).singleElement().isInstanceOf(SubmissionSignatureVerifiedEvent.class);
    }

    private static CandidateSubmission candidate(ObjectNode document) {
        ObjectNode envelope = document.has("payload") ? (ObjectNode) document.get("payload") : document;
        ObjectNode definition = JsonNodeFactory.instance.objectNode().put("id", "petition");
        ObjectNode values = envelope.has("submission") ? (ObjectNode) envelope.get("submission").get("values") : JsonNodeFactory.instance.objectNode();
        return new CandidateSubmission("petition", SubmissionMode.SUBMIT, definition, "0".repeat(64), document.deepCopy(), envelope.deepCopy(), values,
            "en", new ValidationScope("submission", null, null, null, false), JsonNodeFactory.instance.objectNode(),
            new SubmissionRequest("application/json", Map.of(), null, null).toContext(null));
    }

    private static AcceptedSubmission accepted(SignatureVerdict verdict) {
        return new AcceptedSubmission("petition", "0".repeat(64), "0".repeat(64), "{}", JsonNodeFactory.instance.objectNode(), List.of(),
            JsonNodeFactory.instance.arrayNode(), List.of(), List.of(), List.of(), List.of(), null, null, verdict, "en", null,
            JsonNodeFactory.instance.arrayNode(), null, "http", "attempt-1");
    }

    /** Valid at stored, invalid when judged, stale 409, and the race loser at recordUse: each answer is the check's own. */
    @Test
    void aThrowingListenerChangesNoAnswer() {
        PublishingSignatureCheck check = check();
        var authenticator = site.authenticator();
        site.register(authenticator);

        ObjectNode body = site.signed(authenticator, Map.of("fullName", "Ada"), Map.of("statement", CONFIRM));
        SignatureVerdict first = check.check(candidate(body));
        SignatureVerdict second = check.check(candidate(body));
        assertThat(List.of(first.status(), second.status())).containsOnly(SignatureVerdict.Status.VALID);
        assertThat(attempted).as("A valid verdict is not announced when judged.").isEmpty();

        check.recordUse(accepted(first));
        check.stored(accepted(first), new SubmissionReceipt("r-1", null, null));
        assertThat(attempted).singleElement().isInstanceOfSatisfying(SubmissionSignatureVerifiedEvent.class,
            event -> assertThat(event.status()).isEqualTo("valid"));

        // The race loser: the store's refusal is what the caller sees, never the listener's Error.
        assertThatThrownBy(() -> check.recordUse(accepted(second))).isInstanceOf(DatumException.class)
            .satisfies(e -> assertThat(((DatumException) e).code()).isEqualTo("signature.invalid"));
        assertThat(attempted).hasSize(2);

        // Judged invalid (a counter that did not go up): the verdict comes back.
        SignatureVerdict counter = check.check(candidate(site.signed(authenticator, Map.of("fullName", "Cy"),
            Map.of("statement", CONFIRM, "counter", 1L))));
        assertThat(counter.status()).isEqualTo(SignatureVerdict.Status.INVALID);
        assertThat(attempted).hasSize(3);

        // Stale: the 409 is thrown, not the listener's Error.
        assertThatThrownBy(() -> check.check(candidate(site.signed(authenticator, Map.of("fullName", "Bo"), Map.of("statement", "Something else.")))))
            .isInstanceOf(DatumException.class).satisfies(e -> assertThat(((DatumException) e).httpStatus()).isEqualTo(409));
        assertThat(attempted).hasSize(4);
    }
}
