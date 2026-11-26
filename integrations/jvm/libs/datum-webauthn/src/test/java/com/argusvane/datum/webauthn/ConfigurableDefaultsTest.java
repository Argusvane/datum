package com.argusvane.datum.webauthn;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.web.json.DatumJsonMapper;
import com.argusvane.datum.webauthn.web.PasskeysApi;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * The four configurable settings ({@code datum.webauthn.resident-key}, {@code challenge-skew},
 * {@code signed-at-skew}, {@code anonymous-grace}): each default is the value a host gets unconfigured, each bound is checked where
 * the settings are made, and each value reaches the code that used the constant.
 */
class ConfigurableDefaultsTest {

    private static final JsonMapper JSON = JsonMapper.builder().build();

    private static WebAuthnSettings with(String residentKey, Duration challengeSkew, Duration signedAtSkew, Duration anonymousGrace) {
        return new WebAuthnSettings("localhost", "Petition", List.of("http://localhost"), null, true, false, residentKey, challengeSkew,
            signedAtSkew, anonymousGrace);
    }

    @Test
    void theDefaultsAreTheValuesThatWereFixed() {
        WebAuthnSettings defaults = with(null, null, null, null);
        assertThat(defaults.residentKey()).isEqualTo("required");
        assertThat(defaults.challengeSkew()).isEqualTo(Duration.ofSeconds(60));
        assertThat(defaults.signedAtSkew()).isEqualTo(Duration.ofSeconds(60));
        assertThat(defaults.anonymousGrace()).isEqualTo(Duration.ofHours(24));
        assertThat(PasskeySettings.defaults().webAuthnSettings("x").residentKey()).isEqualTo("required");
        assertThat(PasskeyRepository.ANONYMOUS_GRACE).isEqualTo(Duration.ofHours(24));
        assertThat(with(" Preferred ", null, null, null).residentKey()).as("case and spaces").isEqualTo("preferred");
    }

    @Test
    void aValueOutsideItsBoundsStopsTheStartNamingTheProperty() {
        assertThatThrownBy(() -> with("sometimes", null, null, null)).isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("datum.webauthn.resident-key");
        assertThatThrownBy(() -> with(null, Duration.ofMinutes(6), null, null)).hasMessageContaining("datum.webauthn.challenge-skew");
        assertThatThrownBy(() -> with(null, Duration.ofSeconds(-1), null, null)).hasMessageContaining("datum.webauthn.challenge-skew");
        assertThatThrownBy(() -> with(null, null, Duration.ofMinutes(11), null)).hasMessageContaining("datum.webauthn.signed-at-skew");
        assertThatThrownBy(() -> with(null, null, null, Duration.ofMinutes(30))).hasMessageContaining("datum.webauthn.anonymous-grace");
        assertThatThrownBy(() -> with(null, null, null, Duration.ofDays(31))).hasMessageContaining("datum.webauthn.anonymous-grace");
        assertThat(with("discouraged", Duration.ZERO, Duration.ofMinutes(10), Duration.ofHours(1)).anonymousGrace()).isEqualTo(Duration.ofHours(1));
    }

    @Test
    void thePasskeySettingsCarryThemToTheCeremonysSettings() {
        PasskeySettings defaults = PasskeySettings.defaults();
        PasskeySettings mine = new PasskeySettings(defaults.enabled(), "localhost", "Petition", List.of("http://localhost"), true, true,
            defaults.window(), defaults.challengeTtl(), defaults.path(), defaults.passkeys(), "", "", 0, defaults.siteSigning(), defaults.forms(),
            false, "discouraged", Duration.ofSeconds(5), Duration.ofSeconds(7), Duration.ofHours(2));
        WebAuthnSettings ceremony = mine.webAuthnSettings("Petition");
        assertThat(ceremony.residentKey()).isEqualTo("discouraged");
        assertThat(ceremony.challengeSkew()).hasSeconds(5);
        assertThat(ceremony.signedAtSkew()).hasSeconds(7);
        assertThat(ceremony.anonymousGrace()).hasHours(2);
    }

    @Test
    void theRegistrationAsksTheAuthenticatorForTheConfiguredResidentKey() {
        for (String requirement : List.of("required", "preferred", "discouraged")) {
            Passkeys site = new Passkeys(with(requirement, null, null, null));
            PasskeySubject visitor = PasskeySubject.anonymous();
            PasskeyContext context = site.context(visitor, FormSigning.builder().mode(FormSigning.Mode.REQUIRED).build());
            assertThat(site.ceremony.challenge(context, visitor, "").residentKey()).isEqualTo(requirement);
        }
    }

    @Test
    void theChallengeSkewIsTheConfiguredSeconds() {
        MutableClock clock = MutableClock.now();
        byte[] secret = "a host secret of thirty-two bytes!!".getBytes(StandardCharsets.UTF_8);
        PasskeyChallenges lenient = new PasskeyChallenges(secret, clock, new InMemoryChallengeClaims(), Duration.ofSeconds(300), Duration.ofSeconds(120));
        PasskeyChallenges.IssuedChallenge inside = lenient.issue("register", "petition", "", "h");
        clock.advance(Duration.ofSeconds(-120));
        assertThat(lenient.claim(inside.token(), "register", "petition", "")).as("120 s ahead with a skew of 120 s").isPresent();
        PasskeyChallenges.IssuedChallenge outside = lenient.issue("register", "petition", "", "h");
        clock.advance(Duration.ofSeconds(-121));
        assertThat(lenient.claim(outside.token(), "register", "petition", "")).isEmpty();

        PasskeyChallenges strict = new PasskeyChallenges(secret, clock, new InMemoryChallengeClaims(), Duration.ofSeconds(300), Duration.ZERO);
        PasskeyChallenges.IssuedChallenge ahead = strict.issue("register", "petition", "", "h");
        clock.advance(Duration.ofSeconds(-1));
        assertThat(strict.claim(ahead.token(), "register", "petition", "")).as("no skew: one second ahead is refused").isEmpty();
        assertThatThrownBy(() -> new PasskeyChallenges(secret, clock, new InMemoryChallengeClaims(), Duration.ofSeconds(300), Duration.ofSeconds(-1)))
            .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void theTwoSigningTimesAgreeWithinTheConfiguredSeconds() {
        // The result's time in milliseconds is 22:13:20Z; the assertion's is two minutes later.
        JsonNode signature = JSON.readTree("{\"signedAt\":1700000000000,\"webauthn\":{\"signedAt\":\"2023-11-14T22:15:20Z\"}}");
        assertThat(SubmissionSignatureVerifier.signedAtAgrees(signature, 60)).isFalse();
        assertThat(SubmissionSignatureVerifier.signedAtAgrees(signature, 119)).isFalse();
        assertThat(SubmissionSignatureVerifier.signedAtAgrees(signature, 120)).isTrue();
        assertThat(SubmissionSignatureVerifier.signedAtAgrees(JSON.readTree("{}"), 0)).as("nothing to compare").isTrue();
    }

    @Test
    void theAnonymousPurgeCutsOffAtTheConfiguredGrace() {
        MutableClock clock = MutableClock.now();
        List<Instant> cutoffs = new ArrayList<>();
        PasskeyRepository recording = (PasskeyRepository) Proxy.newProxyInstance(getClass().getClassLoader(), new Class<?>[] {PasskeyRepository.class},
            (proxy, method, args) -> {
                if (method.getName().equals("purgeAnonymous")) {
                    cutoffs.add((Instant) args[0]);
                    return 0;
                }
                throw new UnsupportedOperationException(method.getName());
            });
        for (Duration grace : List.of(Duration.ofHours(24), Duration.ofHours(3))) {
            Passkeys site = new Passkeys(with(null, null, null, grace));
            PasskeysApi api = new PasskeysApi(site.settings, new PasskeysApi.Options(true, ""), site.ceremony, site.challenges, recording, site.uses,
                site.verifier, key -> FormSigning.OFF, principal -> PasskeySubject.anonymous(), null, DatumJsonMapper.create(65536), null, clock);
            api.purgeAnonymous();
            assertThat(cutoffs.get(cutoffs.size() - 1)).isEqualTo(clock.instant().minus(grace));
        }
        assertThat(cutoffs).hasSize(2);
    }
}
