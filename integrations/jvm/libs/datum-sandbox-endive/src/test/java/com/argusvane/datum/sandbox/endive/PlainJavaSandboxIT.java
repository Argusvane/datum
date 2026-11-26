package com.argusvane.datum.sandbox.endive;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.sandbox.protocol.SandboxResult;
import com.argusvane.datum.sandbox.runtime.DatumSandbox;
import com.argusvane.datum.sandbox.tck.RuntimeTckAssets;
import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * The plain-Java entry point, and the usage example the docs quote: a host with no framework builds a
 * {@link DatumSandbox} from nothing, starts it, validates an answer against the TCK's fixture form, reads its status and its
 * settings report, and closes it. The engine is Endive, selected by its id from the class path; the programs are the packaged
 * ones; nothing of Spring is on this module's class path, and no thread of the sandbox is left once it is closed.
 */
class PlainJavaSandboxIT {

    private static final String GOOD = "{\"name\":\"Ada Lovelace\",\"code\":\"AB1234\",\"addr\":{\"city\":\"Ottawa\",\"pick\":\"ok\"},"
        + "\"tags\":{\"x\":true,\"y\":false},\"rows\":[{\"sku\":\"s1\",\"n\":1}]}";

    /** The same answer with the required name left empty. */
    private static final String BAD = GOOD.replace("\"name\":\"Ada Lovelace\"", "\"name\":\"\"");

    private static ObjectNode context(JsonNode definition, String values) {
        ObjectNode context = RuntimeTckAssets.JSON.createObjectNode();
        context.put("formId", definition.path("id").asString());
        context.set("form", definition.path("root").deepCopy());
        context.set("values", RuntimeTckAssets.JSON.readTree(values));
        context.put("locale", "en");
        return context;
    }

    private static List<String> blocking(SandboxResult result) {
        return result.outcome().path("errors").values().stream()
            .filter(error -> "error".equals(error.path("severity").asString("error")))
            .map(error -> error.path("code").asString() + "@" + error.path("componentId").asString()).toList();
    }

    private static Set<String> liveDatumThreads() {
        return Thread.getAllStackTraces().keySet().stream().filter(thread -> thread.isAlive() && thread.getName().startsWith("datum-"))
            .map(Thread::getName).collect(Collectors.toSet());
    }

    @Test
    void aPlainJavaHostValidatesWithNoFramework() throws Exception {
        assertThatThrownBy(() -> Class.forName("org.springframework.context.ApplicationContext")).as("no Spring here")
            .isInstanceOf(ClassNotFoundException.class);
        Set<String> before = liveDatumThreads();
        JsonNode form = RuntimeTckAssets.fixture("fixture-form.json");

        try (DatumSandbox sandbox = DatumSandbox.builder().build()) {
            sandbox.start();
            assertThat(blocking(sandbox.sandbox().validate(context(form, GOOD), List.of(), false))).isEmpty();
            assertThat(blocking(sandbox.sandbox().validate(context(form, BAD), List.of(), false))).containsExactly("required@name");

            assertThat(sandbox.status().isUp()).isTrue();
            assertThat(sandbox.status().details()).containsEntry("state", "UP").containsEntry("engine", "endive");
            assertThat(sandbox.explain().toString()).startsWith("Datum sandbox settings:").contains("datum.runtime.engine = endive (default)");
        }

        assertThat(liveDatumThreads()).as("the sandbox left no thread of its own").isSubsetOf(before);
    }
}
