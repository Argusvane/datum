package com.argusvane.datum.sandbox.endive;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowableOfType;

import com.argusvane.datum.sandbox.diagnostics.RunCapture;
import com.argusvane.datum.sandbox.diagnostics.RunTrace;
import com.argusvane.datum.sandbox.protocol.ProgramLimits;
import com.argusvane.datum.sandbox.protocol.RuleModule;
import com.argusvane.datum.sandbox.protocol.SandboxException;
import com.argusvane.datum.sandbox.runtime.DatumSandbox;
import com.argusvane.datum.sandbox.runtime.SandboxSettings;
import com.argusvane.datum.sandbox.tck.RuntimeTckAssets;
import com.argusvane.datum.sandbox.wasi.Budget;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * The failed-run capture on the real engine: a plain-Java sandbox on Endive, with the trace at
 * {@code failures} and the capture into a temporary directory, judges a valid answer (no line, no capture) and then a run whose
 * rule module answers past the 32 MiB output cap. That run's capture is found on disk, 0700 with 0600 files: its stdin (the
 * submitted answers), stdout (as far as the cap let it go), stderr, run.js and meta.json; and the one trace line names it, with
 * the harness's real timings.
 */
class FailedRunCaptureIT {

    private static final String MARKER = "MARKER-it-capture-9c1e";

    private static final String GOOD = "{\"name\":\"Ada Lovelace\",\"code\":\"AB1234\",\"addr\":{\"city\":\"Ottawa\",\"pick\":\"ok\"},"
        + "\"tags\":{\"x\":true,\"y\":false},\"rows\":[{\"sku\":\"s1\",\"n\":1}]}";

    /** A rule module whose answer is 40 MiB: the guest's print passes the stdout cap and the run is stopped there. */
    private static final RuleModule HUGE = new RuleModule("datum-it-huge", "1", "({ validators: [function () {\n"
        + "  return { errors: [{ code: 'datum.it', componentId: 'name', message: 'x'.repeat(40 * 1024 * 1024) }] };\n"
        + "}] })");

    @TempDir
    Path temp;

    private static ObjectNode context(JsonNode definition, String values) {
        ObjectNode context = RuntimeTckAssets.JSON.createObjectNode();
        context.put("formId", definition.path("id").asString());
        context.set("form", definition.path("root").deepCopy());
        context.set("values", RuntimeTckAssets.JSON.readTree(values));
        context.put("locale", "en");
        return context;
    }

    private static String field(String line, String key) {
        return Stream.of(line.split(" ")).filter(pair -> pair.startsWith(key + "=")).map(pair -> pair.substring(key.length() + 1))
            .findFirst().orElseThrow();
    }

    private static String mode(Path path) throws Exception {
        return PosixFilePermissions.toString(Files.getPosixFilePermissions(path, LinkOption.NOFOLLOW_LINKS));
    }

    @Test
    void aRunPastTheOutputCapIsCapturedOnDiskAndItsTraceLineNamesIt() throws Exception {
        Path directory = temp.resolve("captures");
        List<String> lines = Collections.synchronizedList(new ArrayList<>());
        SandboxSettings settings = SandboxSettings.builder().warmUpRuns(1)
            // Room for the module to build its 40 MiB answer, so the run ends at the output cap and not at its memory limit.
            .validationMemory(512L * ProgramLimits.MIB).validationTimeLimit(Duration.ofSeconds(30))
            .trace("failures").captureEnabled(true).captureDirectory(directory.toString()).build();
        JsonNode form = RuntimeTckAssets.fixture("fixture-form.json");
        String sha256;

        try (DatumSandbox sandbox = DatumSandbox.builder().settings(settings).runTrace(RunTrace.lines(lines::add)).build()) {
            sandbox.start();
            assertThat(sandbox.status().isUp()).isTrue();
            assertThat(mode(directory)).as("created for the JVM's user alone").isEqualTo("rwx------");
            sha256 = sandbox.report().programs().get(0).sha256();

            sandbox.sandbox().validate(context(form, GOOD), List.of(), false);
            assertThat(lines).as("a verdict, the proofs and the warm-up are not failed runs").isEmpty();

            String marked = GOOD.replace("Ada Lovelace", MARKER);
            SandboxException capped = catchThrowableOfType(SandboxException.class,
                () -> sandbox.sandbox().validate(context(form, marked), List.of(HUGE), false));
            assertThat(capped).isNotNull();
            assertThat(capped.reason()).isEqualTo(SandboxException.Reason.OUTPUT_CAP);
            assertThat(sandbox.status().details()).containsKey("capture");
        }
        // close() stopped the sandbox, and the stop drained the capture queue.

        assertThat(lines).singleElement().asString().doesNotContain(MARKER);
        String line = lines.get(0);
        assertThat(field(line, "outcome")).isEqualTo("output_cap");
        assertThat(field(line, "termination")).isEqualTo("output_cap");
        assertThat(field(line, "engine")).isEqualTo("endive");
        assertThat(field(line, "prepareMs")).as("the harness's own timings").matches("[0-9]+\\.[0-9]");
        assertThat(field(line, "startMs")).matches("[0-9]+\\.[0-9]");
        String id = field(line, "capture");
        assertThat(id).matches(RunCapture.ID);

        List<String> kept;
        try (Stream<Path> entries = Files.list(directory)) {
            kept = entries.map(path -> path.getFileName().toString()).toList();
        }
        assertThat(kept).containsExactly(id);
        Path capture = directory.resolve(id);
        assertThat(mode(capture)).isEqualTo("rwx------");
        for (String file : RunCapture.FILES) {
            assertThat(mode(capture.resolve(file))).as(file).isEqualTo("rw-------");
        }
        assertThat(Files.readString(capture.resolve("stdin.bin"))).as("the submitted answers, in clear text").contains(MARKER);
        assertThat(Files.size(capture.resolve("stdout.bin"))).as("as far as the cap let it go").isGreaterThan(Budget.STDOUT_LIMIT / 2)
            .isLessThanOrEqualTo(Budget.STDOUT_LIMIT);
        assertThat(Files.readString(capture.resolve("run.js"))).contains("datum-it-huge").contains("__datum_run");
        String meta = Files.readString(capture.resolve("meta.json"), StandardCharsets.UTF_8);
        assertThat(meta).contains("\"capture\" : \"" + id + "\"").contains("\"sha256\" : \"" + sha256 + "\"").contains("\"outcome\" : \"output_cap\"")
            .contains("\"id\" : \"endive\"").contains("datum.runtime.diagnostics.capture.directory").contains(directory.toString())
            .doesNotContain(MARKER);
    }
}
