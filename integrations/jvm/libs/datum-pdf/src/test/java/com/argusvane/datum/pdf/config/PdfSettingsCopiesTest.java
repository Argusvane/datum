package com.argusvane.datum.pdf.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.core.DatumConfigurationException;
import com.argusvane.datum.core.RecordCopies;
import org.junit.jupiter.api.Test;

/** The copies of the PDF settings, and the words checked where the settings are built. */
class PdfSettingsCopiesTest {

    @Test
    void everyComponentOfTheSettingsAndTheirPartsHasACopyThatChangesItAlone() throws ReflectiveOperationException {
        assertThat(RecordCopies.assertCopies(PdfSettings.defaults())).isGreaterThanOrEqualTo(1);
        assertThat(RecordCopies.assertCopies(PdfSettings.Seal.defaults())).isGreaterThanOrEqualTo(2);
        assertThat(RecordCopies.assertCopies(PdfSettings.Tsa.defaults())).isGreaterThanOrEqualTo(1);
        assertThat(RecordCopies.assertCopies(PdfSettings.Signing.defaults())).isGreaterThanOrEqualTo(0);
    }

    @Test
    void aCopyWithAFontWordThatNamesNoPackStopsAtTheCopy() {
        assertThatThrownBy(() -> PdfSettings.defaults().withFonts("everything"))
            .isInstanceOfSatisfying(DatumConfigurationException.class, refusal -> assertThat(refusal.property()).isEqualTo("datum.pdf.fonts"));
        assertThat(PdfSettings.defaults().withFonts("ALL").fontPack()).isNotNull();
    }

    @Test
    void aBadCertifyWordStopsWhereTheSealIsBuiltNotAtTheFirstUse() {
        assertThatThrownBy(() -> PdfSettings.Seal.defaults().withCertify("sometimes"))
            .isInstanceOfSatisfying(DatumConfigurationException.class, refusal -> assertThat(refusal.property()).isEqualTo("datum.pdf.seal.certify"));
        assertThat(PdfSettings.defaults().withSeal(PdfSettings.Seal.defaults().withCertify("formFill")).sealPreset()).isNotNull();
    }
}
