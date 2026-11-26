package com.argusvane.datum.sandbox.protocol;

import com.argusvane.datum.sandbox.wasi.GuestRun;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Objects;
import org.jspecify.annotations.Nullable;

/**
 * A program file the runtime runs: its bytes, their sha256 and which program it is.
 *
 * <p>What the ABI gate proved must be what the guest reads. The bytes are read once,
 * copied in and
 * hashed at construction, and handed out only as copies or read-only views, so the hash can never drift from
 * what a runtime writes into {@code /app}. The ABI proof ({@link AbiProbe}) is kept against {@link #sha256()}.
 *
 * @param kind which program: it decides the file name the guest reads ({@link Kind#fileName()})
 * @param bytes the program text, UTF-8
 * @param sha256 the lowercase hex sha256 of {@code bytes}, computed here
 */
public record Program(Kind kind, byte[] bytes, String sha256) {

    /** Which of the two programs. */
    public enum Kind {
        /** {@code datum-sandbox-program.js}: validation and the inspect ops. */
        SANDBOX("datum-sandbox-program.js"),
        /** {@code datum-pdf-program.js}: the PDF kernel. */
        PDF("datum-pdf-program.js");

        private final String fileName;

        Kind(String fileName) {
            this.fileName = fileName;
        }

        /** The file name under {@code /app} that {@code qjs -I} evaluates. */
        public String fileName() {
            return fileName;
        }

        /** The path the guest reads it from. */
        public String guestPath() {
            return "/app/" + fileName;
        }

        /**
         * Which program a guest run holds under {@code /app} ({@link ProgramRunner#guestRun} puts one there by its
         * {@link #fileName()}), or null for a run that holds neither: for a stand-in runtime that answers by program.
         */
        public static @Nullable Kind of(GuestRun run) {
            for (String name : run.appFiles().keySet()) {
                for (Kind kind : values()) {
                    if (kind.fileName.equals(name)) {
                        return kind;
                    }
                }
            }
            return null;
        }
    }

    /**
     * Copies the bytes and computes their sha256. A {@code sha256} given by the caller must match the bytes
     * (a manifest's digest, say), else the program is refused: the file is not the one that was published.
     */
    public Program {
        Objects.requireNonNull(kind, "kind");
        Objects.requireNonNull(bytes, "bytes");
        bytes = bytes.clone();
        String actual = digest(bytes);
        if (sha256 != null && !sha256.equalsIgnoreCase(actual)) {
            throw new IllegalArgumentException("The " + kind.fileName() + " bytes do not match the sha256 given for them.");
        }
        sha256 = actual;
    }

    /** A program from its bytes; the sha256 is computed. */
    public static Program of(Kind kind, byte[] bytes) {
        return new Program(kind, bytes, null);
    }

    /** A copy of the bytes. */
    @Override
    public byte[] bytes() {
        return bytes.clone();
    }

    /** A read-only view of the bytes, for a runtime that copies them into its file system ({@link ProgramRunner#guestRun}). */
    public ByteBuffer buffer() {
        return ByteBuffer.wrap(bytes).asReadOnlyBuffer();
    }

    /** A stream over the bytes. */
    public InputStream open() {
        return new ByteArrayInputStream(bytes);
    }

    /** The size in bytes. */
    public int size() {
        return bytes.length;
    }

    @Override
    public boolean equals(Object other) {
        return other instanceof Program that && kind == that.kind && sha256.equals(that.sha256);
    }

    @Override
    public int hashCode() {
        return Objects.hash(kind, sha256);
    }

    @Override
    public String toString() {
        return "Program[" + kind.fileName() + ", " + bytes.length + " bytes, sha256=" + sha256 + "]";
    }

    static String digest(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is missing from this JVM", e);
        }
    }
}
