package com.argusvane.datum.webauthn;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyPairGenerator;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.HexFormat;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * The in-memory stores keep what the SQL ones keep: a test of a passkey stores its counter
 * and last use through {@code PasskeyRepository.touch}, anonymous passkeys nobody signed with are purged, and the
 * challenge lifetime is the host's.
 */
class InMemoryStoresTest {

    private final InMemoryPasskeyRepository passkeys = new InMemoryPasskeyRepository();
    private final InMemoryPasskeyUseStore uses = new InMemoryPasskeyUseStore(passkeys);
    private int sequence;

    private static byte[] spki() {
        try {
            KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
            generator.initialize(256);
            return generator.generateKeyPair().getPublic().getEncoded();
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }

    private PasskeyRecord.Builder passkey(String credentialId) {
        return PasskeyRecord.builder().credentialId(credentialId).publicKey(spki()).algorithm(CoseKey.ES256).owner("").label("Visitor")
            .userHandle("handle").madeOn("petition").rpId("localhost").created(Instant.now().truncatedTo(ChronoUnit.MILLIS));
    }

    @Test
    void aTestOfAPasskeyStoresItsCounterAndLastUseAndTheCounterOnlyGoesUp() {
        PasskeyRecord stored = passkeys.create(passkey("counted").owner("ada").build());
        Instant at = Instant.now().truncatedTo(ChronoUnit.MILLIS);

        assertThat(passkeys.touch(stored.id(), 7, at)).isTrue();
        PasskeyRecord after = passkeys.findById(stored.id()).orElseThrow();
        assertThat(after.signCount()).isEqualTo(7);
        assertThat(after.lastUsed()).isEqualTo(at);

        assertThat(passkeys.touch(stored.id(), 3, at.plusSeconds(5))).isTrue();
        assertThat(passkeys.findById(stored.id()).orElseThrow().signCount()).as("never back down").isEqualTo(7);
        assertThat(passkeys.touch(9999, 1, at)).as("no such passkey").isFalse();
    }

    @Test
    void aRepositoryWithoutPurgeRemovesNothing() {
        PasskeyRepository bare = new PasskeyRepository() {
            public java.util.Optional<PasskeyRecord> find(String id) { return java.util.Optional.empty(); }
            public java.util.Optional<PasskeyRecord> findById(long id) { return java.util.Optional.empty(); }
            public boolean keyRegistered(String hash) { return false; }
            public java.util.Optional<PasskeyRecord> firstOf(String owner, String formId) { return java.util.Optional.empty(); }
            public List<PasskeyRecord> ownActive(String owner, String formId) { return List.of(); }
            public List<PasskeyRecord> ofOwner(String owner) { return List.of(); }
            public PasskeyRecord create(PasskeyRecord passkey) { return passkey; }
            public boolean revoke(long id, String by, Instant at) { return false; }
            public boolean markRemoved(long id, Instant at) { return false; }
            public boolean delete(long id) { return false; }
            public boolean touch(long id, long signCount, Instant at) { return false; }
        };
        assertThat(bare.purgeAnonymous(Instant.now(), 10)).isZero();
    }

    @Test
    void anonymousPasskeysNobodySignedWithAreRemovedAfterTheirGrace() {
        Instant old = Instant.now().minus(Duration.ofDays(2)).truncatedTo(ChronoUnit.MILLIS);
        PasskeyRecord idle = passkeys.create(passkey("idle").created(old).build());
        PasskeyRecord signed = passkeys.create(passkey("signed").created(old).build());
        PasskeyRecord invited = passkeys.create(passkey("invited").origin("invitation").created(old).build());
        PasskeyRecord fresh = passkeys.create(passkey("fresh").build());
        PasskeyRecord account = passkeys.create(passkey("account").owner("ada").created(old).build());
        assertThat(uses.record(new PasskeyUseStore.PasskeyUse(signed.publicKeyHash(), hex(), signed.id(), "", 1, Instant.now())))
            .isEqualTo(PasskeyUseStore.Outcome.RECORDED);

        int removed = passkeys.purgeAnonymous(Instant.now().minus(PasskeyRepository.ANONYMOUS_GRACE), 10);

        assertThat(removed).isEqualTo(1);
        assertThat(passkeys.findById(idle.id())).as("never used, a day on").isEmpty();
        assertThat(passkeys.findById(signed.id())).as("it signed a stored submission").isPresent();
        assertThat(passkeys.findById(invited.id())).as("its holder signs with it later").isPresent();
        assertThat(passkeys.findById(fresh.id())).as("still within its day").isPresent();
        assertThat(passkeys.findById(account.id())).as("an account's, not an anonymous visitor's").isPresent();
    }

    @Test
    void thePurgeIsBoundedByItsLimit() {
        Instant old = Instant.now().minus(Duration.ofDays(2)).truncatedTo(ChronoUnit.MILLIS);
        for (int i = 0; i < 5; i++) {
            passkeys.create(passkey("old-" + i).created(old).build());
        }
        assertThat(passkeys.purgeAnonymous(Instant.now().minus(PasskeyRepository.ANONYMOUS_GRACE), 2)).isEqualTo(2);
        assertThat(passkeys.purgeAnonymous(Instant.now().minus(PasskeyRepository.ANONYMOUS_GRACE), 10)).isEqualTo(3);
    }

    @Test
    void theChallengeLifetimeIsTheHostsAndStaysWithinBounds() {
        byte[] secret = "a host secret of thirty-two bytes!!".getBytes(StandardCharsets.UTF_8);
        MutableClock clock = MutableClock.now();
        PasskeyChallenges minute = new PasskeyChallenges(secret, clock, new InMemoryChallengeClaims(), Duration.ofSeconds(60));
        PasskeyChallenges.IssuedChallenge issued = minute.issue("register", "petition", "", "h");
        assertThat(issued.expires()).isEqualTo(clock.instant().getEpochSecond() + 60);
        clock.advance(Duration.ofSeconds(61));
        assertThat(minute.claim(issued.token(), "register", "petition", "")).as("past the host's minute").isEmpty();

        PasskeyChallenges hour = new PasskeyChallenges(secret, clock, new InMemoryChallengeClaims(), Duration.ofMinutes(30));
        PasskeyChallenges.IssuedChallenge long1 = hour.issue("register", "petition", "", "h");
        clock.advance(Duration.ofMinutes(29));
        assertThat(hour.claim(long1.token(), "register", "petition", "")).isPresent();

        assertThatThrownBy(() -> new PasskeyChallenges(secret, clock, new InMemoryChallengeClaims(), Duration.ofSeconds(9)))
            .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new PasskeyChallenges(secret, clock, new InMemoryChallengeClaims(), Duration.ofHours(2)))
            .isInstanceOf(IllegalArgumentException.class);
    }

    private String hex() {
        byte[] bytes = new byte[32];
        bytes[0] = (byte) ++sequence;
        return HexFormat.of().formatHex(bytes);
    }
}
