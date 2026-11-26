package com.argusvane.datum.forms;

import com.argusvane.datum.core.contracts.DatumJson;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Objects;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * Where the resource repository's definitions come from, framework-free: a location ({@code datum.forms.locations})
 * resolves to named sources through the host binding's {@link Resolver} (Spring's resource pattern resolver on
 * Spring, for {@code classpath:} and {@code file:} globs alike), and each source's bytes are read as a
 * definition in one place ({@link #read}), so a bad file fails the start (Spring) or, in a Quarkus binding, the build with the
 * same message.
 */
public final class FormSources {

    /** The bytes of one source. */
    @FunctionalInterface
    public interface Bytes {
        byte[] read() throws IOException;
    }

    /**
     * One definition file a location found.
     *
     * @param fileName the file's name ({@code intake.json}): the key when the definition has no {@code id}
     * @param where    how messages name it (its URL)
     * @param bytes    the content, read once at construction of the repository
     */
    public record Source(String fileName, String where, Bytes bytes) {

        public Source {
            Objects.requireNonNull(fileName, "fileName");
            Objects.requireNonNull(where, "where");
            Objects.requireNonNull(bytes, "bytes");
        }
    }

    /** Resolves one location to its sources; an unreadable base directory is an {@link IOException}. */
    @FunctionalInterface
    public interface Resolver {
        List<Source> resolve(String location) throws IOException;
    }

    private FormSources() {
    }

    /**
     * A definition file's bytes as a definition: one JSON object.
     *
     * @param where how the message names the file
     * @throws IllegalStateException when it is not JSON or not an object (the start fails, naming the file)
     */
    public static ObjectNode read(String where, byte[] bytes) {
        try {
            JsonNode node = DatumJson.mapper().readTree(new String(bytes, StandardCharsets.UTF_8));
            if (!node.isObject()) {
                throw new IllegalStateException("The form definition " + where + " is not a JSON object.");
            }
            return (ObjectNode) node;
        } catch (RuntimeException e) {
            if (e instanceof IllegalStateException) {
                throw (IllegalStateException) e;
            }
            throw new IllegalStateException("The form definition " + where + " cannot be read as JSON: " + e.getMessage(), e);
        }
    }
}
