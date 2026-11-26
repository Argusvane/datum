package com.argusvane.datum.webauthn;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.core.RecordCopies;
import org.junit.jupiter.api.Test;

/** Every component of PasskeySettings has a withX copy that changes it and nothing else. */
class PasskeySettingsCopiesTest {

    @Test
    void everyComponentHasACopyThatChangesItAlone() throws ReflectiveOperationException {
        assertThat(RecordCopies.assertCopies(PasskeySettings.defaults())).isGreaterThanOrEqualTo(3);
    }
}
