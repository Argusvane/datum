package com.argusvane.datum.webauthn;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.core.DatumEventPublisher;
import com.argusvane.datum.web.json.DatumJsonMapper;
import com.argusvane.datum.webauthn.events.PasskeyRevokedEvent;
import com.argusvane.datum.webauthn.web.PasskeysApi;
import com.argusvane.datum.webauthn.web.PasskeysReply;
import com.argusvane.datum.webauthn.web.PasskeysRequest;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * {@link PasskeysApi} guards the publisher it is given, with no Spring binding in between: a plain-Java
 * host whose listener throws still gets the 200 for a passkey that is already revoked, never a 500. The Spring binding
 * guards too, so only this library-level test notices if the class's own guard is lost.
 */
class PasskeysApiEventsTest {

    /** Through the host's default publisher, the guarded one. */
    @Test
    void aThrowingListenerDoesNotTurnARevokeIntoAFailure() {
        Passkeys site = new Passkeys();
        PasskeySubject ada = new PasskeySubject("7", "ada", "Ada");
        PasskeyRecord passkey = site.register(new SoftwareAuthenticator(), "Phone", ada);
        List<Object> attempted = new ArrayList<>();
        DatumEventPublisher throwing = DatumEventPublisher.guarded(event -> {
            attempted.add(event);
            throw new AssertionError("audit listener broke");
        });
        PasskeysApi api = api(site, ada, throwing);

        PasskeysReply reply = api.revoke(passkey.credentialId(), new PasskeysRequest("application/json", Map.of(), null, () -> "ada"));

        assertThat(reply.status()).isEqualTo(200);
        assertThat(attempted).singleElement().isInstanceOf(PasskeyRevokedEvent.class);
        assertThat(site.repository.find(passkey.credentialId())).as("The revoke stands.").isEmpty();
    }

    /**
     * The API uses the publisher it is given as given, so an application's own
     * publisher that throws reaches the caller; the revoke it reports stands.
     */
    @Test
    void anApplicationsOwnPublisherThatThrowsReachesTheCaller() {
        Passkeys site = new Passkeys();
        PasskeySubject ada = new PasskeySubject("7", "ada", "Ada");
        PasskeyRecord passkey = site.register(new SoftwareAuthenticator(), "Phone", ada);
        PasskeysApi api = api(site, ada, event -> {
            throw new IllegalStateException("outbox down");
        });

        org.assertj.core.api.Assertions.assertThatIllegalStateException().isThrownBy(() -> api.revoke(passkey.credentialId(),
            new PasskeysRequest("application/json", Map.of(), null, () -> "ada"))).withMessage("outbox down");
        assertThat(site.repository.find(passkey.credentialId())).as("The revoke stands.").isEmpty();
    }

    private static PasskeysApi api(Passkeys site, PasskeySubject ada, DatumEventPublisher events) {
        return new PasskeysApi(site.settings, new PasskeysApi.Options(true, ""), site.ceremony, site.challenges, site.repository,
            site.uses, site.verifier, key -> FormSigning.OFF, principal -> ada, null, DatumJsonMapper.create(65536), events, site.clock);
    }
}
