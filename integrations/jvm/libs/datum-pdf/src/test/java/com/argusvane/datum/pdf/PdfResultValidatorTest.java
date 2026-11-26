package com.argusvane.datum.pdf;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.core.hooks.HookFindings;
import com.argusvane.datum.core.hooks.HookProblem;
import com.argusvane.datum.core.hooks.HookRefusedException;
import com.argusvane.datum.web.error.ErrorItem;
import com.argusvane.datum.web.error.ErrorMapper;
import com.argusvane.datum.web.error.ErrorResponse;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.node.ObjectNode;

/**
 * The PDF side of the hook model: {@link PdfResultValidator}s judge every PDF the program made before its
 * bytes leave, in order and all of them; their errors refuse before any seal or event, their warnings ride in the
 * result, and one that throws fails the request.
 */
class PdfResultValidatorTest {

    private static PdfService service(ScriptedPdfRuntime runtime, List<PdfResultValidator> validators, List<PdfRenderedEvent> events) {
        return PdfService.builder().runtime(runtime.pdfRuntime()).signer(TestAssets.signer("rsa2048")).seal(SealPreset.on())
            .validators(validators).events(event -> {
            if (event instanceof PdfRenderedEvent rendered) {
                events.add(rendered);
            }
        }).build();
    }

    private static PdfOptions options() {
        return PdfOptions.defaults().withFormKey("intake");
    }

    @Test
    void everyValidatorRunsInOrderBeforeTheSealAndTheWarningsRideAlong() {
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
        List<String> seen = new ArrayList<>();
        List<PdfRenderedEvent> events = new ArrayList<>();
        PdfResultValidator pages = candidate -> {
            seen.add("pages:" + candidate.op() + ":" + candidate.formKey() + ":" + candidate.result().pageCount() + ":" + candidate.toBeSealed()
                + ":" + (candidate.result().seal() == null));
            return HookFindings.warnings(HookProblem.at("copy", "policy.pages", "One page."));
        };
        PdfResultValidator size = candidate -> {
            seen.add("size:" + (candidate.sizeBytes() > 0));
            return HookFindings.NONE;
        };

        PdfResult result = service(runtime, List.of(pages, size), events)
            .renderSubmission(SealingTest.definition(), SealingTest.values(), "en", "copy", options());

        assertThat(seen).containsExactly("pages:document:intake:1:true:true", "size:true");
        assertThat(result.seal()).as("the PDF the validators let go was sealed").isNotNull();
        ObjectNode warning = result.warnings().get(result.warnings().size() - 1);
        assertThat(warning.path("code").asString()).isEqualTo("policy.pages");
        assertThat(warning.path("message").asString()).isEqualTo("One page.");
        assertThat(warning.path("field").asString()).isEqualTo("copy");
        assertThat(events).hasSize(1);

        List<String> ops = new ArrayList<>();
        PdfService plain = PdfService.builder().runtime(runtime.pdfRuntime()).validators(List.of(candidate -> {
            ops.add(candidate.op() + ":" + candidate.toBeSealed());
            return HookFindings.NONE;
        })).build();
        plain.render(TestAssets.JSON.createObjectNode(), PdfOptions.defaults());
        assertThat(ops).containsExactly("render:false");
    }

    @Test
    void errorsRefuseBeforeAnySignatureOrEventWithEveryErrorInOrder() {
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
        List<PdfRenderedEvent> events = new ArrayList<>();
        PdfResultValidator pages = candidate -> HookFindings.errors(HookProblem.of("policy.pages", "At most one page."));
        PdfResultValidator size = candidate -> HookFindings.errors(HookProblem.at("bytes", "policy.size", "Too large."));
        PdfService pdf = service(runtime, List.of(pages, size), events);

        assertThatThrownBy(() -> pdf.renderSubmission(SealingTest.definition(), SealingTest.values(), "en", "copy", options()))
            .isInstanceOfSatisfying(HookRefusedException.class, refused -> {
                assertThat(refused.kind()).isEqualTo(HookRefusedException.Kind.INVALID);
                assertThat(refused.code()).isEqualTo("policy.pages");
                ErrorResponse answer = new ErrorMapper(false, List.of()).map(refused);
                assertThat(answer.status()).isEqualTo(422);
                assertThat(answer.body().get("errors")).isEqualTo(List.of(new ErrorItem(null, "policy.pages", "At most one page."),
                    new ErrorItem("bytes", "policy.size", "Too large.")));
            });
        assertThat(runtime.count("complete")).as("a refused PDF costs no seal").isZero();
        assertThat(events).as("and announces nothing").isEmpty();
    }

    @Test
    void aValidatorThatThrowsFailsTheRequestAndOneThatRefusesKeepsItsKind() {
        ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
        List<PdfRenderedEvent> events = new ArrayList<>();
        PdfService broken = service(runtime, List.of(candidate -> {
            throw new IllegalStateException("policy service down");
        }), events);
        assertThatThrownBy(() -> broken.renderSubmission(SealingTest.definition(), SealingTest.values(), "en", "copy", options()))
            .isInstanceOfSatisfying(IllegalStateException.class, e -> assertThat(new ErrorMapper(false, List.of()).map(e).status()).isEqualTo(500));

        PdfService forbidding = service(runtime, List.of(candidate -> {
            throw HookRefusedException.forbidden("policy.tenant", "Not for this tenant.");
        }, candidate -> {
            throw new AssertionError("a refusal stops the later validators");
        }), events);
        assertThatThrownBy(() -> forbidding.fill(TestAssets.JSON.createObjectNode(), PdfOptions.defaults()))
            .isInstanceOfSatisfying(HookRefusedException.class, e -> assertThat(e.kind()).isEqualTo(HookRefusedException.Kind.FORBIDDEN));

        PdfService answersNull = service(runtime, List.of(candidate -> null), events);
        assertThatThrownBy(() -> answersNull.render(TestAssets.JSON.createObjectNode(), PdfOptions.defaults())).isInstanceOf(IllegalStateException.class);
        assertThat(runtime.count("complete")).isZero();
        assertThat(events).isEmpty();
    }
}
