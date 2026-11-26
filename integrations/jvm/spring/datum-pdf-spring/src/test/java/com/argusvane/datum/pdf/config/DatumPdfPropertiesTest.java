package com.argusvane.datum.pdf.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.pdf.PdfFonts;
import com.argusvane.datum.pdf.SealPreset;
import com.argusvane.datum.pdf.spring.DatumPdfProperties;
import java.util.List;
import org.junit.jupiter.api.Test;

/** {@code datum.pdf.*} converted for the service: the defaults, the documented words, and words that name nothing. */
class DatumPdfPropertiesTest {

    @Test
    void theDefaultsAreTwoFontsAndNoSeal() {
        DatumPdfProperties properties = new DatumPdfProperties();
        assertThat(properties.isEnabled()).isTrue();
        assertThat(properties.toSettings().fontPack()).isEqualTo(PdfFonts.Pack.DEFAULT);
        SealPreset seal = properties.toSettings().sealPreset();
        assertThat(seal.enabled()).isFalse();
        assertThat(seal.certify()).isEqualTo(SealPreset.Certify.NO_CHANGES);
        assertThat(seal.timestamp()).isTrue();
        assertThat(properties.getSigning().getTsa().getTimeout().toSeconds()).isEqualTo(10);
    }

    /** The literal defaults (kept for the configuration metadata) are the library's. */
    @Test
    void theDefaultsAreTheSettingsDefaults() {
        PdfSettings settings = new DatumPdfProperties().toSettings();
        assertThat(settings).usingRecursiveComparison().isEqualTo(PdfSettings.defaults());
        assertThat(PdfSettings.defaults().fontPack()).isEqualTo(PdfFonts.Pack.DEFAULT);
    }

    @Test
    void thePresetReadsTheBriefsWords() {
        DatumPdfProperties properties = new DatumPdfProperties();
        properties.setFonts("ALL");
        properties.getSeal().setEnabled(true);
        properties.getSeal().setCertify("annotate");
        properties.getSeal().setTimestamp(false);
        properties.getSeal().setLayouts(List.of("copy"));
        properties.getSeal().setReason(" ");
        properties.getSeal().setVisible(false);
        SealPreset seal = properties.toSettings().sealPreset();
        assertThat(properties.toSettings().fontPack()).isEqualTo(PdfFonts.Pack.ALL);
        assertThat(seal.certify().permissions()).isEqualTo(3);
        assertThat(seal.seals("copy")).isTrue();
        assertThat(seal.seals("summary")).isFalse();
        assertThat(seal.reason()).isNull();
        assertThat(seal.visible()).isFalse();
        assertThat(seal.timestamp()).isFalse();
    }

    @Test
    void wordsThatNameNothingFailTheStart() {
        DatumPdfProperties properties = new DatumPdfProperties();
        properties.setFonts("comic");
        assertThatThrownBy(() -> properties.toSettings().fontPack()).hasMessageContaining("datum.pdf.fonts");
        properties.getSeal().setCertify("everything");
        assertThatThrownBy(() -> properties.toSettings().sealPreset()).hasMessageContaining("datum.pdf.seal.certify");
    }
}
