package com.argusvane.datum.submissions;

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
 * The library packages of datum-submissions name no framework, no binding package and no JDBC, and the module holds no binding: the one
 * rule is {@link LibraryBoundaryRules} (datum-core-test-support), run here with this module's name.
 */
class LibraryBoundaryTest extends LibraryBoundaryRules {

    LibraryBoundaryTest() {
        super("datum-submissions");
    }

    /**
     * The submission service is transport-neutral: its package names no web type of
     * datum-web-core (the error model with its statuses, the JSON body readers, the media types), asks no exception for
     * its status and writes no header name. Statuses, headers and media types are the HTTP receiver's mapping.
     */
    @Test
    void theServicePackageNamesNoTransport() throws IOException {
        Path service = SOURCES.resolve("com/argusvane/datum/submissions/service");
        List<String> found = new ArrayList<>();
        try (Stream<Path> files = Files.walk(service)) {
            for (Path source : files.filter(file -> file.toString().endsWith(".java")).toList()) {
                String text = Files.readString(source);
                String code = code(text);
                String name = SOURCES.relativize(source).toString();
                if (Pattern.compile("(?<![\\w.])com\\.argusvane\\.datum\\.web\\.").matcher(code).find()) {
                    found.add(name + " names a datum-web-core type");
                }
                if (code.contains("httpStatus") || code.contains("HttpStatus")) {
                    found.add(name + " reads a status");
                }
                for (String literal : strings(text)) {
                    // Header names as they are written (a parameter called "etag" is not one).
                    if (literal.matches("(Content-Type|Retry-After|ETag|If-Match|Location|Cache-Control|User-Agent|application/json|X-Datum-.*)")) {
                        found.add(name + " writes \"" + literal + "\"");
                    }
                }
            }
        }
        assertThat(found).as("transport in the submission service").isEmpty();
    }

    /**
     * No outcome holds a status: no component
     * of any outcome, nor of a record one holds, is a status, the pre-check's refusal carries none, and the service never
     * reads one.
     */
    @Test
    void noOutcomeHoldsAStatus() throws IOException {
        List<String> statuses = new ArrayList<>();
        for (Class<?> record : com.argusvane.datum.submissions.service.SubmissionOutcome.class.getPermittedSubclasses()) {
            for (java.lang.reflect.RecordComponent component : record.getRecordComponents()) {
                String path = record.getSimpleName() + "." + component.getName();
                if (component.getName().toLowerCase(java.util.Locale.ROOT).contains("status")) {
                    statuses.add(path);
                }
                if (component.getType().isRecord()) {
                    for (java.lang.reflect.RecordComponent inner : component.getType().getRecordComponents()) {
                        if (inner.getName().toLowerCase(java.util.Locale.ROOT).contains("status")) {
                            statuses.add(path + "." + inner.getName());
                        }
                    }
                }
            }
        }
        assertThat(statuses).isEmpty();
        assertThat(com.argusvane.datum.submissions.spi.PreCheckDecision.Reject.class.getRecordComponents())
            .extracting(java.lang.reflect.RecordComponent::getName).containsExactly("code", "message");

        String service = code(Files.readString(SOURCES.resolve("com/argusvane/datum/submissions/service/SubmissionService.java")));
        assertThat(Pattern.compile("(?i)(reject|decision|refus\\w*)\\s*(\\(\\))?\\s*\\.\\s*status\\s*\\(").matcher(service).find())
            .as("the service reads the pre-check's status").isFalse();
    }

}
