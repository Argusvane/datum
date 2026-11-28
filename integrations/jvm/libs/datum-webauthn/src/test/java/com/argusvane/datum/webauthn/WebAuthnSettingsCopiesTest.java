package com.argusvane.datum.webauthn;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.core.DatumConfigurationException;
import com.argusvane.datum.core.RecordCopies;
import java.util.List;
import org.junit.jupiter.api.Test;

/** The copies of the ceremony settings, and the signing words that are refused rather than defaulted. */
class WebAuthnSettingsCopiesTest {

    @Test
    void everyComponentHasACopyThatChangesItAlone() throws ReflectiveOperationException {
        assertThat(RecordCopies.assertCopies(new WebAuthnSettings("localhost", "Petition", List.of("http://localhost"), null, true, false, null, null, null, null)))
            .isGreaterThanOrEqualTo(2);
    }

    /** {@code FormSigning.builder().userVerification("Required")} used to become {@code preferred}: a quiet downgrade. */
    @Test
    void anUnknownSigningWordIsRefusedNotReadAsTheDefault() {
        assertThatThrownBy(() -> FormSigning.builder().userVerification("Required").build())
            .isInstanceOfSatisfying(DatumConfigurationException.class, refusal -> {
                assertThat(refusal.getMessage()).contains("'Required'").contains("[required, preferred]");
                assertThat(refusal.action()).contains("lower case");
            });
        assertThatThrownBy(() -> FormSigning.builder().scope("everything").build()).isInstanceOf(DatumConfigurationException.class);
        assertThatThrownBy(() -> FormSigning.builder().placement("beside").build()).isInstanceOf(DatumConfigurationException.class);
        assertThatThrownBy(() -> FormSigning.builder().unavailable("maybe").build()).isInstanceOf(DatumConfigurationException.class);
    }

    @Test
    void anUnsetOrBlankWordIsTheDefault() {
        FormSigning signing = FormSigning.builder().scope(null).placement("").userVerification(null).unavailable("").build();
        assertThat(signing.scope()).isEqualTo("envelope");
        assertThat(signing.placement()).isEqualTo("embedded");
        assertThat(signing.userVerification()).isEqualTo("preferred");
        assertThat(signing.unavailable()).isEqualTo("refuse");
        assertThat(FormSigning.builder().userVerification("required").build().requiresUserVerification()).isTrue();
    }
}
