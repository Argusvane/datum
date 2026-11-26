package com.argusvane.datum.sandbox.diagnostics;

import com.argusvane.datum.sandbox.wasi.RunOutput;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.regex.Pattern;
import tools.jackson.databind.SerializationFeature;
import tools.jackson.databind.json.JsonMapper;

/**
 * One failed run, kept whole for debugging: immutable, so the writer thread reads exactly what the run
 * thread handed over. Its {@link #id()} is {@code <UTC yyyyMMdd-HHmmss>-<run id>} and nothing else, so a sink that names a
 * place after it builds that name from a timestamp and twelve hex digits only, never from guest or request text; the
 * constructor refuses any other id, and any file name outside {@link #FILES}.
 *
 * <p>The files, in the order a sink writes them: {@code stdin.bin}, {@code stdout.bin} and {@code stderr.bin} (the bytes as
 * the harness handed them over), {@code run.js} (the generated script) and {@code meta.json} (the trace fields, the program's
 * sha256 and ABI, the engine and the settings report). The program file itself is not copied: its sha256 pins it.
 *
 * <p>The contents are read-only views of the run's own buffers, not copies; the capture queue's byte bound is what bounds how
 * much of them is held.
 *
 * @param id the capture's name
 * @param files file name to content, in {@link #FILES} order
 */
public record RunCapture(String id, Map<String, ByteBuffer> files) {

    /** What a capture id is: a UTC timestamp to the second, then the run id. */
    public static final Pattern ID = Pattern.compile("[0-9]{8}-[0-9]{6}-[0-9a-f]{12}");

    /** The files of a capture, in the order they are written ({@code meta.json} last, so a capture is complete when it is there). */
    public static final List<String> FILES = List.of("stdin.bin", "stdout.bin", "stderr.bin", "run.js", "meta.json");

    private static final DateTimeFormatter STAMP = DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss").withZone(ZoneOffset.UTC);

    private static final JsonMapper JSON = JsonMapper.builder().enable(SerializationFeature.INDENT_OUTPUT).build();

    public RunCapture {
        Objects.requireNonNull(id, "id");
        if (!ID.matcher(id).matches()) {
            throw new IllegalArgumentException("A capture id is <yyyyMMdd-HHmmss>-<12 hex digits>, not \"" + id + "\".");
        }
        Map<String, ByteBuffer> copy = new LinkedHashMap<>();
        for (String name : FILES) {
            ByteBuffer content = Objects.requireNonNull(files, "files").get(name);
            if (content != null) {
                copy.put(name, content.asReadOnlyBuffer());
            }
        }
        if (copy.size() != files.size()) {
            throw new IllegalArgumentException("A capture holds only " + FILES + ", not " + files.keySet() + ".");
        }
        files = Collections.unmodifiableMap(copy);
    }

    /** The id of a capture taken at {@code at} for the run {@code runId} (twelve lowercase hex digits). */
    public static String id(Instant at, String runId) {
        return STAMP.format(at) + "-" + runId;
    }

    /**
     * The capture of one failed run: its stdin, stdout and stderr, its {@code run.js}, and {@code meta} written as JSON.
     *
     * @param meta plain data (maps, lists, strings, numbers, booleans)
     */
    public static RunCapture of(String id, RunFacts facts, Map<String, ?> meta) {
        Map<String, ByteBuffer> files = new LinkedHashMap<>();
        RunOutput output = facts.output();
        files.put("stdin.bin", facts.stdin());
        files.put("stdout.bin", output == null ? ByteBuffer.allocate(0) : output.stdoutView());
        files.put("stderr.bin", output == null ? ByteBuffer.allocate(0) : output.stderrView());
        files.put("run.js", ByteBuffer.wrap(facts.runScript().getBytes(StandardCharsets.UTF_8)));
        files.put("meta.json", ByteBuffer.wrap(JSON.writeValueAsBytes(meta)));
        return new RunCapture(id, files);
    }

    /** The files, each a fresh read-only view, in order. */
    @Override
    public Map<String, ByteBuffer> files() {
        Map<String, ByteBuffer> views = new LinkedHashMap<>();
        files.forEach((name, content) -> views.put(name, content.duplicate()));
        return Collections.unmodifiableMap(views);
    }

    /** The bytes of every file together: what the queue and the store bounds count. */
    public long bytes() {
        long total = 0;
        for (ByteBuffer content : files.values()) {
            total += content.remaining();
        }
        return total;
    }

    /** The id and size; never a byte of the contents. */
    @Override
    public String toString() {
        return "RunCapture[" + id + ", " + bytes() + " bytes]";
    }
}
