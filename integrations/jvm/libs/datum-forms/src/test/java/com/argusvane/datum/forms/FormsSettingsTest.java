package com.argusvane.datum.forms;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Duration;
import java.util.List;
import org.junit.jupiter.api.Test;

/** The settings: the too-costly memory and the two Cache-Control values, with their defaults and checks. */
class FormsSettingsTest {

    private static FormsSettings with(Duration costly, String definition, String snapshot) {
        return new FormsSettings(List.of(), 5, 5, Duration.ofSeconds(1), 1, costly, definition, snapshot);
    }

    @Test
    void theDefaultsAreTheOnesTheScanNamed() {
        FormsSettings defaults = FormsSettings.defaults();
        assertThat(defaults.tooCostlyMemory()).isEqualTo(Duration.ofSeconds(300));
        assertThat(defaults.definitionCacheControl()).isEqualTo("no-store");
        assertThat(defaults.snapshotCacheControl()).isEqualTo("no-store");
        assertThat(with(null, null, null)).isEqualTo(new FormsSettings(List.of(), 5, 5, Duration.ofSeconds(1), 1, Duration.ofSeconds(300),
            "no-store", "no-store"));
    }

    @Test
    void theTooCostlyMemoryIsOneSecondToOneHour() {
        assertThat(with(Duration.ofSeconds(1), null, null).tooCostlyMemory()).isEqualTo(Duration.ofSeconds(1));
        assertThat(with(Duration.ofHours(1), null, null).tooCostlyMemory()).isEqualTo(Duration.ofHours(1));
        for (Duration bad : new Duration[] {Duration.ZERO, Duration.ofMillis(900), Duration.ofSeconds(3601)}) {
            assertThatThrownBy(() -> with(bad, null, null)).as(bad.toString()).isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("datum.forms.too-costly-memory");
        }
    }

    @Test
    void aCacheControlValueIsNotBlankAndHasNoLineBreak() {
        assertThat(with(null, " private, max-age=60 ", "no-cache").definitionCacheControl()).isEqualTo("private, max-age=60");
        assertThatThrownBy(() -> with(null, " ", null)).isInstanceOf(IllegalArgumentException.class).hasMessageContaining("datum.forms.cache.definition");
        assertThatThrownBy(() -> with(null, null, "public\r\nSet-Cookie: x=1")).isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("datum.forms.cache.snapshot");
    }
}
