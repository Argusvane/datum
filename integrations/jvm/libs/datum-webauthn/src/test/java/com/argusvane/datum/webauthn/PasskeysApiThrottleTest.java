package com.argusvane.datum.webauthn;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.web.json.DatumJsonMapper;
import com.argusvane.datum.webauthn.web.PasskeyThrottle;
import com.argusvane.datum.webauthn.web.PasskeyThrottledException;
import com.argusvane.datum.webauthn.web.PasskeysApi;
import com.argusvane.datum.webauthn.web.PasskeysRequest;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * The passkey routes hand the throttle the address it counts: an IPv6 client by its /64 (as the submission routes and
 * the FastAPI host count it), so one host handed a whole /64 cannot ask for a fresh challenge from each of its addresses.
 */
class PasskeysApiThrottleTest {

    @Test
    void twoAddressesOfOneSlash64ShareAWindow() {
        Passkeys site = new Passkeys();
        PasskeySubject ada = new PasskeySubject("7", "ada", "Ada");
        PasskeyRecord passkey = site.register(new SoftwareAuthenticator(), "Phone", ada);
        List<String> counted = new ArrayList<>();
        // One challenge per counted address: the second from an address already counted is refused.
        PasskeyThrottle oncePerAddress = (ip, formKey, principal) -> {
            if (counted.contains(ip)) {
                return new PasskeyThrottle.Decision.Deny(Duration.ofSeconds(30));
            }
            counted.add(ip);
            return PasskeyThrottle.Decision.ALLOW;
        };
        PasskeysApi api = new PasskeysApi(site.settings, new PasskeysApi.Options(true, ""), site.ceremony, site.challenges, site.repository,
            site.uses, site.verifier, key -> FormSigning.OFF, principal -> ada, oncePerAddress, DatumJsonMapper.create(65536), event -> { },
            site.clock);

        assertThat(api.checkChallenge(passkey.credentialId(), from("2001:db8:1:2::1")).status()).isEqualTo(200);
        assertThatThrownBy(() -> api.checkChallenge(passkey.credentialId(), from("2001:db8:1:2::2")))
            .isInstanceOf(PasskeyThrottledException.class);
        assertThat(api.checkChallenge(passkey.credentialId(), from("2001:db8:1:3::1")).status()).isEqualTo(200);
        assertThat(api.checkChallenge(passkey.credentialId(), from("::ffff:198.51.100.9")).status()).isEqualTo(200);
        assertThat(counted).containsExactly("2001:db8:1:2::/64", "2001:db8:1:3::/64", "198.51.100.9");
    }

    /**
     * The address limit: 415 first, then the address as the throttle counts it, before the body; a passkey's test
     * challenge (no body) asks it first. A request with no client address is not counted.
     */
    @Test
    void theAddressLimitComesAfterTheContentTypeAndBeforeTheBody() {
        Passkeys site = new Passkeys();
        PasskeySubject ada = new PasskeySubject("7", "ada", "Ada");
        PasskeyRecord passkey = site.register(new SoftwareAuthenticator(), "Phone", ada);
        List<String> counted = new ArrayList<>();
        java.util.concurrent.atomic.AtomicReference<Duration> closed = new java.util.concurrent.atomic.AtomicReference<>();
        PasskeyThrottle throttle = new PasskeyThrottle() {
            @Override
            public Decision check(String ip, String formKey, String principal) {
                return Decision.ALLOW;
            }

            @Override
            public Decision checkAddress(String ip) {
                if (closed.get() != null) {
                    return new Decision.Deny(closed.get());
                }
                counted.add(ip);
                return Decision.ALLOW;
            }
        };
        PasskeysApi api = new PasskeysApi(site.settings, new PasskeysApi.Options(true, ""), site.ceremony, site.challenges, site.repository,
            site.uses, site.verifier, key -> FormSigning.OFF, principal -> ada, throttle, DatumJsonMapper.create(65536), event -> { },
            site.clock);
        assertThatThrownBy(() -> api.admit(new PasskeysRequest("text/plain", Map.of(), "192.0.2.1", () -> "ada")))
            .isInstanceOf(com.argusvane.datum.web.error.UnsupportedMediaTypeException.class);
        assertThat(counted).isEmpty();
        api.admit(from("2001:db8:1:2::1"));
        api.admit(new PasskeysRequest("application/json", Map.of(), null, () -> "ada"));
        api.checkChallenge(passkey.credentialId(), from("::ffff:198.51.100.9"));
        assertThat(counted).containsExactly("2001:db8:1:2::/64", "198.51.100.9");
        closed.set(Duration.ofSeconds(3));
        assertThatThrownBy(() -> api.admit(from("192.0.2.1"))).isInstanceOf(PasskeyThrottledException.class)
            .satisfies(e -> assertThat(((PasskeyThrottledException) e).code()).isEqualTo("flood"));
        assertThatThrownBy(() -> api.checkChallenge(passkey.credentialId(), from("192.0.2.1"))).isInstanceOf(PasskeyThrottledException.class);
    }

    private static PasskeysRequest from(String address) {
        return new PasskeysRequest("application/json", Map.of(), address, () -> "ada");
    }
}
