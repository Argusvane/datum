package com.argusvane.datum.core;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

/** The start refusal says what is wrong and what to do, as separate statements. */
class DatumConfigurationExceptionTest {

    @Test
    void theMessageIsTheProblemAndTheActionIsWhatWasGiven() {
        DatumConfigurationException refusal = new DatumConfigurationException("datum.web.api.path", "datum.web.api.path is empty.", "Set it to /api.");
        assertThat(refusal).isInstanceOf(IllegalArgumentException.class);
        assertThat(refusal.getMessage()).isEqualTo("datum.web.api.path is empty.");
        assertThat(refusal.problem()).isEqualTo(refusal.getMessage());
        assertThat(refusal.property()).isEqualTo("datum.web.api.path");
        assertThat(refusal.action()).isEqualTo("Set it to /api.");
    }

    @Test
    void withoutAnActionTheAdviceNamesTheSetting() {
        assertThat(new DatumConfigurationException("datum.tsa.flood.window", "bad").action()).contains("datum.tsa.flood.window");
        assertThat(new DatumConfigurationException(null, "bad").action()).isNotBlank();
        RuntimeException cause = new RuntimeException("x");
        assertThat(new DatumConfigurationException("datum.p", "bad", cause).getCause()).isSameAs(cause);
    }
}
