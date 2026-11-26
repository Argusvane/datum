package com.argusvane.datum.webauthn;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Optional;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

/**
 * Registration challenges: signed, bound to what they are for, time-limited, single-use.
 */
class PasskeyChallengesTest {

    private static final byte[] SECRET = "a host secret of thirty-two bytes!!".getBytes(StandardCharsets.UTF_8);
    private static final JsonMapper JSON = JsonMapper.builder().build();

    private final MutableClock clock = MutableClock.now();
    private final PasskeyChallenges challenges = new PasskeyChallenges(SECRET, clock, new InMemoryChallengeClaims());

    @Test
    void aChallengeIsClaimedOnceForWhatItWasIssuedFor() {
        PasskeyChallenges.IssuedChallenge issued = challenges.issue("register", "petition", "", "aGFuZGxl");
        assertThat(issued.expires()).isEqualTo(clock.instant().getEpochSecond() + 300);
        // A token for another form, another account or another purpose is refused, and claims nothing.
        assertThat(challenges.claim(issued.token(), "register", "other", "")).isEmpty();
        assertThat(challenges.claim(issued.token(), "register", "petition", "5")).isEmpty();
        assertThat(challenges.claim(issued.token(), "register:amend", "petition", "")).isEmpty();
        Optional<PasskeyChallenges.ClaimedChallenge> claimed = challenges.claim(issued.token(), "register", "petition", "");
        assertThat(claimed).isPresent();
        assertThat(claimed.get().challenge()).isEqualTo(Base64Url.decode(issued.challenge()));
        assertThat(claimed.get().userHandle()).isEqualTo("aGFuZGxl");
        // Used.
        assertThat(challenges.claim(issued.token(), "register", "petition", "")).isEmpty();
    }

    @Test
    void aChallengeHoldsThreeHundredSeconds() {
        PasskeyChallenges.IssuedChallenge first = challenges.issue("register", "petition", "", "h");
        PasskeyChallenges.IssuedChallenge second = challenges.issue("register", "petition", "", "h");
        clock.advance(Duration.ofSeconds(300));
        assertThat(challenges.claim(first.token(), "register", "petition", "")).isPresent();
        clock.advance(Duration.ofSeconds(1));
        assertThat(challenges.claim(second.token(), "register", "petition", "")).isEmpty();
    }

    @Test
    void anIssueTimeAheadOfTheClockIsTakenUpToSixtySeconds() {
        PasskeyChallenges.IssuedChallenge issued = challenges.issue("register", "petition", "", "h");
        clock.advance(Duration.ofSeconds(-60));
        assertThat(challenges.claim(issued.token(), "register", "petition", "")).isPresent();
        PasskeyChallenges.IssuedChallenge later = challenges.issue("register", "petition", "", "h");
        clock.advance(Duration.ofSeconds(-61));
        assertThat(challenges.claim(later.token(), "register", "petition", "")).isEmpty();
    }

    @Test
    void anEditedTokenYieldsAnotherChallenge() {
        PasskeyChallenges.IssuedChallenge issued = challenges.issue("register", "petition", "", "h");
        ObjectNode fields = (ObjectNode) JSON.readTree(Base64Url.decode(issued.token()));
        fields.put("h", "another handle");
        fields.put("n", "another nonce");
        String edited = Base64Url.encode(JSON.writeValueAsString(fields).getBytes(StandardCharsets.UTF_8));
        Optional<PasskeyChallenges.ClaimedChallenge> claimed = challenges.claim(edited, "register", "petition", "");
        // The token is not signed itself: what it yields is a challenge the authenticator never signed.
        assertThat(claimed).isPresent();
        assertThat(claimed.get().challenge()).isNotEqualTo(Base64Url.decode(issued.challenge()));
        // Members in another order are the same fields: the HMAC is over them in issue order.
        ObjectNode reordered = JSON.createObjectNode();
        ObjectNode original = (ObjectNode) JSON.readTree(Base64Url.decode(issued.token()));
        for (String name : new String[] {"t", "n", "h", "u", "f", "p"}) {
            reordered.set(name, original.get(name));
        }
        Optional<PasskeyChallenges.ClaimedChallenge> same = challenges.claim(
            Base64Url.encode(JSON.writeValueAsString(reordered).getBytes(StandardCharsets.UTF_8)), "register", "petition", "");
        assertThat(same).isPresent();
        assertThat(same.get().challenge()).isEqualTo(Base64Url.decode(issued.challenge()));
    }

    @Test
    void anotherSecretMakesAnotherChallenge() {
        PasskeyChallenges.IssuedChallenge issued = challenges.issue("register", "petition", "", "h");
        PasskeyChallenges other = new PasskeyChallenges("another host secret, thirty-two bytes".getBytes(StandardCharsets.UTF_8), clock,
            new InMemoryChallengeClaims());
        assertThat(other.claim(issued.token(), "register", "petition", "").orElseThrow().challenge())
            .isNotEqualTo(Base64Url.decode(issued.challenge()));
    }

    @Test
    void tokensOfAnotherShapeAreRefused() {
        for (String token : new String[] {"", "!!", Base64Url.encode("not json".getBytes(StandardCharsets.UTF_8)),
            Base64Url.encode("[]".getBytes(StandardCharsets.UTF_8)),
            json("{\"p\":\"register\",\"f\":\"petition\",\"u\":\"\",\"h\":\"h\",\"n\":\"n\"}"),
            json("{\"p\":\"register\",\"f\":\"petition\",\"u\":\"\",\"h\":\"h\",\"n\":\"n\",\"t\":\"" + clock.instant().getEpochSecond() + "\"}"),
            json("{\"p\":\"register\",\"f\":\"petition\",\"u\":\"\",\"h\":\"h\",\"n\":\"n\",\"t\":" + clock.instant().getEpochSecond() + ".5}"),
            json("{\"p\":\"register\",\"f\":\"petition\",\"u\":0,\"h\":\"h\",\"n\":\"n\",\"t\":" + clock.instant().getEpochSecond() + "}"),
            json("{\"p\":\"register\",\"f\":\"petition\",\"u\":\"\",\"h\":1,\"n\":\"n\",\"t\":" + clock.instant().getEpochSecond() + "}"),
            json("{\"p\":\"register\",\"f\":\"petition\",\"u\":\"\",\"h\":\"h\",\"n\":\"n\",\"t\":99999999999999999999999}")}) {
            assertThat(challenges.claim(token, "register", "petition", "")).as(token).isEmpty();
        }
        assertThat(challenges.claim(null, "register", "petition", "")).isEmpty();
    }

    @Test
    void theSecretMustBeLongEnough() {
        assertThatThrownBy(() -> new PasskeyChallenges(new byte[31], clock, new InMemoryChallengeClaims()))
            .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void inMemoryClaimsExpire() {
        InMemoryChallengeClaims claims = new InMemoryChallengeClaims();
        assertThat(claims.claim("n", clock.instant(), Duration.ofSeconds(360))).isTrue();
        assertThat(claims.claim("n", clock.instant().plusSeconds(359), Duration.ofSeconds(360))).isFalse();
        assertThat(claims.claim("n", clock.instant().plusSeconds(360), Duration.ofSeconds(360))).isTrue();
    }

    private static String json(String text) {
        return Base64Url.encode(text.getBytes(StandardCharsets.UTF_8));
    }
}
