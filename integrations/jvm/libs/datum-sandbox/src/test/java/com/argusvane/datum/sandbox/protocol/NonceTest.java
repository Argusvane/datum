package com.argusvane.datum.sandbox.protocol;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;
import org.junit.jupiter.api.Test;

/** The run nonce: 16 random bytes as 32 lowercase hex, first on stdin. */
class NonceTest {

    @Test
    void thirtyTwoLowercaseHexAndFreshEachTime() {
        Set<String> seen = new HashSet<>();
        for (int i = 0; i < 200; i++) {
            String nonce = Nonce.generate();
            assertThat(nonce).matches("[0-9a-f]{32}");
            assertThat(seen.add(nonce)).isTrue();
        }
    }

    @Test
    void stdinIsTheNonceALineFeedThenTheJson() {
        byte[] stdin = Nonce.stdin(Fixtures.NONCE, "{\"x\":\"\u00e9\"}");
        assertThat(new String(stdin, StandardCharsets.UTF_8)).isEqualTo(Fixtures.NONCE + "\n{\"x\":\"\u00e9\"}");
        assertThat(stdin[32]).isEqualTo((byte) '\n');
    }

    /** run.js refuses anything else ("no run nonce"), so the host never sends it. */
    @Test
    void onlyANonceRunJsAcceptsIsSent() {
        for (String bad : new String[] {"0123456789ABCDEF0123456789abcdef", "0123", "0123456789abcdef0123456789abcdef0", "g".repeat(32)}) {
            assertThat(Nonce.isValid(bad)).as(bad).isFalse();
            assertThatThrownBy(() -> Nonce.stdin(bad, "{}")).isInstanceOf(IllegalArgumentException.class);
        }
    }
}
