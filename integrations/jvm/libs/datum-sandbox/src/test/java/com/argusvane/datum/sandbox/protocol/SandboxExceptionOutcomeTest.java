package com.argusvane.datum.sandbox.protocol;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.core.observation.DatumObservations;
import java.util.Locale;
import org.junit.jupiter.api.Test;

/**
 * The sandbox's side of the observation outcome hook (datum-core's DatumException.observationOutcome): a run that gave no answer is
 * observed as its reason, one fixed word per {@link SandboxException.Reason}, so the {@code outcome} key stays low-cardinality.
 */
class SandboxExceptionOutcomeTest {

    @Test
    void aSandboxFailureIsObservedAsItsReason() {
        assertThat(DatumObservations.outcomeOf(new SandboxException(SandboxException.Reason.BUSY, "all taken"))).isEqualTo("busy");
        for (SandboxException.Reason reason : SandboxException.Reason.values()) {
            SandboxException failure = new SandboxException(reason, "m");
            assertThat(failure.observationOutcome()).isEqualTo(reason.name().toLowerCase(Locale.ROOT));
            assertThat(DatumObservations.outcomeOf(failure)).isEqualTo(failure.observationOutcome());
        }
    }
}
