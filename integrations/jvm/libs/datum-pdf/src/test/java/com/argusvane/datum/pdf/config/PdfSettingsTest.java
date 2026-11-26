package com.argusvane.datum.pdf.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * The verify cap's clamp ({@code datum.runtime.verify-max-bytes}, 1 MiB to 100 MiB): the bound, the default, the WARN words the
 * sandbox's limits use, and the record's refusal of a value that did not come through the clamp. The WARN text goes to a sink so
 * the test reads it without a logging backend.
 */
class PdfSettingsTest {

    private static final String WARN_ZERO = "datum limit verifyMaxBytes = 0 is outside [1048576, 104857600]; using 20971520.";

    @Test
    void noValueIsTheDefaultWithNoWarning() {
        List<String> warnings = new ArrayList<>();
        assertThat(PdfSettings.clampVerifyMaxBytes(null, warnings::add)).isEqualTo(20L * 1024 * 1024);
        assertThat(warnings).isEmpty();
    }

    @Test
    void zeroAndNegativeFallToTheDefaultAndSayWhy() {
        List<String> warnings = new ArrayList<>();
        assertThat(PdfSettings.clampVerifyMaxBytes(0L, warnings::add)).isEqualTo(PdfSettings.VERIFY_DEFAULT_BYTES);
        assertThat(PdfSettings.clampVerifyMaxBytes(-1L, warnings::add)).isEqualTo(PdfSettings.VERIFY_DEFAULT_BYTES);
        assertThat(warnings).containsExactly(WARN_ZERO,
            "datum limit verifyMaxBytes = -1 is outside [1048576, 104857600]; using 20971520.");
    }

    @Test
    void aValueBelowTheFloorIsRaisedAndAValueAboveTheCeilingIsLowered() {
        List<String> warnings = new ArrayList<>();
        assertThat(PdfSettings.clampVerifyMaxBytes(1024L, warnings::add)).isEqualTo(PdfSettings.VERIFY_MIN_BYTES);
        assertThat(PdfSettings.clampVerifyMaxBytes(1L << 30, warnings::add)).isEqualTo(PdfSettings.VERIFY_MAX_BYTES);
        assertThat(warnings).containsExactly(
            "datum limit verifyMaxBytes = 1024 is outside [1048576, 104857600]; using 1048576.",
            "datum limit verifyMaxBytes = 1073741824 is outside [1048576, 104857600]; using 104857600.");
    }

    @Test
    void aValueInsideTheBoundsPassesUnchangedWithNoWarning() {
        List<String> warnings = new ArrayList<>();
        assertThat(PdfSettings.clampVerifyMaxBytes(PdfSettings.VERIFY_MIN_BYTES, warnings::add)).isEqualTo(PdfSettings.VERIFY_MIN_BYTES);
        assertThat(PdfSettings.clampVerifyMaxBytes(PdfSettings.VERIFY_MAX_BYTES, warnings::add)).isEqualTo(PdfSettings.VERIFY_MAX_BYTES);
        assertThat(PdfSettings.clampVerifyMaxBytes(30L * 1024 * 1024, warnings::add)).isEqualTo(30L * 1024 * 1024);
        assertThat(warnings).isEmpty();
    }

    @Test
    void theRecordRefusesAValueThatDidNotComeThroughTheClamp() {
        assertThatThrownBy(() -> PdfSettings.defaults().withVerifyMaxBytes(0))
            .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("clampVerifyMaxBytes");
        assertThatThrownBy(() -> PdfSettings.defaults().withVerifyMaxBytes(PdfSettings.VERIFY_MIN_BYTES - 1))
            .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> PdfSettings.defaults().withVerifyMaxBytes(PdfSettings.VERIFY_MAX_BYTES + 1))
            .isInstanceOf(IllegalArgumentException.class);
        assertThat(PdfSettings.defaults().verifyMaxBytes()).isEqualTo(PdfSettings.VERIFY_DEFAULT_BYTES);
    }
}
