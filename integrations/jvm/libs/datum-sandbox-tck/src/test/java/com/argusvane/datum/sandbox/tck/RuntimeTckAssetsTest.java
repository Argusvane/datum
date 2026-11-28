package com.argusvane.datum.sandbox.tck;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.sandbox.protocol.Program;
import java.io.InputStream;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;

/**
 * The kit carries what its contracts read: the fixtures in its own jar (not the repository's files), and the real
 * programs from datum-programs. An engine outside this repository depends on exactly that.
 */
class RuntimeTckAssetsTest {

    @Test
    void theFixturesAreInTheKitsOwnResources() throws Exception {
        for (String name : new String[] {"golden.json", "fixture-form.json", "documents/hashes.json"}) {
            try (InputStream in = getClass().getClassLoader().getResourceAsStream(RuntimeTckAssets.FIXTURES + name)) {
                assertThat(in).as(RuntimeTckAssets.FIXTURES + name).isNotNull();
            }
        }
        JsonNode hashes = RuntimeTckAssets.fixture("documents/hashes.json");
        assertThat(hashes.size()).as("the parity documents").isGreaterThan(0);
        hashes.propertyNames().forEach(theme ->
            assertThat(RuntimeTckAssets.fixture("documents/" + theme + ".json").isObject()).as(theme).isTrue());
        assertThat(RuntimeTckAssets.fixture("golden.json").path("controls").has("CTL-01")).isTrue();
        assertThat(RuntimeTckAssets.fixture("fixture-form.json").path("root").isObject()).isTrue();
    }

    @Test
    void theRealProgramsAndFontsComeFromDatumPrograms() {
        assertThat(RuntimeTckAssets.sandboxProgram().kind()).isEqualTo(Program.Kind.SANDBOX);
        assertThat(RuntimeTckAssets.sandboxProgram().size()).isGreaterThan(1000);
        assertThat(RuntimeTckAssets.pdfProgram().size()).isGreaterThan(1000);
        assertThat(RuntimeTckAssets.font("DejaVuSans.ttf")).isNotEmpty();
        assertThat(RuntimeTckAssets.scripts()).isNotNull();
    }
}
