package com.argusvane.datum.web;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Duration;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** The busy answer's Retry-After setting: its default, bounds and the message that names the property. */
class WebSettingsTest {

    @Test
    void theBusyRetryAfterDefaultsToFiveSeconds() {
        assertThat(WebSettings.defaults().api().busyRetryAfter()).isEqualTo(Duration.ofSeconds(5));
        assertThat(new WebSettings.Api("/api", 1024, false, Map.of(), null).busyRetryAfter()).isEqualTo(WebSettings.Api.DEFAULT_BUSY_RETRY_AFTER);
    }

    @Test
    void aValueTheHeaderCannotCarryStopsTheStartNamingTheProperty() {
        assertThat(new WebSettings.Api("/api", 1024, false, Map.of(), Duration.ofHours(1)).busyRetryAfter()).isEqualTo(Duration.ofHours(1));
        for (Duration bad : new Duration[] {Duration.ZERO, Duration.ofMillis(1500), Duration.ofSeconds(-3), Duration.ofSeconds(3601)}) {
            assertThatThrownBy(() -> new WebSettings.Api("/api", 1024, false, Map.of(), bad)).as(bad.toString())
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("datum.web.api.busy-retry-after");
        }
    }
}
