package com.argusvane.datum.submissions.service;

import static com.argusvane.datum.submissions.Fixtures.envelope;
import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import com.argusvane.datum.sandbox.runtime.ProgramStore;
import com.argusvane.datum.sandbox.protocol.HostOptions;
import com.argusvane.datum.sandbox.protocol.ProgramLimits;
import com.argusvane.datum.sandbox.protocol.RunScript;
import com.argusvane.datum.sandbox.protocol.SandboxService;
import com.argusvane.datum.forms.DefinitionService;
import com.argusvane.datum.forms.datasource.DataSourceOptions;
import com.argusvane.datum.forms.snapshot.InMemoryDefinitionSnapshotStore;
import com.argusvane.datum.forms.translation.InMemoryTranslationCatalogStore;
import com.argusvane.datum.submissions.Fixtures;
import com.argusvane.datum.submissions.service.SubmissionOutcome.Rejected;
import com.argusvane.datum.submissions.spi.SubmissionContext;
import com.argusvane.datum.submissions.spi.SubmissionReceipt;
import java.time.Duration;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * End to end: a submission failing a field's pattern is worded by the real sandbox
 * program, read from the generated assets and evaluated by Node ({@link NodeSandboxRuntime}), from the catalog the host
 * keeps (the {@code catalog} key of the run context) before the definition's own map, in the filler's locale. The unit tests
 * of {@code SubmissionServiceTest} prove the key rides in the context; this proves the program reads it. Skipped when no
 * {@code node} 18+ is on the PATH.
 */
class CatalogMessageRealProgramTest {

    private static final String LOCALE = "fr-CA";

    @BeforeAll
    static void needsNode() {
        assumeTrue(NodeSandboxRuntime.available(), "No node 18+ on the PATH: the real-program message test is skipped.");
    }

    /** A form whose "code" field matches digits only, with the default text "D" and the map's fr-CA text "F". */
    private static ObjectNode form() {
        return Fixtures.json("{\"id\":\"coded\",\"version\":\"1\",\"root\":{\"id\":\"root\",\"type\":\"form\",\"configuration\":{},"
            + "\"children\":{\"content\":[{\"id\":\"code\",\"type\":\"text\",\"configuration\":{\"label\":\"Code\","
            + "\"pattern\":\"^[0-9]+$\",\"patternMessage\":\"D\"}}]}},"
            + "\"translations\":{\"fr-CA\":{\"components\":{\"code\":{\"patternMessage\":{\"text\":\"F\",\"source\":\"abc\"}}}}}}");
    }

    private static ObjectNode failing() {
        ObjectNode envelope = envelope("coded", "1", "{\"code\":\"abc\"}");
        ((ObjectNode) envelope.path("submission")).put("locale", LOCALE);
        return envelope;
    }

    /** The message the program words for the pattern failure, read from its own answer: the outcome's parameters. */
    private static String patternMessage(NodeSandboxRuntime node, SubmissionOutcome outcome) {
        assertThat(outcome).isInstanceOf(Rejected.class);
        assertThat(((Rejected) outcome).errors()).singleElement().satisfies(error -> {
            assertThat(error.field()).isEqualTo("code");
            assertThat(error.code()).isEqualTo("pattern");
        });
        List<String> answers = node.answers();
        JsonNode answer = Fixtures.json(
            answers.stream().filter(text -> text.contains("\"errors\":[{")).reduce((first, last) -> last).orElseThrow());
        return answer.path("errors").path(0).path("parameters").path("message").stringValue();
    }

    private SubmissionOutcome submit(NodeSandboxRuntime node, InMemoryTranslationCatalogStore catalogs) {
        ProgramStore.Programs programs = new ProgramStore(Thread.currentThread().getContextClassLoader(), null, null).load();
        SandboxService sandbox = SandboxService.create(com.argusvane.datum.sandbox.protocol.ProgramRunner.on(node), programs.sandbox(), new RunScript(programs.freezeSnippet()),
            ProgramLimits.defaults(), HostOptions.defaults());
        Fixtures.Repository forms = new Fixtures.Repository(form());
        SubmissionService service = SubmissionService.builder()
            .sandbox(() -> sandbox)
            .definitions(DefinitionService.builder().repository(forms).snapshots(new InMemoryDefinitionSnapshotStore(100)).sandbox(() -> sandbox).events(event -> { }).publicCacheSize(16).build())
            .dataSources(new DataSourceOptions(null, Duration.ofSeconds(2), null))
            .catalogs(catalogs)
            .handler(submission -> new SubmissionReceipt("id-1", "CODED-1", null))
            .events(event -> { })
            .build();
        return service.submit(FormRef.fromDocument(), failing(), SubmissionContext.of(SubmissionContext.BUS).withSubmissionKey("catalog-" + UUID.randomUUID()));
    }

    @Test
    void theHostCatalogWordsThePatternMessageBeforeTheDefinitionsMapAndTheMapAnswersWhenTheCatalogIsEmpty() {
        NodeSandboxRuntime node = new NodeSandboxRuntime();
        InMemoryTranslationCatalogStore catalogs = new InMemoryTranslationCatalogStore();
        catalogs.write("coded", (ObjectNode) Fixtures.json("{\"fr-CA\":{\"components\":{\"code\":{\"patternMessage\":\"C\"}}}}"), null);

        assertThat(patternMessage(node, submit(node, catalogs))).as("the catalog beats the map under the same tag").isEqualTo("C");

        NodeSandboxRuntime second = new NodeSandboxRuntime();
        assertThat(patternMessage(second, submit(second, new InMemoryTranslationCatalogStore())))
            .as("an empty store: the definition's map").isEqualTo("F");
    }
}
