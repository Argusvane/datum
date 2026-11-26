package com.argusvane.datum.sandbox.protocol;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import org.jspecify.annotations.Nullable;

/**
 * The answer frame of a sandbox run, strictly framed.
 *
 * <p>The whole of stdout is the frame: the started marker, the begin marker, the answer, the end marker,
 * each once and in that order, with nothing but whitespace around them. Anything else (a line a rule module
 * reached stdout with through {@code import('qjs:std')}, a second frame, a lone marker, another nonce's
 * markers) is not an answer and the run is refused: fail closed.
 *
 * <p>Read over bytes, so no guest byte is decoded before the frame is judged: the markers are ASCII, and the
 * whitespace allowed around them is JSON's insignificant whitespace (RFC 8259 section 2: space, tab, line feed,
 * carriage return), not Java's {@code trim()} or {@code strip()}. {@link RunScript}'s script prints the markers and the
 * answer as lines ending in a line feed and nothing else, and the answer is a JSON text, so those four bytes are all an
 * honest run can leave around a marker (a carriage return only as a line end some stream adds). Any other byte (a NUL,
 * a vertical tab, a form feed, a no-break space) is one the script never prints, so the run is refused: fail closed. {@code framed-golden.json}
 * in the tests pins the rule case by case. The answer is handed back as bytes; decoding is the caller's
 * ({@link StrictJson}).
 */
public final class Frame {

    private Frame() {
    }

    /** A marker line's text: {@code @@datum:<nonce>:<kind>@@}, kind "started", "begin" or "end". */
    public static String marker(String nonce, String kind) {
        return "@@datum:" + nonce + ":" + kind + "@@";
    }

    /**
     * The answer between a run's begin and end markers, trimmed, or {@code null} when stdout is anything but
     * exactly that one frame.
     */
    public static byte @Nullable [] framed(byte[] stdout, String nonce) {
        return framed(ByteBuffer.wrap(stdout), nonce);
    }

    /**
     * {@link #framed(byte[], String)} over a read-only view ({@code RunOutput#stdoutView}): the buffer's remaining bytes (its
     * position to its limit) are the whole of stdout, read by absolute index into a slice; only the answer itself is copied out.
     */
    public static byte @Nullable [] framed(ByteBuffer view, String nonce) {
        ByteBuffer stdout = view.slice();
        byte[] started = ascii(marker(nonce, "started"));
        byte[] begin = ascii(marker(nonce, "begin"));
        byte[] end = ascii(marker(nonce, "end"));
        for (byte[] marker : new byte[][] {started, begin, end}) {
            if (count(stdout, marker) != 1) {
                return null;
            }
        }
        int startedAt = indexOf(stdout, started, 0);
        int beginAt = indexOf(stdout, begin, 0);
        int endAt = indexOf(stdout, end, 0);
        if (startedAt < 0 || beginAt < 0 || endAt < 0 || !(startedAt < beginAt && beginAt < endAt)) {
            return null;
        }
        int startedEnd = startedAt + started.length;
        int from = beginAt + begin.length;
        if (!blank(stdout, 0, startedAt)
            || !blank(stdout, startedEnd, beginAt)
            || !blank(stdout, endAt + end.length, stdout.limit())) {
            return null;
        }
        return trim(stdout, from, endAt);
    }

    /** {@link #framed(byte[], String)} over a text, UTF-8; for tests and callers that hold a String. */
    public static @Nullable String framed(String stdout, String nonce) {
        byte[] answer = framed(stdout.getBytes(StandardCharsets.UTF_8), nonce);
        return answer == null ? null : new String(answer, StandardCharsets.UTF_8);
    }

    /**
     * Whether stdout holds this run's begin and end markers once each: then a refused frame had bytes outside
     * it rather than no answer. Only for the message: the run is refused either way.
     */
    public static boolean hasStrayOutput(byte[] stdout, String nonce) {
        return hasStrayOutput(ByteBuffer.wrap(stdout), nonce);
    }

    /** {@link #hasStrayOutput(byte[], String)} over a view. */
    public static boolean hasStrayOutput(ByteBuffer view, String nonce) {
        ByteBuffer stdout = view.slice();
        return count(stdout, ascii(marker(nonce, "begin"))) == 1 && count(stdout, ascii(marker(nonce, "end"))) == 1;
    }

    /** Whether the guest's first line ran: the started marker is anywhere in stdout. */
    public static boolean started(byte[] stdout, String nonce) {
        return started(ByteBuffer.wrap(stdout), nonce);
    }

    /** {@link #started(byte[], String)} over a view. */
    public static boolean started(ByteBuffer view, String nonce) {
        ByteBuffer stdout = view.slice();
        return indexOf(stdout, ascii(marker(nonce, "started")), 0) >= 0;
    }

    /** The frame's whitespace, JSON's (RFC 8259 section 2): space, tab, line feed and carriage return. */
    static boolean isFrameSpace(byte b) {
        return b == ' ' || b == '\t' || b == '\n' || b == '\r';
    }

    /**
     * Non-overlapping occurrences, scanning left to right; two markers glued so they share their "@@" count once and
     * leave stray bytes behind, which refuses the run all the same ("marker overlap attempt" in framed-golden.json).
     */
    static int count(byte[] haystack, byte[] needle) {
        return count(ByteBuffer.wrap(haystack), needle);
    }

    static int count(ByteBuffer haystack, byte[] needle) {
        int count = 0;
        int at = indexOf(haystack, needle, 0);
        while (at >= 0) {
            count++;
            at = indexOf(haystack, needle, at + needle.length);
        }
        return count;
    }

    static int indexOf(ByteBuffer haystack, byte[] needle, int from) {
        outer:
        for (int i = Math.max(0, from); i <= haystack.limit() - needle.length; i++) {
            for (int j = 0; j < needle.length; j++) {
                if (haystack.get(i + j) != needle[j]) {
                    continue outer;
                }
            }
            return i;
        }
        return -1;
    }

    private static boolean blank(ByteBuffer bytes, int from, int to) {
        for (int i = from; i < to; i++) {
            if (!isFrameSpace(bytes.get(i))) {
                return false;
            }
        }
        return true;
    }

    private static byte[] trim(ByteBuffer bytes, int from, int to) {
        int start = from;
        int stop = to;
        while (start < stop && isFrameSpace(bytes.get(start))) {
            start++;
        }
        while (stop > start && isFrameSpace(bytes.get(stop - 1))) {
            stop--;
        }
        byte[] answer = new byte[stop - start];
        bytes.get(start, answer);
        return answer;
    }

    private static byte[] ascii(String text) {
        return text.getBytes(StandardCharsets.US_ASCII);
    }
}
