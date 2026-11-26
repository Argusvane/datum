package com.argusvane.datum.sandbox.wasi;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.ReadOnlyBufferException;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * The run request of the WASI layer: plain file names only, in their order, and contents no reader
 * can change for the next one.
 */
class GuestRunTest {

    private static final Budget BUDGET = new Budget(5, 32L << 20, Budget.STDOUT_LIMIT, Budget.STDERR_LIMIT);

    private static byte[] utf8(String text) {
        return text.getBytes(StandardCharsets.UTF_8);
    }

    private static GuestRun of(String... namesAndContents) {
        Map<String, byte[]> files = new LinkedHashMap<>();
        for (int i = 0; i < namesAndContents.length; i += 2) {
            files.put(namesAndContents[i], utf8(namesAndContents[i + 1]));
        }
        return GuestRun.of(files, List.of("qjs", "/app/run.js"), utf8("in"), BUDGET);
    }

    @Test
    void aFileNameIsOnePlainNameAndNothingAPathCouldBeBuiltFrom() {
        for (String bad : new String[] {"", ".", "..", "../etc/passwd", "a/b", "/abs", "a\\b", ".hidden", "-dash", "a b", "nul\u0000",
            "café.js", "x".repeat(256)}) {
            assertThatThrownBy(() -> of(bad, "x")).as("[" + bad + "]").isInstanceOf(IllegalArgumentException.class);
        }
        assertThat(of("run.js", "a", "datum-sandbox-program.js", "b", "A_1.txt", "c", "x".repeat(255), "d").appFiles()).hasSize(4);
    }

    @Test
    void theFilesKeepTheirOrderAndNothingElseIsAdded() {
        GuestRun run = of("b.js", "1", "a.js", "2", "run.js", "3");
        assertThat(run.appFiles().keySet()).containsExactly("b.js", "a.js", "run.js");
        assertThat(run.file("a.js")).isEqualTo(utf8("2"));
        assertThat(run.file("missing.js")).isNull();
        assertThat(run.appBytes()).isEqualTo(3);
        assertThat(run.argv()).containsExactly("qjs", "/app/run.js");
        assertThatThrownBy(() -> run.appFiles().put("x.js", ByteBuffer.allocate(1))).isInstanceOf(UnsupportedOperationException.class);
        assertThatThrownBy(() -> run.argv().add("more")).isInstanceOf(UnsupportedOperationException.class);
    }

    @Test
    void ofCopiesTheArraysSoTheCallersLaterWritesReachNoGuest() {
        byte[] program = utf8("program");
        byte[] stdin = utf8("stdin");
        GuestRun run = GuestRun.of(Map.of("p.js", program), List.of("qjs"), stdin, BUDGET);
        program[0] = 'X';
        stdin[0] = 'X';
        assertThat(run.file("p.js")).isEqualTo(utf8("program"));
        assertThat(run.stdinBytes()).isEqualTo(utf8("stdin"));
    }

    @Test
    void everyViewIsReadOnlyAndFreshSoNoReaderChangesWhatTheNextReads() throws IOException {
        GuestRun run = of("p.js", "abc");
        ByteBuffer first = run.appFiles().get("p.js");
        assertThat(first.isReadOnly()).isTrue();
        assertThatThrownBy(() -> first.put(0, (byte) 'X')).isInstanceOf(ReadOnlyBufferException.class);
        first.get(new byte[3]);
        assertThat(first.hasRemaining()).isFalse();
        assertThat(run.appFiles().get("p.js").remaining()).as("a fresh view, from the start").isEqualTo(3);
        assertThat(run.stdin().isReadOnly()).isTrue();
        try (InputStream in = run.openStdin()) {
            assertThat(in.available()).isEqualTo(2);
            assertThat(in.readAllBytes()).isEqualTo(utf8("in"));
            assertThat(in.read()).isEqualTo(-1);
        }
        try (InputStream again = run.openStdin()) {
            assertThat(again.readAllBytes()).as("each stream reads from the start").isEqualTo(utf8("in"));
        }
    }

    /** The canonical constructor shares what it is given (no second buffer per run) and holds a buffer's remaining bytes. */
    @Test
    void theCanonicalConstructorSharesReadOnlyViewsOfTheRemainingBytes() {
        ByteBuffer content = ByteBuffer.wrap(utf8("..abc")).position(2);
        GuestRun run = new GuestRun(Map.of("p.js", content), List.of(), ByteBuffer.wrap(utf8("in")), BUDGET);
        assertThat(run.file("p.js")).isEqualTo(utf8("abc"));
        assertThat(content.position()).as("the caller's buffer is not moved").isEqualTo(2);
        assertThat(run.appFiles().get("p.js").isReadOnly()).isTrue();
    }

    @Test
    void theTextOfARunNamesSizesAndNeverAByteOfContent() {
        String text = of("p.js", "secret-program", "run.js", "x").toString();
        assertThat(text).contains("p.js (14 bytes)").contains("run.js (1 bytes)").contains("stdin 2 bytes").doesNotContain("secret");
    }

    @Test
    void nothingIsLeftOut() {
        assertThatThrownBy(() -> GuestRun.of(Map.of("p.js", utf8("x")), List.of(), utf8(""), null)).isInstanceOf(NullPointerException.class);
        assertThatThrownBy(() -> new GuestRun(null, List.of(), ByteBuffer.allocate(0), BUDGET)).isInstanceOf(NullPointerException.class);
        assertThatThrownBy(() -> new GuestRun(Map.of(), List.of(), null, BUDGET)).isInstanceOf(NullPointerException.class);
        assertThat(new GuestRun(Map.of(), List.of(), ByteBuffer.allocate(0), BUDGET).appFiles()).as("an empty /app is a run too").isEmpty();
    }
}
