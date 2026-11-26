package com.argusvane.datum.submissions.spring;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.submissions.receiver.ThrottledException;
import com.argusvane.datum.submissions.spi.ThrottleDecision;
import com.argusvane.datum.submissions.spi.ThrottleKey;
import com.argusvane.datum.submissions.spring.InMemorySubmissionThrottle.By;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import org.junit.jupiter.api.Test;

/** The fixed window: limit, Retry-After, expiry, key parts, and the bound on memory. */
class InMemorySubmissionThrottleTest {

    /** A clock the test moves. */
    static final class Moving extends Clock {

        private Instant now = Instant.parse("2026-10-15T12:00:00Z");

        void advance(Duration by) {
            now = now.plus(by);
        }

        @Override
        public java.time.ZoneId getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(java.time.ZoneId zone) {
            return this;
        }

        @Override
        public Instant instant() {
            return now;
        }
    }

    private final Moving clock = new Moving();

    private InMemorySubmissionThrottle throttle(int limit, List<By> by, int maxKeys) {
        return new InMemorySubmissionThrottle(limit, Duration.ofMinutes(1), by, clock, maxKeys);
    }

    private static ThrottleKey key(String ip, String form) {
        return new ThrottleKey(ip, form, null, ThrottleKey.Kind.SUBMIT);
    }

    @Test
    void theLimitPlusOneAttemptIsDeniedWithTheTimeLeftInTheWindow() {
        InMemorySubmissionThrottle throttle = throttle(3, List.of(By.IP, By.FORM), 100);
        ThrottleKey key = key("10.0.0.1", "contact");
        for (int i = 0; i < 3; i++) {
            assertThat(throttle.check(key)).isEqualTo(ThrottleDecision.ALLOW);
            throttle.record(key);
        }
        clock.advance(Duration.ofSeconds(20));
        ThrottleDecision decision = throttle.check(key);
        assertThat(decision).isInstanceOfSatisfying(ThrottleDecision.Deny.class,
            deny -> assertThat(deny.retryAfter()).isEqualTo(Duration.ofSeconds(40)));
        // Retry-After on the 429 is whole seconds, rounded up, at least one.
        assertThat(new ThrottledException(Duration.ofMillis(1500)).retryAfterSeconds()).isEqualTo(2);
        assertThat(new ThrottledException(Duration.ZERO).retryAfterSeconds()).isEqualTo(1);
        assertThat(new ThrottledException(Duration.ofSeconds(40)).responseHeaders()).containsEntry("Retry-After", "40");
    }

    @Test
    void checkDoesNotCountAndTheWindowOpensAgainWhenItEnds() {
        InMemorySubmissionThrottle throttle = throttle(1, List.of(By.IP), 100);
        ThrottleKey key = key("10.0.0.1", "a");
        for (int i = 0; i < 10; i++) {
            assertThat(throttle.check(key)).isEqualTo(ThrottleDecision.ALLOW);
        }
        throttle.record(key);
        assertThat(throttle.check(key)).isInstanceOf(ThrottleDecision.Deny.class);
        clock.advance(Duration.ofMinutes(1));
        assertThat(throttle.check(key)).isEqualTo(ThrottleDecision.ALLOW);
        throttle.record(key);
        assertThat(throttle.check(key)).isInstanceOf(ThrottleDecision.Deny.class);
    }

    @Test
    void theKeyIsOnlyTheConfiguredPartsAndTheRouteKind() {
        InMemorySubmissionThrottle byIp = throttle(1, List.of(By.IP), 100);
        byIp.record(key("10.0.0.1", "a"));
        assertThat(byIp.check(key("10.0.0.1", "b"))).isInstanceOf(ThrottleDecision.Deny.class);
        assertThat(byIp.check(key("10.0.0.2", "a"))).isEqualTo(ThrottleDecision.ALLOW);
        assertThat(byIp.check(new ThrottleKey("10.0.0.1", "a", null, ThrottleKey.Kind.VALIDATE))).isEqualTo(ThrottleDecision.ALLOW);

        InMemorySubmissionThrottle byIpAndForm = throttle(1, List.of(By.IP, By.FORM), 100);
        byIpAndForm.record(key("10.0.0.1", "a"));
        assertThat(byIpAndForm.check(key("10.0.0.1", "b"))).isEqualTo(ThrottleDecision.ALLOW);

        InMemorySubmissionThrottle byPrincipal = throttle(1, List.of(By.PRINCIPAL), 100);
        byPrincipal.record(new ThrottleKey("10.0.0.1", "a", "ada", ThrottleKey.Kind.SUBMIT));
        assertThat(byPrincipal.check(new ThrottleKey("10.9.9.9", "z", "ada", ThrottleKey.Kind.SUBMIT))).isInstanceOf(ThrottleDecision.Deny.class);
        assertThat(byPrincipal.check(new ThrottleKey("10.0.0.1", "a", "bob", ThrottleKey.Kind.SUBMIT))).isEqualTo(ThrottleDecision.ALLOW);
    }

    // ------------------------------------------------------------------------------------------ the address limit

    private InMemorySubmissionThrottle withAddressLimit(int limit, int addressLimit) {
        return new InMemorySubmissionThrottle(limit, java.util.Map.of(), addressLimit, Duration.ofMinutes(1), List.of(By.IP, By.FORM), clock, 100);
    }

    /** One request through the address limit as the routes apply it: null when allowed (and counted), else the refusal. */
    private static ThrottleDecision.Deny admit(InMemorySubmissionThrottle throttle, String address) {
        return com.argusvane.datum.submissions.spi.SubmissionThrottle.admitAddress(throttle, address);
    }

    @Test
    void theAddressLimitDefaultsToSixHundredTenTimesThePerFormLimit() {
        assertThat(InMemorySubmissionThrottle.DEFAULT_ADDRESS_LIMIT).isEqualTo(600);
        assertThat(com.argusvane.datum.springweb.spring.DatumProperties.Web.Throttle.DEFAULT_ADDRESS_LIMIT)
            .isEqualTo(InMemorySubmissionThrottle.DEFAULT_ADDRESS_LIMIT);
        InMemorySubmissionThrottle throttle = throttle(60, List.of(By.IP, By.FORM), 100);
        assertThat(throttle.addressLimit()).isEqualTo(600).isEqualTo(10 * throttle.limit());
        for (int i = 0; i < 600; i++) {
            assertThat(admit(throttle, "10.0.0.1")).as("request %d", i + 1).isNull();
        }
        assertThat(admit(throttle, "10.0.0.1")).isNotNull();
    }

    @Test
    void theAddressLimitPlusOneIsDeniedWithTheTimeLeftInTheWindowAndCheckDoesNotCount() {
        InMemorySubmissionThrottle throttle = withAddressLimit(60, 3);
        for (int i = 0; i < 10; i++) {
            assertThat(throttle.checkAddress("10.0.0.1")).isEqualTo(ThrottleDecision.ALLOW);
        }
        for (int i = 0; i < 3; i++) {
            assertThat(admit(throttle, "10.0.0.1")).isNull();
        }
        clock.advance(Duration.ofSeconds(25));
        ThrottleDecision.Deny deny = admit(throttle, "10.0.0.1");
        assertThat(deny).isNotNull();
        assertThat(deny.retryAfter()).isEqualTo(Duration.ofSeconds(35));
        // The 429 the routes answer with it is the per-form refusal's: flood, Retry-After in whole seconds.
        ThrottledException answer = new ThrottledException(deny.retryAfter());
        assertThat(answer.httpStatus()).isEqualTo(429);
        assertThat(answer.code()).isEqualTo("flood");
        assertThat(answer.responseHeaders()).containsEntry("Retry-After", "35");
        clock.advance(Duration.ofSeconds(35));
        assertThat(admit(throttle, "10.0.0.1")).as("a new window").isNull();
    }

    @Test
    void zeroKeepsNoAddressLimitAndCountsNothing() {
        InMemorySubmissionThrottle throttle = withAddressLimit(60, 0);
        assertThat(throttle.addressLimit()).isZero();
        for (int i = 0; i < 1000; i++) {
            assertThat(admit(throttle, "10.0.0.1")).isNull();
        }
        assertThat(throttle.size()).as("no window opened").isZero();
        assertThatThrownBy(() -> withAddressLimit(60, -1)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void theAddressWindowAndThePerFormWindowsNeverShareACount() {
        InMemorySubmissionThrottle throttle = new InMemorySubmissionThrottle(2, java.util.Map.of(), 3, Duration.ofMinutes(1), List.of(By.IP), clock, 100);
        ThrottleKey key = key("10.0.0.1", "contact");
        throttle.record(key);
        throttle.record(key);
        assertThat(throttle.check(key)).as("the per-form window is full").isInstanceOf(ThrottleDecision.Deny.class);
        assertThat(throttle.checkAddress("10.0.0.1")).as("the address window has counted nothing").isEqualTo(ThrottleDecision.ALLOW);
        for (int i = 0; i < 3; i++) {
            assertThat(admit(throttle, "10.0.0.1")).isNull();
        }
        assertThat(admit(throttle, "10.0.0.1")).as("the address window is full").isNotNull();
        assertThat(throttle.check(key("10.0.0.1", "other"))).as("by ip: still the per-form window's own count").isInstanceOf(ThrottleDecision.Deny.class);
        assertThat(throttle.check(new ThrottleKey("10.0.0.1", "contact", null, ThrottleKey.Kind.VALIDATE)))
            .as("another kind's per-form window is untouched by the address window").isEqualTo(ThrottleDecision.ALLOW);
        assertThat(throttle.size()).isEqualTo(2);
    }

    @Test
    void theAddressLimitCountsAnIpv6ClientByItsSlash64AndAMappedAddressAsItsIpv4() {
        InMemorySubmissionThrottle throttle = withAddressLimit(60, 2);
        assertThat(admit(throttle, "2001:db8:1:2::1")).isNull();
        assertThat(admit(throttle, "[2001:db8:1:2:ffff::9]:8443")).isNull();
        assertThat(admit(throttle, "2001:db8:1:2:abcd::77")).as("a third address of one /64").isNotNull();
        assertThat(admit(throttle, "2001:db8:1:3::1")).as("another /64").isNull();
        assertThat(admit(throttle, "::ffff:198.51.100.4")).isNull();
        assertThat(admit(throttle, "198.51.100.4")).isNull();
        assertThat(admit(throttle, "[198.51.100.4:4711]")).as("the mapped, the bare and the bracketed forms are one address").isNotNull();
    }

    @Test
    void aRequestWithNoClientAddressIsNotCountedByTheAddressLimit() {
        InMemorySubmissionThrottle throttle = withAddressLimit(60, 1);
        for (int i = 0; i < 5; i++) {
            assertThat(admit(throttle, null)).isNull();
            assertThat(admit(throttle, "")).isNull();
        }
        assertThat(throttle.size()).isZero();
        assertThat(com.argusvane.datum.submissions.spi.SubmissionThrottle.admitAddress(null, "10.0.0.1")).as("no throttle").isNull();
    }

    @Test
    void addressWindowsShareTheBoundOnWindows() {
        InMemorySubmissionThrottle throttle = new InMemorySubmissionThrottle(5, java.util.Map.of(), 5, Duration.ofMinutes(1), List.of(By.IP), clock, 32);
        for (int i = 0; i < 500; i++) {
            clock.advance(Duration.ofMillis(1));
            admit(throttle, "10.3." + (i / 250) + "." + (i % 250));
            throttle.record(key("10.4." + (i / 250) + "." + (i % 250), "a"));
            assertThat(throttle.size()).isLessThanOrEqualTo(32);
        }
    }

    @Test
    void theMapStaysBoundedAndExpiredWindowsAreForgottenFirst() {
        InMemorySubmissionThrottle throttle = throttle(5, List.of(By.IP), 32);
        for (int i = 0; i < 32; i++) {
            throttle.record(key("10.0.0." + i, "a"));
        }
        assertThat(throttle.size()).isEqualTo(32);
        clock.advance(Duration.ofMinutes(2));
        throttle.record(key("10.1.0.1", "a"));
        assertThat(throttle.size()).isEqualTo(1);

        for (int i = 0; i < 500; i++) {
            clock.advance(Duration.ofMillis(1));
            throttle.record(key("10.2." + (i / 250) + "." + (i % 250), "a"));
            assertThat(throttle.size()).isLessThanOrEqualTo(32);
        }
    }

    /**
     * One address cannot reset its own full window by naming many other forms (an unknown form id still opens a window):
     * when the map is full the caller holding the most windows gives up its cheapest ones, so the full window stays, and so
     * does every other address's.
     */
    @Test
    void oneAddressNamingManyFormsCannotEvictItsOwnFullWindowOrAnothers() {
        InMemorySubmissionThrottle throttle = throttle(5, List.of(By.IP, By.FORM), 64);
        ThrottleKey real = key("10.0.0.1", "contact");
        ThrottleKey neighbour = key("10.0.0.2", "contact");
        for (int i = 0; i < 5; i++) {
            throttle.record(real);
            throttle.record(neighbour);
        }
        assertThat(throttle.check(real)).isInstanceOf(ThrottleDecision.Deny.class);
        assertThat(throttle.check(neighbour)).isInstanceOf(ThrottleDecision.Deny.class);
        for (int i = 0; i < 10_000; i++) {
            clock.advance(Duration.ofMillis(1));
            ThrottleKey sprayed = key("10.0.0.1", "form-" + i);
            assertThat(throttle.check(sprayed)).isEqualTo(ThrottleDecision.ALLOW);
            throttle.record(sprayed);
            assertThat(throttle.size()).isLessThanOrEqualTo(64);
        }
        assertThat(throttle.check(real)).as("the full window is still counted").isInstanceOf(ThrottleDecision.Deny.class);
        assertThat(throttle.check(neighbour)).as("another address keeps its window").isInstanceOf(ThrottleDecision.Deny.class);
        // A route kind is no way around it either: the same address's validity checks share its caller.
        for (int i = 0; i < 1_000; i++) {
            throttle.record(new ThrottleKey("10.0.0.1", "form-v" + i, null, ThrottleKey.Kind.VALIDATE));
        }
        assertThat(throttle.check(real)).isInstanceOf(ThrottleDecision.Deny.class);
        // The windows still end with their time.
        clock.advance(Duration.ofMinutes(1));
        assertThat(throttle.check(real)).isEqualTo(ThrottleDecision.ALLOW);
    }

    /**
     * Many addresses of one window each: the fewest attempts go first, then the newest (a flood from many addresses opens
     * the newest windows, so the counters already running keep counting), and the map stays bounded.
     */
    @Test
    void amongEqualCallersTheCheapestWindowGoesFirst() {
        // A limit of one: every window held is full, so the one check that allows names the window that was dropped.
        InMemorySubmissionThrottle throttle = throttle(1, List.of(By.IP, By.FORM), 16);
        ThrottleKey busy = key("10.9.0.1", "contact");
        for (int i = 0; i < 4; i++) {
            throttle.record(busy);
        }
        for (int i = 0; i < 15; i++) {
            clock.advance(Duration.ofMillis(1));
            throttle.record(key("10.1.0." + i, "contact"));
        }
        assertThat(throttle.size()).isEqualTo(16);
        clock.advance(Duration.ofMillis(1));
        throttle.record(key("10.2.0.1", "contact"));
        assertThat(throttle.size()).isEqualTo(16);
        assertThat(throttle.check(key("10.1.0.14", "contact"))).as("the newest of the cheapest windows went").isEqualTo(ThrottleDecision.ALLOW);
        for (int i = 0; i < 14; i++) {
            assertThat(throttle.check(key("10.1.0." + i, "contact"))).as("10.1.0." + i + " keeps its window").isInstanceOf(ThrottleDecision.Deny.class);
        }
        assertThat(throttle.check(key("10.2.0.1", "contact"))).as("the window that made room stays").isInstanceOf(ThrottleDecision.Deny.class);
        throttle.record(busy);
        assertThat(throttle.check(busy)).as("the window with the most attempts stays").isInstanceOf(ThrottleDecision.Deny.class);
    }

    /** Windows opened at one instant still have an order, the order they opened in: the last opened goes first. */
    @Test
    void windowsOpenedAtOneInstantGoInTheOrderTheyOpenedNewestFirst() {
        InMemorySubmissionThrottle callers = throttle(1, List.of(By.IP, By.FORM), 16);
        for (int i = 0; i < 16; i++) {
            callers.record(key("10.1.0." + i, "contact"));
        }
        callers.record(key("10.2.0.1", "contact"));
        assertThat(callers.size()).isEqualTo(16);
        assertThat(callers.check(key("10.1.0.15", "contact"))).as("the last caller's window went").isEqualTo(ThrottleDecision.ALLOW);
        for (int i = 0; i < 15; i++) {
            assertThat(callers.check(key("10.1.0." + i, "contact"))).as("10.1.0." + i + " keeps its window").isInstanceOf(ThrottleDecision.Deny.class);
        }

        // Within one caller as well: its windows of one instant go last opened first.
        InMemorySubmissionThrottle oneCaller = throttle(1, List.of(By.IP, By.FORM), 16);
        for (int i = 0; i < 16; i++) {
            oneCaller.record(key("10.0.0.1", "form-" + i));
        }
        oneCaller.record(key("10.0.0.2", "contact"));
        assertThat(oneCaller.check(key("10.0.0.1", "form-15"))).as("the caller's last window went").isEqualTo(ThrottleDecision.ALLOW);
        for (int i = 0; i < 15; i++) {
            assertThat(oneCaller.check(key("10.0.0.1", "form-" + i))).as("form-" + i + " keeps its window").isInstanceOf(ThrottleDecision.Deny.class);
        }
        assertThat(oneCaller.check(key("10.0.0.2", "contact"))).isInstanceOf(ThrottleDecision.Deny.class);
    }

    /**
     * Padding the sprayed windows up to the limit does not reach the real one: among one caller's windows as full as each
     * other the newest goes first, and the real window is the oldest.
     */
    @Test
    void aCallerThatPadsSprayedWindowsToTheLimitLosesThoseNotItsOldestFullWindow() {
        InMemorySubmissionThrottle throttle = throttle(3, List.of(By.IP, By.FORM), 16);
        ThrottleKey real = key("10.0.0.1", "contact");
        ThrottleKey neighbour = key("10.0.0.2", "contact");
        for (int i = 0; i < 3; i++) {
            throttle.record(real);
            throttle.record(neighbour);
        }
        for (int i = 0; i < 200; i++) {
            clock.advance(Duration.ofMillis(1));
            ThrottleKey sprayed = key("10.0.0.1", "form-" + i);
            for (int n = 0; n < 3; n++) {
                throttle.record(sprayed);
            }
            assertThat(throttle.size()).isLessThanOrEqualTo(16);
        }
        assertThat(throttle.check(real)).as("the oldest full window is still counted").isInstanceOf(ThrottleDecision.Deny.class);
        assertThat(throttle.check(neighbour)).as("another address keeps its window").isInstanceOf(ThrottleDecision.Deny.class);
        assertThat(throttle.check(key("10.0.0.1", "form-199"))).as("the last sprayed window stays until another makes room")
            .isInstanceOf(ThrottleDecision.Deny.class);
    }

    /** Two addresses of one IPv6 /64 share a window and a caller; a mapped address shares its IPv4 address's window. */
    @Test
    void anIpv6ClientIsCountedByItsSlash64() {
        InMemorySubmissionThrottle byIp = throttle(2, List.of(By.IP), 100);
        byIp.record(key("2001:db8:1:2::1", "a"));
        byIp.record(key("2001:db8:1:2:ffff:ffff:ffff:ffff", "a"));
        assertThat(byIp.check(key("2001:DB8:1:2::abcd", "a"))).isInstanceOf(ThrottleDecision.Deny.class);
        assertThat(byIp.check(key("2001:db8:1:3::1", "a"))).isEqualTo(ThrottleDecision.ALLOW);
        byIp.record(key("10.0.0.1", "a"));
        byIp.record(key("::ffff:10.0.0.1", "a"));
        assertThat(byIp.check(key("10.0.0.1", "a"))).isInstanceOf(ThrottleDecision.Deny.class);

        // Rotating through the /64 is one caller: its single-attempt windows go first, its full window and a neighbour's stay.
        InMemorySubmissionThrottle byIpAndForm = throttle(3, List.of(By.IP, By.FORM), 16);
        ThrottleKey real = key("2001:db8:1:2::1", "contact");
        ThrottleKey neighbour = key("2001:db8:9:9::1", "contact");
        for (int i = 0; i < 3; i++) {
            byIpAndForm.record(real);
            byIpAndForm.record(neighbour);
        }
        for (int i = 0; i < 500; i++) {
            clock.advance(Duration.ofMillis(1));
            byIpAndForm.record(key("2001:db8:1:2::" + Integer.toHexString(i + 2), "form-" + i));
        }
        assertThat(byIpAndForm.check(key("2001:db8:1:2::beef", "contact"))).isInstanceOf(ThrottleDecision.Deny.class);
        assertThat(byIpAndForm.check(neighbour)).isInstanceOf(ThrottleDecision.Deny.class);
    }

    @Test
    void badSettingsAreRefused() {
        assertThatThrownBy(() -> throttle(0, List.of(By.IP), 100)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new InMemorySubmissionThrottle(1, Duration.ZERO, List.of(), clock, 100)).isInstanceOf(IllegalArgumentException.class);
        assertThat(By.of("IP")).isEqualTo(By.IP);
        assertThat(By.of("nonsense")).isNull();
    }
}
