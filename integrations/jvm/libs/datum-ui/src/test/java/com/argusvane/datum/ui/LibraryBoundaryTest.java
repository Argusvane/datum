package com.argusvane.datum.ui;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.core.LibraryBoundaryRules;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;

/**
 * The library packages of datum-ui name no framework, no binding package and no JDBC, and the module holds no binding: the one
 * rule is {@link LibraryBoundaryRules} (datum-core-test-support), run here with this module's name.
 */
class LibraryBoundaryTest extends LibraryBoundaryRules {

    LibraryBoundaryTest() {
        super("datum-ui");
    }

    /**
     * The builder's service is transport-neutral: {@code BuilderService} and
     * {@code BuilderOutcome} name no web type of datum-web-core (the error model with its statuses, the JSON body readers,
     * the entity tags), ask no exception for its status and write no header name. Those are {@code BuilderApi}'s.
     */
    @Test
    void theBuilderServiceNamesNoTransport() throws IOException {
        List<String> found = new ArrayList<>();
        for (String file : List.of("BuilderService.java", "BuilderOutcome.java")) {
            Path source = SOURCES.resolve("com/argusvane/datum/ui/builder").resolve(file);
            String text = Files.readString(source);
            String code = code(text);
            if (Pattern.compile("(?<![\\w.])com\\.argusvane\\.datum\\.web\\.").matcher(code).find()) {
                found.add(file + " names a datum-web-core type");
            }
            if (code.contains("httpStatus") || code.contains("HttpStatus")) {
                found.add(file + " reads a status");
            }
            for (String literal : strings(text)) {
                // Header names as they are written (a parameter called "etag" is not one).
                if (literal.matches("(Content-Type|Retry-After|ETag|If-Match|Location|Cache-Control|User-Agent|application/json|X-Datum-.*)")) {
                    found.add(file + " writes \"" + literal + "\"");
                }
            }
        }
        assertThat(found).as("transport in the builder's service").isEmpty();
    }

}
