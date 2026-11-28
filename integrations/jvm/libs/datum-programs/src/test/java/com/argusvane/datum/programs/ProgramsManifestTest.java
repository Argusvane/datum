package com.argusvane.datum.programs;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.InputStream;
import java.security.MessageDigest;
import java.util.HexFormat;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * The generated programs.json (npm run jvm:assets) travels in the jar and names the two
 * programs' ABIs: a stale or hand-built jar would fail here before a runtime loads a program the
 * host's wire contract does not match (both programs are ABI 1).
 */
class ProgramsManifestTest {

  private static JsonNode read() throws Exception {
    try (InputStream in = ProgramsManifestTest.class.getResourceAsStream("/META-INF/datum/programs/programs.json")) {
      assertThat(in).as("programs.json on the classpath").isNotNull();
      return new ObjectMapper().readTree(in);
    }
  }

  private static int[] parts(String version) {
    String[] pieces = version.split("\\.");
    return new int[] {Integer.parseInt(pieces[0]), Integer.parseInt(pieces[1]), Integer.parseInt(pieces[2])};
  }

  @Test
  void sandboxAbiIsMajorOne() throws Exception {
    int[] abi = parts(read().get("sandboxAbi").asString());
    assertThat(abi[0]).as("sandboxAbi is major 1").isEqualTo(1);
  }

  @Test
  void pdfAbiIsMajorOne() throws Exception {
    assertThat(parts(read().get("pdfAbi").asString())[0]).isEqualTo(1);
  }

  @Test
  void everyListedFileIsOnTheClasspath() throws Exception {
    JsonNode files = read().get("files");
    assertThat(files.size()).isGreaterThan(0);
    for (String name : files.propertyNames()) {
      try (InputStream in = ProgramsManifestTest.class.getResourceAsStream("/META-INF/datum/programs/" + name)) {
        assertThat(in).as(name).isNotNull();
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        assertThat(HexFormat.of().formatHex(digest.digest(in.readAllBytes()))).as("sha256 of " + name).isEqualTo(files.get(name).asString());
      }
    }
  }
}
