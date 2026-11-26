package com.argusvane.datum.ui.builder;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Optional;
import org.junit.jupiter.api.Test;

/**
 * The builder tests carry a copy of the security suite's endpoint fixture (so they run outside the checkout); in the
 * checkout the copy must still be the suite's, or the kernel answers captured for it are stale too.
 */
class BuilderFixturesTest {

    @Test
    void theCopyIsTheSuitesFixture() throws IOException {
        Optional<Path> suite = BuilderFixtures.repositoryFile(BuilderFixtures.SUITE_FIXTURE);
        assumeTrue(suite.isPresent(), "Not inside the datum checkout: the copy is the only fixture here.");
        assertThat(BuilderFixtures.resource(BuilderFixtures.COPY))
            .as("The suite's fixture changed: copy it to datum-ui-test-support/src/main/resources/.../ui/builder/%s and capture kernel-check-answers.json again",
                BuilderFixtures.COPY)
            .isEqualTo(Files.readAllBytes(suite.get()));
    }
}
