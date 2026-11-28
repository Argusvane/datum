package com.argusvane.datum.sandbox.tck;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.sandbox.protocol.AbiProbe;
import com.argusvane.datum.sandbox.wasi.Budget;
import com.argusvane.datum.sandbox.protocol.HostOptions;
import com.argusvane.datum.sandbox.protocol.Nonce;
import com.argusvane.datum.sandbox.protocol.Program;
import com.argusvane.datum.sandbox.protocol.ProgramLimits;
import com.argusvane.datum.sandbox.protocol.ProgramRunner;
import com.argusvane.datum.sandbox.protocol.RunClassifier;
import com.argusvane.datum.sandbox.protocol.RunLog;
import com.argusvane.datum.sandbox.wasi.RunOutput;
import com.argusvane.datum.sandbox.protocol.RunScript;
import com.argusvane.datum.sandbox.protocol.RunSlots;
import com.argusvane.datum.sandbox.protocol.SandboxResult;
import com.argusvane.datum.sandbox.protocol.SandboxService;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

/**
 * The real program on the engine answers exactly what the security suite pins for ABI 1.0
 * ({@code packages/conformance-suite/golden/abi-1.0.json}, written by {@code scripts/write-golden.ts}; in this kit's jar as
 * {@code golden.json}): the golden case's outcome bytes (length and sha256) and the six control vectors' verdicts and
 * sanitized values. Prints the warm validation wall time with the engine's mode.
 */
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
public interface GoldenVerdictsContract extends RuntimeUnderTest {

    /** The real program's service over the runtime under test, with default limits and host options. */
    private SandboxService goldenService() {
        ProgramLimits limits = ProgramLimits.defaults();
        return new SandboxService(ProgramRunner.on(runtime()), RuntimeTckAssets.sandboxProgram(), RuntimeTckAssets.scripts(), limits, HostOptions.defaults(),
            RunSlots.validation(limits), new AbiProbe(), RunLog.slf4j(), null);
    }

    /**
     * The golden case, sent as a host serializes it ({@code JsonWasmAbi.serializeContext}: keys in UTF-16 code-unit
     * order) with no host options merged, so the program sees what the golden writer's kernel saw. A port of
     * {@code goldenCaseContext()} in {@code packages/conformance-suite/src/fixtures/golden-inputs.ts}.
     */
    @Test
    default void theGoldenCaseOutcomeIsByteForBytePinned() {
        JsonNode golden = RuntimeTckAssets.fixture("golden.json");
        RunScript scripts = RuntimeTckAssets.scripts();
        String context = RuntimeTckAssets.JSON.writeValueAsString(GoldenInputs.sorted(GoldenInputs.goldenCaseContext()));
        String nonce = Nonce.generate();
        Budget budget = ProgramLimits.defaults().validationBudget();
        RunOutput output = runtime().run(ProgramRunner.guestRun(RuntimeTckAssets.sandboxProgram(), scripts.sandbox(List.of(), RunScript.Entry.RUN),
            RunScript.argv(Program.Kind.SANDBOX), Nonce.stdin(nonce, context), budget));
        byte[] answer = RunClassifier.sandboxAnswer(output, nonce, budget);
        String text = new String(answer, StandardCharsets.UTF_8);
        assertThat(text.length()).isEqualTo(golden.path("goldenCase").path("canonicalLength").asInt());
        assertThat(RuntimeTckAssets.sha256(answer)).isEqualTo(golden.path("goldenCase").path("canonicalSha256").asString());
    }

    /** CTL-01..06 through SandboxService (host options merged, as an endpoint runs them): the pinned verdicts. */
    @Test
    default void theControlVectorsMatchTheirGoldenVerdicts() {
        JsonNode golden = RuntimeTckAssets.fixture("golden.json");
        SandboxService service = goldenService();
        JsonNode definition = RuntimeTckAssets.fixture("fixture-form.json");
        String formId = definition.path("id").asString();
        String valid = GoldenInputs.validValues();
        Map<String, String> values = Map.of(
            "CTL-01", valid,
            "CTL-02", valid.replace("\"name\":\"Ada Lovelace\"", "\"name\":\"\""),
            "CTL-03", valid.replace("\"name\":\"Ada Lovelace\"", "\"name\":\"" + "x".repeat(41) + "\""),
            "CTL-04", valid.replace("\"code\":\"AB1234\"", "\"code\":\"abc\""),
            "CTL-05", valid.substring(0, valid.length() - 1) + ",\"stray\":\"ZZSTRAYZZ\",\"constructor\":\"ZZCTORZZ\"}",
            "CTL-06", valid.substring(0, valid.length() - 1)
                + ",\"__proto__\":{\"polluted\":\"ZZPOLLZZ\"},\"constructor\":{\"prototype\":{\"polluted\":\"ZZPOLLZZ\"}},\"toString\":\"ZZTOSTRINGZZ\"}");
        for (String key : new TreeMap<>(values).keySet()) {
            ObjectNode context = JsonNodeFactory.instance.objectNode();
            context.put("formId", formId);
            context.set("values", RuntimeTckAssets.JSON.readTree(values.get(key)));
            context.put("locale", "en");
            context.set("form", definition.path("root").deepCopy());
            SandboxResult result = service.validate(context, List.of(), false);
            JsonNode control = golden.path("controls").path(key);
            List<String> tokens = new ArrayList<>();
            boolean accepted = true;
            for (JsonNode error : result.outcome().path("errors").values()) {
                String field = !error.path("path").asString("").isEmpty() ? error.path("path").asString()
                    : error.path("componentId").asString("");
                tokens.add(field.isEmpty() ? error.path("code").asString() : error.path("code").asString() + "@" + field);
                String severity = error.path("severity").asString("error");
                accepted &= "warning".equals(severity) || "info".equals(severity);
            }
            Collections.sort(tokens);
            List<String> want = new ArrayList<>();
            control.path("errors").values().forEach(token -> want.add(token.asString()));
            Collections.sort(want);
            assertThat(accepted).as(key + " accepted").isEqualTo(control.path("accepted").asBoolean());
            assertThat(tokens).as(key + " errors").isEqualTo(want);
            if (control.has("values")) {
                assertThat(result.outcome().path("values")).as(key + " values").isEqualTo(control.path("values"));
            }
        }
    }

    /**
     * The definition's own translations answer a pattern message in the filler's language: the run context
     * carries the map beside the form, the kernel resolves the message from it for {@code fr-CA}, and English and an
     * unlisted language read the entry for their own locale or the default. Mirrors CTX-02 of the conformance suite
     * ({@code packages/conformance-suite/src/vectors/context.ts}); {@code 1hkaexf} is the source hash of "D".
     */
    @Test
    default void aPatternMessageAnswersInTheFillersLanguageFromTheRunContextsTranslations() {
        SandboxService service = goldenService();
        JsonNode definition = RuntimeTckAssets.fixture("fixture-form.json");
        JsonNode form = definition.path("root").deepCopy();
        for (JsonNode node : form.path("children").path("content").values()) {
            if ("code".equals(node.path("id").asString())) {
                ((ObjectNode) node.path("configuration")).put("patternMessage", "D");
            }
        }
        JsonNode translations = RuntimeTckAssets.JSON.readTree("""
            {"en":{"components":{"code":{"patternMessage":{"text":"E","source":"1hkaexf"}}}},
             "fr":{"components":{"code":{"patternMessage":{"text":"F","source":"1hkaexf"}}}}}
            """);
        Map<String, String> wanted = Map.of("fr-CA", "F", "en", "E", "de", "D");
        for (Map.Entry<String, String> locale : wanted.entrySet()) {
            ObjectNode context = JsonNodeFactory.instance.objectNode();
            context.put("formId", definition.path("id").asString());
            context.set("values", RuntimeTckAssets.JSON.readTree(GoldenInputs.validValues().replace("\"code\":\"AB1234\"", "\"code\":\"abc\"")));
            context.put("locale", locale.getKey());
            context.set("form", form.deepCopy());
            context.set("translations", translations.deepCopy());
            SandboxResult result = service.validate(context, List.of(), false);
            assertThat(result.outcome().path("errors").path(0).path("parameters").path("message").asString())
                .as("the message for " + locale.getKey()).isEqualTo(locale.getValue());
        }
    }

    /** The warm wall time of one validation, as the service measures it, printed with the engine's mode. */
    @Test
    default void printTheWarmValidationTime() {
        SandboxService service = goldenService();
        JsonNode definition = RuntimeTckAssets.fixture("fixture-form.json");
        ObjectNode context = JsonNodeFactory.instance.objectNode();
        context.put("formId", definition.path("id").asString());
        context.set("values", RuntimeTckAssets.JSON.readTree(GoldenInputs.validValues()));
        context.put("locale", "en");
        context.set("form", definition.path("root").deepCopy());
        for (int i = 0; i < 5; i++) {
            service.validate(context, List.of(), false);
        }
        List<Double> times = new ArrayList<>();
        for (int i = 0; i < 10; i++) {
            times.add(service.validate(context, List.of(), false).elapsedMs());
        }
        Collections.sort(times);
        System.out.printf("[datum-sandbox-tck] validation warm (endpoint fixture, CTL-01), engine %s (%s) on Java %d: median %.0f ms, "
            + "min %.0f ms, max %.0f ms%n", runtime().engineInfo().id(), runtime().engineInfo().mode(), Runtime.version().feature(),
            times.get(times.size() / 2), times.get(0), times.get(times.size() - 1));
        assertThat(times.get(times.size() / 2)).isLessThan(ProgramLimits.defaults().validationBudget().seconds() * 1000.0);
    }

    /** The golden writer's inputs, ported from {@code packages/conformance-suite/src/fixtures}. */
    final class GoldenInputs {

        private GoldenInputs() {
        }

        /** {@code validValues()} of {@code packages/conformance-suite/src/fixtures/base-form.ts}, as JSON text. */
        static String validValues() {
            return "{\"name\":\"Ada Lovelace\",\"code\":\"AB1234\",\"addr\":{\"city\":\"Ottawa\",\"pick\":\"ok\"},"
                + "\"tags\":{\"x\":true,\"y\":false},\"rows\":[{\"sku\":\"s1\",\"n\":1}]}";
        }

        /** {@code goldenCaseContext()}: sections, a container, a 60-row grid, several error kinds, a document, the fold report. */
        static JsonNode goldenCaseContext() {
            JsonNodeFactory f = JsonNodeFactory.instance;
            JsonNode form = RuntimeTckAssets.JSON.readTree("""
                {"id":"root","type":"form","configuration":{},"children":{"content":[
                  {"id":"name","type":"text","configuration":{"required":true,"maxLength":5}},
                  {"id":"addr","type":"container","configuration":{},"children":{"default":[
                    {"id":"city","type":"text","configuration":{"required":true}},
                    {"id":"pick","type":"select","configuration":{"options":[{"value":"a","label":"A"}]}}]}},
                  {"id":"rows","type":"group","configuration":{},"collection":{},"children":{"content":[
                    {"id":"sku","type":"text","configuration":{"required":true}},
                    {"id":"qty","type":"number","configuration":{}}]}},
                  {"id":"tags","type":"checkboxes","configuration":{"options":[{"value":"x","label":"X"},{"value":"y","label":"Y"}]}}]}}
                """);
            ArrayNode rows = f.arrayNode();
            for (int i = 0; i < 60; i++) {
                ObjectNode row = f.objectNode();
                row.put("sku", i % 3 == 0 ? "" : "s" + i);
                row.put("qty", i);
                rows.add(row);
            }
            ObjectNode values = f.objectNode();
            values.put("name", "toolongname");
            values.set("addr", RuntimeTckAssets.JSON.readTree("{\"city\":\"\",\"pick\":\"zzz\"}"));
            values.set("rows", rows);
            values.set("tags", RuntimeTckAssets.JSON.readTree("{\"x\":true,\"y\":false}"));
            values.put("stray", 1);
            values.put("constructor", "c");
            ObjectNode context = f.objectNode();
            context.put("formId", "f");
            context.set("values", values);
            context.put("locale", "en");
            context.set("form", form);
            context.set("document", RuntimeTckAssets.JSON.readTree("{\"b\":1,\"a\":[3,{\"z\":1,\"y\":2}],\"10\":1,\"2\":2}"));
            context.put("logLevel", "debug");
            context.put("reportFold", true);
            return context;
        }

        /** A copy with every object's keys in UTF-16 code-unit order, as the TypeScript hosts' stableStringify writes them. */
        static JsonNode sorted(JsonNode node) {
            if (node.isObject()) {
                ObjectNode copy = JsonNodeFactory.instance.objectNode();
                List<String> names = new ArrayList<>(node.propertyNames());
                Collections.sort(names);
                for (String name : names) {
                    copy.set(name, sorted(node.get(name)));
                }
                return copy;
            }
            if (node.isArray()) {
                ArrayNode copy = JsonNodeFactory.instance.arrayNode();
                node.values().forEach(item -> copy.add(sorted(item)));
                return copy;
            }
            return node;
        }
    }
}
