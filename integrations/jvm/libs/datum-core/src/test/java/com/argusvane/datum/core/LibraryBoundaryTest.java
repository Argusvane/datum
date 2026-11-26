package com.argusvane.datum.core;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * The library packages of datum-core name no framework, no binding package and no JDBC, and the module holds no binding: the one
 * rule is {@link LibraryBoundaryRules} (datum-core-test-support), run here with this module's name. And datum-core is under
 * datum-sandbox, never over it: no source here names a sandbox package, so the contracts, the exception base and the hooks stay
 * usable by a host that runs no WebAssembly.
 */
class LibraryBoundaryTest extends LibraryBoundaryRules {

    LibraryBoundaryTest() {
        super("datum-core");
    }

    @Test
    void theCoreNamesNoSandboxPackage() throws IOException {
        List<String> found = new ArrayList<>();
        for (Path source : librarySources()) {
            if (code(Files.readString(source)).contains("com.argusvane.datum.sandbox.")) {
                found.add(SOURCES.relativize(source).toString());
            }
        }
        assertThat(found).as("datum-core sources naming datum-sandbox").isEmpty();
    }
}
