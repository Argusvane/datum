package com.argusvane.datum.sandbox.tck;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.core.LibraryBoundaryRules;

/**
 * The library packages of datum-sandbox-tck name no framework, no binding package and no JDBC, and the module holds no binding: the one
 * rule is {@link LibraryBoundaryRules} (datum-core-test-support), run here with this module's name.
 */
class LibraryBoundaryTest extends LibraryBoundaryRules {

    LibraryBoundaryTest() {
        super("datum-sandbox-tck");
    }
}
