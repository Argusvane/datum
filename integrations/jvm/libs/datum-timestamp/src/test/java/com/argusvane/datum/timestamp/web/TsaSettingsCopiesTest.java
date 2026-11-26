package com.argusvane.datum.timestamp.web;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.core.RecordCopies;
import org.junit.jupiter.api.Test;

/** Every component of TsaSettings has a withX copy that changes it and nothing else. */
class TsaSettingsCopiesTest {

    @Test
    void everyComponentHasACopyThatChangesItAlone() throws ReflectiveOperationException {
        assertThat(RecordCopies.assertCopies(TsaSettings.defaults())).isGreaterThanOrEqualTo(3);
    }
}
