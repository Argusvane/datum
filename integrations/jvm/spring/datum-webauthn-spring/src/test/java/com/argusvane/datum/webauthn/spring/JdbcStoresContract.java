package com.argusvane.datum.webauthn.spring;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.webauthn.ChallengeClaims;
import com.argusvane.datum.webauthn.CoseKey;
import com.argusvane.datum.webauthn.DuplicatePasskeyException;
import com.argusvane.datum.webauthn.PasskeyException;
import com.argusvane.datum.webauthn.PasskeyRecord;
import com.argusvane.datum.webauthn.PasskeyRepository;
import com.argusvane.datum.webauthn.PasskeyUseStore.Outcome;
import com.argusvane.datum.webauthn.PasskeyUseStore.PasskeyUse;
import com.argusvane.datum.webauthn.PasskeyUseStore;
import java.security.KeyPairGenerator;
import java.security.SecureRandom;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.HexFormat;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import javax.sql.DataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.jdbc.datasource.init.ResourceDatabasePopulator;

/**
 * The JDBC stores over H2 with the real {@code V400__datum_webauthn.sql} of one dialect (the subclasses run it in H2's
 * regular, PostgreSQL and MySQL modes, so every shipped script is applied and exercised by the build): the repository's SPI contract and both
 * unique keys, the use store's claim and counter move as one step (replay, revoked, counter, concurrent
 * claims) and its release with {@code replaced_sign_count}, and the challenge claims.
 */
abstract class JdbcStoresContract {

    private static final SecureRandom RANDOM = new SecureRandom();

    private JdbcTemplate jdbc;
    private JdbcPasskeyRepository passkeys;
    private JdbcPasskeyUseStore uses;
    private DataSource dataSource;

    /** The directory of the migration scripts: h2, postgresql or mysql. */
    protected abstract String dialect();

    /** H2's compatibility mode for the dialect ({@code ;MODE=PostgreSQL}), or "". */
    protected abstract String mode();

    /**
     * The database the contract runs on, before the script is applied: a private H2 per test in the dialect's mode (the
     * default), or, in the Testcontainers subclasses, a clean real PostgreSQL or MySQL.
     */
    protected DataSource newDatabase() throws Exception {
        return new DriverManagerDataSource("jdbc:h2:mem:" + UUID.randomUUID() + ";DB_CLOSE_DELAY=-1" + mode(), "sa", "");
    }

    @BeforeEach
    void database() throws Exception {
        // A private database per test: the migration is applied as shipped.
        DataSource source = newDatabase();
        new ResourceDatabasePopulator(new ClassPathResource("META-INF/datum/db/migration/" + dialect() + "/V400__datum_webauthn.sql")).execute(source);
        dataSource = source;
        jdbc = new JdbcTemplate(source);
        // On Spring's JDBC, each call a transaction of its own over the DataSource.
        passkeys = new JdbcPasskeyRepository(source);
        uses = new JdbcPasskeyUseStore(source);
    }

    private static byte[] spki() {
        try {
            KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
            generator.initialize(256);
            return generator.generateKeyPair().getPublic().getEncoded();
        } catch (java.security.GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }

    private static PasskeyRecord.Builder passkey(String credentialId, byte[] key) {
        return PasskeyRecord.builder().credentialId(credentialId).publicKey(key).algorithm(CoseKey.ES256).owner("ada").label("Laptop")
            .transports(List.of("internal", "hybrid")).userHandle("handle").madeOn("petition").aaguid("00000000-0000-0000-0000-000000000000")
            .attestation("none").rpId("localhost").webOrigin("http://localhost").browser("Chrome on macOS").userVerified(true)
            .created(Instant.now().truncatedTo(ChronoUnit.MILLIS));
    }

    private PasskeyRecord stored(String credentialId) {
        return passkeys.create(passkey(credentialId, spki()).build());
    }

    private static String hex(int n) {
        byte[] bytes = new byte[n];
        RANDOM.nextBytes(bytes);
        return HexFormat.of().formatHex(bytes);
    }

    private static PasskeyUse use(PasskeyRecord passkey, String digest, long count) {
        return new PasskeyUse(passkey.publicKeyHash(), digest, passkey.id(), "", count, Instant.now().truncatedTo(ChronoUnit.MILLIS));
    }

    // ------------------------------------------------------------------------------------------ repository

    @Test
    void aPasskeyRoundTripsEveryField() {
        PasskeyRecord made = passkey("cred-1", spki()).formId("petition").backupEligible(true).backedUp(true).build();
        PasskeyRecord created = passkeys.create(made);

        assertThat(created.id()).isNotNull();
        PasskeyRecord read = passkeys.find("cred-1").orElseThrow();
        assertThat(read).usingRecursiveComparison().ignoringFields("publicKey").isEqualTo(created);
        assertThat(read.publicKey()).isEqualTo(made.publicKey());
        assertThat(read.transports()).containsExactly("internal", "hybrid");
        assertThat(passkeys.findById(created.id()).orElseThrow()).usingRecursiveComparison().isEqualTo(read);
        assertThat(passkeys.find("")).isEmpty();
        assertThat(passkeys.find("x".repeat(1401))).isEmpty();
        assertThat(passkeys.find("cred-2")).isEmpty();
    }

    @Test
    void bothUniqueKeysAreTheDatabasesAndCoverRevokedAndRemovedRows() {
        byte[] key = spki();
        PasskeyRecord first = passkeys.create(passkey("cred-1", key).build());

        assertThatThrownBy(() -> passkeys.create(passkey("cred-1", spki()).build())).as("the same credential id")
            .isInstanceOf(DuplicatePasskeyException.class);
        assertThatThrownBy(() -> passkeys.create(passkey("cred-2", key).build())).as("the same public key under another id")
            .isInstanceOf(DuplicatePasskeyException.class);
        assertThat(passkeys.keyRegistered(first.publicKeyHash())).isTrue();
        assertThat(passkeys.keyRegistered(hex(32))).isFalse();

        passkeys.revoke(first.id(), "ada", Instant.now());
        passkeys.markRemoved(first.id(), Instant.now());
        assertThatThrownBy(() -> passkeys.create(passkey("cred-3", key).build())).as("a removed passkey's key stays taken")
            .isInstanceOf(DuplicatePasskeyException.class);
        assertThatThrownBy(() -> passkeys.create(passkey("cred-1", spki()).build())).as("and so does its credential id")
            .isInstanceOf(DuplicatePasskeyException.class);
    }

    @Test
    void listsFollowTheSpisScopes() {
        PasskeyRecord any = passkeys.create(passkey("any", spki()).build());
        PasskeyRecord forPetition = passkeys.create(passkey("petition-only", spki()).formId("petition").build());
        PasskeyRecord forOther = passkeys.create(passkey("other-only", spki()).formId("other").build());
        PasskeyRecord revoked = passkeys.create(passkey("revoked", spki()).build());
        passkeys.create(passkey("someone-elses", spki()).owner("bo").build());
        passkeys.revoke(revoked.id(), "ada", Instant.now());

        assertThat(passkeys.ownActive("ada", null)).extracting(PasskeyRecord::credentialId).containsExactly("any", "petition-only", "other-only");
        assertThat(passkeys.ownActive("ada", "petition")).extracting(PasskeyRecord::credentialId).containsExactly("any", "petition-only");
        assertThat(passkeys.ofOwner("ada")).extracting(PasskeyRecord::credentialId).as("revoked ones are listed, removed ones are not")
            .containsExactly("any", "petition-only", "other-only", "revoked");
        passkeys.markRemoved(revoked.id(), Instant.now());
        assertThat(passkeys.ofOwner("ada")).hasSize(3);
        assertThat(passkeys.firstOf("ada", "")).get().extracting(PasskeyRecord::id).isEqualTo(any.id());
        assertThat(passkeys.firstOf("ada", "petition")).get().extracting(PasskeyRecord::id).isEqualTo(forPetition.id());
        assertThat(passkeys.firstOf("ada", "missing")).isEmpty();
        assertThat(forOther.id()).isNotNull();
    }

    @Test
    void revokeAndRemoveAreConditionalAndRemovalClearsTheLabel() {
        PasskeyRecord made = stored("cred-1");
        Instant first = Instant.now().truncatedTo(ChronoUnit.MILLIS);

        assertThat(passkeys.revoke(made.id(), "ada", first)).isTrue();
        assertThat(passkeys.revoke(made.id(), "someone-else", first.plusSeconds(60))).as("a revocation stays as it was").isFalse();
        PasskeyRecord revoked = passkeys.findById(made.id()).orElseThrow();
        assertThat(revoked.isRevoked()).isTrue();
        assertThat(revoked.revoked()).isEqualTo(first);
        assertThat(revoked.revokedBy()).isEqualTo("ada");

        assertThat(passkeys.markRemoved(made.id(), first)).isTrue();
        assertThat(passkeys.markRemoved(made.id(), first)).isFalse();
        PasskeyRecord removed = passkeys.findById(made.id()).orElseThrow();
        assertThat(removed.isRemoved()).isTrue();
        assertThat(removed.label()).isEmpty();
        assertThat(removed.credentialId()).as("its key, id and counter stay for what it signed").isEqualTo("cred-1");
    }

    @Test
    void deleteRefusesAPasskeyAStoredUseNames() {
        PasskeyRecord signed = stored("signed");
        PasskeyRecord unsigned = stored("unsigned");
        assertThat(uses.record(use(signed, hex(32), 1))).isEqualTo(Outcome.RECORDED);

        assertThat(passkeys.delete(signed.id())).as("the guard is in the statement").isFalse();
        assertThat(passkeys.findById(signed.id())).isPresent();
        assertThat(passkeys.delete(unsigned.id())).isTrue();
        assertThat(passkeys.findById(unsigned.id())).isEmpty();
    }

    @Test
    void touchMovesLastUsedAndOnlyRaisesTheCounter() {
        PasskeyRecord made = stored("cred-1");
        Instant at = Instant.now().truncatedTo(ChronoUnit.MILLIS);

        assertThat(passkeys.touch(made.id(), 7, at)).isTrue();
        assertThat(passkeys.findById(made.id()).orElseThrow()).extracting(PasskeyRecord::signCount, PasskeyRecord::lastUsed).containsExactly(7L, at);
        passkeys.touch(made.id(), 3, at.plusSeconds(1));
        assertThat(passkeys.findById(made.id()).orElseThrow().signCount()).as("never down").isEqualTo(7);
    }

    @Test
    void everythingTheCeremonyAcceptsFitsItsColumn() {
        // 8 transports of 32 characters (263 joined), the longest principal name that can own a passkey, a big RSA key.
        List<String> transports = java.util.stream.IntStream.range(0, 8).mapToObj(i -> "t".repeat(31) + i).toList();
        String owner = "o".repeat(512);
        byte[] key = new byte[16384];
        RANDOM.nextBytes(key);
        PasskeyRecord made = passkeys.create(passkey("wide", key).transports(transports).owner(owner).build());

        PasskeyRecord read = passkeys.findById(made.id()).orElseThrow();
        assertThat(read.transports()).isEqualTo(transports);
        assertThat(read.owner()).isEqualTo(owner);
        assertThat(read.publicKey()).isEqualTo(key);
        assertThat(passkeys.revoke(made.id(), owner, Instant.now())).as("a revoker as long as an owner").isTrue();
    }

    @Test
    void aValueTooWideForItsColumnIsARefusedPasskeyNotAServerFault() {
        assertThatThrownBy(() -> passkeys.create(passkey("long-owner", spki()).owner("o".repeat(513)).build()))
            .isInstanceOfSatisfying(PasskeyException.class, e -> assertThat(e.httpStatus()).isEqualTo(422));
        assertThatThrownBy(() -> passkeys.create(passkey("big-key", new byte[16385]).build()))
            .as("the same limit on every database").isInstanceOfSatisfying(PasskeyException.class, e -> assertThat(e.httpStatus()).isEqualTo(422));
        assertThat(passkeys.find("long-owner")).isEmpty();
    }

    @Test
    void anonymousPasskeysNobodySignedWithAreRemovedAfterTheirGrace() {
        Instant old = Instant.now().minus(Duration.ofDays(2)).truncatedTo(ChronoUnit.MILLIS);
        PasskeyRecord idle = passkeys.create(passkey("idle", spki()).owner("").created(old).build());
        PasskeyRecord signed = passkeys.create(passkey("signed", spki()).owner("").created(old).build());
        PasskeyRecord invited = passkeys.create(passkey("invited", spki()).owner("").origin("invitation").created(old).build());
        PasskeyRecord fresh = passkeys.create(passkey("fresh", spki()).owner("").build());
        PasskeyRecord account = passkeys.create(passkey("account", spki()).owner("ada").created(old).build());
        assertThat(uses.record(use(signed, hex(32), 1))).isEqualTo(Outcome.RECORDED);

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
            passkeys.create(passkey("idle-" + i, spki()).owner("").created(old).build());
        }

        assertThat(passkeys.purgeAnonymous(Instant.now(), 2)).isEqualTo(2);
        assertThat(passkeys.purgeAnonymous(Instant.now(), 10)).isEqualTo(3);
    }

    // ------------------------------------------------------------------------------------------ use store

    @Test
    void aUseClaimsTheDigestAndMovesTheCounterAsOneStep() {
        PasskeyRecord made = stored("cred-1");
        String digest = hex(32);

        assertThat(uses.used(made.publicKeyHash(), digest)).isFalse();
        PasskeyUse first = use(made, digest, 5);
        assertThat(uses.record(first)).isEqualTo(Outcome.RECORDED);
        assertThat(uses.used(made.publicKeyHash(), digest)).isTrue();
        assertThat(uses.signedCount(made.id())).isEqualTo(1);
        PasskeyRecord after = passkeys.findById(made.id()).orElseThrow();
        assertThat(after.signCount()).isEqualTo(5);
        assertThat(after.lastUsed()).isEqualTo(first.at());

        assertThat(uses.record(use(made, digest, 6))).as("the same digest by the same key").isEqualTo(Outcome.REPLAY);
        assertThat(passkeys.findById(made.id()).orElseThrow().signCount()).as("a replay moves nothing").isEqualTo(5);
        assertThat(uses.record(use(made, hex(32), 5))).as("a counter that did not go up").isEqualTo(Outcome.COUNTER);
        assertThat(uses.used(made.publicKeyHash(), "x")).isFalse();
        assertThat(uses.signedCount(made.id())).as("a refused use claims nothing").isEqualTo(1);
    }

    @Test
    void anAuthenticatorThatKeepsNoCounterStaysAtZero() {
        PasskeyRecord made = stored("cred-1");

        assertThat(uses.record(use(made, hex(32), 0))).isEqualTo(Outcome.RECORDED);
        assertThat(uses.record(use(made, hex(32), 0))).isEqualTo(Outcome.RECORDED);
        assertThat(uses.record(use(made, hex(32), 1))).isEqualTo(Outcome.RECORDED);
        assertThat(uses.record(use(made, hex(32), 0))).as("a counter that was counting does not go back to 0").isEqualTo(Outcome.COUNTER);
    }

    @Test
    void aRevokedOrMissingPasskeyRefusesAndClaimsNothing() {
        PasskeyRecord made = stored("cred-1");
        passkeys.revoke(made.id(), "ada", Instant.now());
        String digest = hex(32);

        assertThat(uses.record(use(made, digest, 1))).isEqualTo(Outcome.REVOKED);
        assertThat(uses.used(made.publicKeyHash(), digest)).as("the claim is not kept").isFalse();
        PasskeyUse ghost = new PasskeyUse(hex(32), hex(32), 99_999, "", 1, Instant.now());
        assertThat(uses.record(ghost)).isEqualTo(Outcome.REVOKED);
    }

    @Test
    void releaseGivesBackExactlyTheCounterThatUseReplaced() {
        PasskeyRecord made = stored("cred-1");
        PasskeyUse first = use(made, hex(32), 4);
        assertThat(uses.record(first)).isEqualTo(Outcome.RECORDED);
        PasskeyUse second = use(made, hex(32), 9);
        assertThat(uses.record(second)).isEqualTo(Outcome.RECORDED);

        // The first use is released after a later one moved the counter on: the counter stays where the later use put it.
        uses.release(first);
        assertThat(passkeys.findById(made.id()).orElseThrow().signCount()).isEqualTo(9);
        assertThat(uses.used(made.publicKeyHash(), first.digest())).as("its claim is gone").isFalse();
        assertThat(uses.used(made.publicKeyHash(), second.digest())).isTrue();

        // The latest use released: the counter goes back to the value it replaced (the first use's 4), not to 0.
        uses.release(second);
        assertThat(passkeys.findById(made.id()).orElseThrow().signCount()).isEqualTo(4);
        assertThat(uses.signedCount(made.id())).as("both claims are given back").isZero();
    }

    @Test
    void aReleasedDocumentCanBeSentAgain() {
        PasskeyRecord made = stored("cred-1");
        String digest = hex(32);
        PasskeyUse first = use(made, digest, 3);
        assertThat(uses.record(first)).isEqualTo(Outcome.RECORDED);

        uses.release(first);
        assertThat(uses.record(use(made, digest, 3))).isEqualTo(Outcome.RECORDED);
    }

    @Test
    void releaseTouchesOnlyItsOwnClaim() {
        PasskeyRecord made = stored("cred-1");
        String digest = hex(32);
        PasskeyUse real = use(made, digest, 3);
        assertThat(uses.record(real)).isEqualTo(Outcome.RECORDED);

        // Another request's use of the same digest (it lost the race: other count, other time) must not remove the claim.
        uses.release(new PasskeyUse(made.publicKeyHash(), digest, made.id(), "", 4, real.at().plusSeconds(1)));
        assertThat(uses.used(made.publicKeyHash(), digest)).isTrue();
        assertThat(passkeys.findById(made.id()).orElseThrow().signCount()).isEqualTo(3);
    }

    @Test
    void usesOutliveTheirPasskeyForTheSameKey() {
        PasskeyRecord made = stored("cred-1");
        String digest = hex(32);
        assertThat(uses.record(use(made, digest, 1))).isEqualTo(Outcome.RECORDED);

        passkeys.revoke(made.id(), "ada", Instant.now());
        passkeys.markRemoved(made.id(), Instant.now());

        assertThat(uses.used(made.publicKeyHash(), digest)).isTrue();
        assertThat(uses.signedCount(made.id())).isEqualTo(1);
    }

    @Test
    void racingUsesOfOneDigestClaimItOnce() throws Exception {
        PasskeyRecord made = stored("cred-1");
        String digest = hex(32);
        ExecutorService pool = Executors.newFixedThreadPool(8);
        try {
            List<Future<Outcome>> results = new java.util.ArrayList<>();
            for (int i = 0; i < 8; i++) {
                long count = 10 + i;
                Callable<Outcome> task = () -> uses.record(new PasskeyUse(made.publicKeyHash(), digest, made.id(), "", count, Instant.now()));
                results.add(pool.submit(task));
            }
            long recorded = 0;
            for (Future<Outcome> result : results) {
                if (result.get() == Outcome.RECORDED) {
                    recorded++;
                }
            }
            assertThat(recorded).as("one process wins the claim, however many race").isEqualTo(1);
            assertThat(uses.signedCount(made.id())).isEqualTo(1);
        } finally {
            pool.shutdownNow();
        }
    }

    @Test
    void racingUsesOfOneCounterValueLetOneThrough() throws Exception {
        PasskeyRecord made = stored("cred-1");
        ExecutorService pool = Executors.newFixedThreadPool(6);
        try {
            List<Future<Outcome>> results = new java.util.ArrayList<>();
            for (int i = 0; i < 6; i++) {
                results.add(pool.submit(() -> uses.record(new PasskeyUse(made.publicKeyHash(), hex(32), made.id(), "", 20, Instant.now()))));
            }
            long recorded = 0;
            for (Future<Outcome> result : results) {
                if (result.get() == Outcome.RECORDED) {
                    recorded++;
                }
            }
            assertThat(recorded).as("the same counter value is never accepted twice").isEqualTo(1);
            assertThat(passkeys.findById(made.id()).orElseThrow().signCount()).isEqualTo(20);
        } finally {
            pool.shutdownNow();
        }
    }

    @Test
    void theUseStoreIsTheSameThroughASecondInstanceOnTheSameDatabase() {
        PasskeyRecord made = stored("cred-1");
        PasskeyUseStore other = new JdbcPasskeyUseStore(dataSource);
        String digest = hex(32);

        assertThat(uses.record(use(made, digest, 2))).isEqualTo(Outcome.RECORDED);
        assertThat(other.record(use(made, digest, 3))).as("a second instance sees the first one's claim").isEqualTo(Outcome.REPLAY);
        assertThat(other.used(made.publicKeyHash(), digest)).isTrue();
    }

    // ------------------------------------------------------------------------------------------ challenge claims

    @Test
    void aNonceIsClaimedOnceUntilItExpires() {
        ChallengeClaims claims = new JdbcChallengeClaims(dataSource);
        Instant now = Instant.parse("2026-10-15T12:00:00Z");
        Duration ttl = Duration.ofSeconds(360);

        assertThat(claims.claim("nonce-1", now, ttl)).isTrue();
        assertThat(claims.claim("nonce-1", now.plusSeconds(5), ttl)).isFalse();
        assertThat(claims.claim("nonce-2", now, ttl)).as("another nonce").isTrue();
        assertThat(claims.claim("nonce-1", now.plusSeconds(360), ttl)).as("after its claim expired").isTrue();
    }

    @Test
    void aNonceWiderThanTheColumnIsRefusedNotStored() {
        ChallengeClaims claims = new JdbcChallengeClaims(dataSource);

        assertThat(claims.claim("n".repeat(65), Instant.now(), Duration.ofSeconds(60))).isFalse();
        assertThat(claims.claim("", Instant.now(), Duration.ofSeconds(60))).isFalse();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM datum_passkey_challenge", Integer.class)).isZero();
    }

    @Test
    void racingClaimsOfOneNonceSeeOneTrue() throws Exception {
        ChallengeClaims claims = new JdbcChallengeClaims(dataSource);
        Instant now = Instant.now();
        ExecutorService pool = Executors.newFixedThreadPool(8);
        try {
            List<Future<Boolean>> results = new java.util.ArrayList<>();
            for (int i = 0; i < 8; i++) {
                results.add(pool.submit(() -> claims.claim("raced", now, Duration.ofSeconds(60))));
            }
            long won = 0;
            for (Future<Boolean> result : results) {
                if (result.get()) {
                    won++;
                }
            }
            assertThat(won).isEqualTo(1);
        } finally {
            pool.shutdownNow();
        }
    }
}
