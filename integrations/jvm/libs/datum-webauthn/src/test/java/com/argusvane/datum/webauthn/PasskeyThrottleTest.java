package com.argusvane.datum.webauthn;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatNullPointerException;

import com.argusvane.datum.webauthn.web.PasskeyThrottle;
import java.time.Duration;
import org.junit.jupiter.api.Test;

/** The typed answer: allow and deny are different types, so a zero wait can never read as "allowed". */
class PasskeyThrottleTest {

    @Test
    void noneAllows() {
        assertThat(PasskeyThrottle.NONE.check("1.2.3.4", "petition", "ada")).isSameAs(PasskeyThrottle.Decision.ALLOW);
    }

    @Test
    void aZeroWaitIsStillADenial() {
        PasskeyThrottle.Decision decision = new PasskeyThrottle.Decision.Deny(Duration.ZERO);
        assertThat(decision).isNotEqualTo(PasskeyThrottle.Decision.ALLOW).isInstanceOf(PasskeyThrottle.Decision.Deny.class);
    }

    @Test
    void aNegativeWaitReadsAsZeroAndNoWaitIsRefused() {
        assertThat(new PasskeyThrottle.Decision.Deny(Duration.ofSeconds(-3)).retryAfter()).isEqualTo(Duration.ZERO);
        assertThatNullPointerException().isThrownBy(() -> new PasskeyThrottle.Decision.Deny(null));
    }
}
