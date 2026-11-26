package com.argusvane.datum.core.observation;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatIllegalArgumentException;

import com.argusvane.datum.core.DefinitionTooDeepException;
import com.argusvane.datum.core.ProgramUnavailableException;
import com.argusvane.datum.core.hooks.HookRefusedException;
import io.micrometer.observation.Observation;
import io.micrometer.observation.ObservationRegistry;
import java.util.Arrays;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Datum's observations on Micrometer: each is an {@link Observation} with its scope open, so the observation
 * current on the thread is its parent and what it encloses is its child; a registry's predicate switches a name off; a no-op
 * registry is no observation at all; the names stay apart from Datum's meters.
 */
class MicrometerObservationsTest {

    @Test
    void anObservationIsAChildOfTheCurrentOneAndTheParentOfWhatItEncloses() {
        RecordingObservations recording = new RecordingObservations();
        DatumObservations observations = recording.observations();
        Observation request = Observation.start("http.server.requests", recording.registry());
        try (Observation.Scope ignored = request.openScope()) {
            try (DatumObservation outer = observations.start(DatumObservationNames.SUBMISSION, "datum submission", DatumObservationNames.MODE, "submit")) {
                outer.highCardinality(DatumObservationNames.FORM, "contact").lowCardinality(DatumObservationNames.OUTCOME, "accepted");
                try (DatumObservation inner = observations.start(DatumObservationNames.SANDBOX_RUN, "datum sandbox run validate")) {
                    inner.lowCardinality(DatumObservationNames.OUTCOME, "ok");
                }
            }
        }
        request.stop();
        RecordingObservations.Recorded run = recording.named(DatumObservationNames.SANDBOX_RUN).get(0);
        RecordingObservations.Recorded submission = recording.named(DatumObservationNames.SUBMISSION).get(0);
        assertThat(run.parent()).isEqualTo(DatumObservationNames.SUBMISSION);
        assertThat(submission.parent()).as("under the request's observation").isEqualTo("http.server.requests");
        assertThat(submission.low()).containsEntry("mode", "submit").containsEntry("outcome", "accepted");
        assertThat(submission.high()).containsEntry("form", "contact");
        assertThat(submission.low()).as("a form key is never a low-cardinality key").doesNotContainKey("form");
        assertThat(recording.registry().getCurrentObservation()).as("every scope closed").isNull();
    }

    @Test
    void theFailureIsRecordedAndCloseIsIdempotent() {
        RecordingObservations recording = new RecordingObservations();
        DatumObservation observation = recording.observations().start(DatumObservationNames.PDF, "datum pdf render");
        IllegalStateException failure = new IllegalStateException("x");
        observation.error(failure).lowCardinality(DatumObservationNames.OUTCOME, null);
        observation.close();
        observation.close();
        assertThat(recording.stopped()).singleElement().satisfies(one -> {
            assertThat(one.error()).isSameAs(failure);
            assertThat(one.low()).containsEntry("outcome", "none");
        });
    }

    @Test
    void aPredicateSwitchesANameOffAndANoopRegistryIsNone() {
        RecordingObservations recording = new RecordingObservations();
        // What Spring Boot's management.observations.enable.datum.sandbox=false installs.
        recording.registry().observationConfig().observationPredicate((name, context) -> !name.startsWith("datum.sandbox"));
        recording.observations().start(DatumObservationNames.SANDBOX_RUN, "x").close();
        recording.observations().start(DatumObservationNames.SUBMISSION, "y").close();
        assertThat(recording.stopped()).extracting(RecordingObservations.Recorded::name).containsExactly(DatumObservationNames.SUBMISSION);

        assertThat(MicrometerObservations.of(ObservationRegistry.NOOP)).isSameAs(DatumObservations.none());
        assertThat(DatumObservations.none().enabled()).isFalse();
        assertThat(recording.observations().enabled()).isTrue();
        assertThatIllegalArgumentException().isThrownBy(() -> recording.observations().start("datum.pdf", "x", "op"));
    }

    @Test
    void theOutcomeOfAFailureIsAFixedWord() {
        // A subclass with its own fixed outcome words (the sandbox's refusals) names one through the hook.
        assertThat(DatumObservations.outcomeOf(new com.argusvane.datum.core.DatumException("x.busy", 503, "all taken") {
            @Override
            public String observationOutcome() {
                return "busy";
            }
        })).isEqualTo("busy");
        assertThat(DatumObservations.outcomeOf(new ProgramUnavailableException("down"))).isEqualTo("unavailable");
        assertThat(DatumObservations.outcomeOf(new DefinitionTooDeepException(32, "deep"))).isEqualTo("too_deep");
        assertThat(DatumObservations.outcomeOf(HookRefusedException.forbidden("no.way", "No."))).isEqualTo("forbidden");
        assertThat(DatumObservations.outcomeOf(new com.argusvane.datum.core.DatumException("x.y", 400, "m"))).isEqualTo("refused");
        assertThat(DatumObservations.outcomeOf(new IllegalStateException("anything at all"))).isEqualTo("error");
    }

    /**
     * Micrometer's meter handler registers a timer {@code <name>} and a long task timer {@code <name>.active} per observation:
     * none of Datum's observation names may make a meter Datum already registers.
     */
    @Test
    void theObservationNamesStayApartFromDatumsMeters() {
        List<String> meters = List.of("datum.runs", "datum.runs.wait", "datum.runs.active", "datum.runs.slots", "datum.runs.rejected",
            "datum.submissions", "datum.throttled");
        for (DatumObservationDocumentation documented : DatumObservationDocumentation.values()) {
            assertThat(meters).as(documented.getName()).doesNotContain(documented.getName(), documented.getName() + ".active");
            assertThat(documented.getName()).startsWith("datum.").doesNotStartWith("datum.runs");
            assertThat(Arrays.stream(documented.getLowCardinalityKeyNames()).map(key -> key.asString()))
                .as("the form key is high-cardinality only").doesNotContain(DatumObservationNames.FORM);
        }
        assertThat(DatumObservationDocumentation.values()).extracting(DatumObservationDocumentation::getName).containsExactly(
            DatumObservationNames.SANDBOX_RUN, DatumObservationNames.PDF_RUN, DatumObservationNames.PDF, DatumObservationNames.SUBMISSION,
            DatumObservationNames.TSA_ISSUE);
    }
}
