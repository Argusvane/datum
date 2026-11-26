package com.argusvane.datum.pdf;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.core.observation.DatumObservationNames;
import com.argusvane.datum.core.observation.DatumObservations;
import com.argusvane.datum.core.observation.RecordingObservations;
import com.argusvane.datum.timestamp.InMemoryTsaLog;
import com.argusvane.datum.timestamp.TimestampAuthority;
import com.argusvane.datum.timestamp.TsaKeyMaterial;
import com.argusvane.datum.timestamp.TsaTimeSource;
import java.time.Clock;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.Test;

/**
 * Each operation of the PDF service is one {@code datum.pdf} observation, its op from the start and, at the
 * end, its outcome, how the PDF was sealed and where its timestamp came from; the form's key only as a high-cardinality key
 * and only when it is a well-formed key; an operation another one calls is part of the outer one. The in-process
 * authority's token for the seal is its child.
 */
class PdfObservationTest {

    private final RecordingObservations recording = new RecordingObservations();

    private TimestampAuthority authority() {
        return new TimestampAuthority(TsaKeyMaterial.of(TestAssets.identity("tsa")), null, null, TsaTimeSource.of(Clock.systemUTC()),
            new InMemoryTsaLog(Clock.systemUTC()), List.of(), List.of(), recording.observations());
    }

    private List<RecordingObservations.Recorded> pdf() {
        return recording.named(DatumObservationNames.PDF);
    }

    @Test
    void aSealedSubmissionIsOneObservationWithItsSealTimestampAndFormAndTheTokenIsItsChild() {
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
        PdfService service = PdfService.builder().runtime(runtime.pdfRuntime()).signer(TestAssets.signer("p256")).seal(SealPreset.on())
            .timestamper(authority(), "site").observations(recording.observations()).build();

        PdfResult result = service.renderSubmission(SealingTest.definition(), SealingTest.values(), "en", "copy",
            PdfOptions.defaults().withFormKey("intake"));

        assertThat(result.signed()).isTrue();
        assertThat(pdf()).singleElement().satisfies(one -> {
            assertThat(one.low()).containsEntry("op", "render_submission").containsEntry("outcome", "ok").containsEntry("seal", "server")
                .containsEntry("timestamp", result.timestamped() ? "site" : "none");
            assertThat(one.high()).containsEntry("form", "intake");
            assertThat(one.low().keySet()).containsExactlyInAnyOrder("op", "outcome", "seal", "timestamp");
        });
        if (runtime.requests("complete").get(0).path("signing").has("timestamp")) {
            assertThat(recording.named(DatumObservationNames.TSA_ISSUE)).singleElement().satisfies(token -> {
                assertThat(token.parent()).isEqualTo(DatumObservationNames.PDF);
                assertThat(token.low("channel")).isEqualTo("sealing");
                assertThat(token.low("outcome")).isEqualTo("granted");
            });
        }
    }

    @Test
    void anOperationAnotherCallsIsPartOfItAndAFailureIsItsOutcome() {
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
        PdfService signing = PdfService.builder().runtime(runtime.pdfRuntime()).signer(TestAssets.signer("p256"))
            .observations(recording.observations()).build();
        signing.signSubmission(SealingTest.definition(), SealingTest.values(), "en", "copy", PdfOptions.defaults().withFormKey("not a key"));
        assertThat(pdf()).singleElement().satisfies(one -> {
            assertThat(one.low("op")).as("the render inside the sign is not one of its own").isEqualTo("sign_submission");
            assertThat(one.high()).as("a key that is not well-formed is never a tag").doesNotContainKey("form");
        });

        recording.clear();
        PdfService unsigned = PdfService.builder().runtime(runtime.pdfRuntime()).observations(recording.observations()).build();
        assertThatThrownBy(() -> unsigned.signSubmission(SealingTest.definition(), SealingTest.values(), "en", "copy", PdfOptions.defaults()))
            .isInstanceOf(PdfUnavailableException.class);
        assertThat(pdf()).singleElement().satisfies(one -> {
            assertThat(one.low()).containsEntry("outcome", "unavailable").containsEntry("seal", "none").containsEntry("timestamp", "none");
            assertThat(one.error()).isInstanceOf(PdfUnavailableException.class);
        });
    }

    /**
     * An observation that fails to start (an application's handler throwing in {@code onStart}, which
     * Micrometer does not catch) fails that operation only. The per-thread "observing" flag is set only inside the try
     * that clears it, so a failed start does not leave every later operation on that pooled thread unobserved.
     */
    @Test
    void anObservationThatFailsToStartLeavesTheNextOperationOnTheThreadObserved() {
        AtomicBoolean failOnce = new AtomicBoolean(true);
        DatumObservations real = recording.observations();
        DatumObservations flaky = (name, contextualName, low) -> {
            if (DatumObservationNames.PDF.equals(name) && failOnce.getAndSet(false)) {
                throw new IllegalStateException("handler failed in onStart");
            }
            return real.start(name, contextualName, low);
        };
        PdfService service = PdfService.builder().runtime(new ScriptedPdfRuntime().pdfRuntime()).observations(flaky).build();

        assertThatThrownBy(() -> service.renderSubmission(SealingTest.definition(), SealingTest.values(), "en", "copy", PdfOptions.defaults()))
            .isInstanceOf(IllegalStateException.class).hasMessage("handler failed in onStart");
        service.renderSubmission(SealingTest.definition(), SealingTest.values(), "en", "copy", PdfOptions.defaults());

        assertThat(pdf()).as("the next operation on the same thread is observed").singleElement()
            .satisfies(one -> assertThat(one.low()).containsEntry("op", "render_submission").containsEntry("outcome", "ok"));
    }
}
