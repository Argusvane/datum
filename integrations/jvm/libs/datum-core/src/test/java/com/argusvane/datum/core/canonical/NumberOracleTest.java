package com.argusvane.datum.core.canonical;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.core.RepoFixtures;
import java.io.InputStream;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import java.util.zip.GZIPInputStream;
import org.junit.jupiter.api.Test;
import tools.jackson.core.JsonParser;
import tools.jackson.core.JsonToken;

/**
 * Holds the number formatter to node's {@code JSON.stringify} over the generated oracle
 * ({@code integrations/shared/scripts/number-oracle.mjs}, read from {@code integrations/shared/fixtures}): random bit patterns across every exponent, every power of two and ten with
 * neighbours, subnormals, integers around 2^53, the layout thresholds and the RFC 8785 appendix B values. One
 * test streams the file and collects mismatches, so a failure lists the first twenty rather than 340,000 cases.
 */
class NumberOracleTest {

    @Test
    void everyOracleCaseIsWrittenTheWayNodeWritesIt() throws Exception {
        List<String> mismatches = new ArrayList<>();
        long cases = 0;
        long wrong = 0;
        try (InputStream raw = Files.newInputStream(RepoFixtures.root().resolve("integrations/shared/fixtures/number-oracle.json.gz"));
             GZIPInputStream gz = new GZIPInputStream(raw);
             JsonParser p = RepoFixtures.MAPPER.createParser(gz)) {
            assertThat(p.nextToken()).isEqualTo(JsonToken.START_ARRAY);
            while (p.nextToken() == JsonToken.START_ARRAY) {
                p.nextToken();
                long bits = Long.parseUnsignedLong(p.getString(), 16);
                p.nextToken();
                String expected = p.getString();
                p.nextToken();
                double value = Double.longBitsToDouble(bits);
                String ours = CanonicalJson.number(value);
                cases++;
                if (!ours.equals(expected)) {
                    wrong++;
                    if (mismatches.size() < 20) {
                        mismatches.add(Long.toHexString(bits) + " " + value + ": expected " + expected + " got " + ours);
                    }
                }
            }
        }
        assertThat(cases).isGreaterThanOrEqualTo(200_000);
        assertThat(mismatches).as(wrong + " mismatches of " + cases + "; first ones").isEmpty();
    }

    @Test
    void theDoublesTheWebauthnReviewFoundAreWrittenAsNodeWritesThem() {
        // Just above a power of two the nearest p-digit decimal may not read back while the next one up does.
        assertThat(CanonicalJson.number(Math.pow(2, -24))).isEqualTo("5.960464477539063e-8");
        assertThat(CanonicalJson.number(Math.pow(2, -44))).isEqualTo("5.684341886080802e-14");
        assertThat(CanonicalJson.number(Math.pow(2, 89))).isEqualTo("6.189700196426902e+26");
        assertThat(CanonicalJson.number(6.617444900424222e-24)).isEqualTo("6.617444900424222e-24");
        assertThat(CanonicalJson.number(-0.0)).isEqualTo("0");
        assertThat(CanonicalJson.number(1e21)).isEqualTo("1e+21");
        assertThat(CanonicalJson.number(9.999999999999999e20)).isEqualTo("999999999999999900000");
    }
}
