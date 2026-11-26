package com.argusvane.datum.ui;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.core.RecordCopies;
import org.junit.jupiter.api.Test;

/** Every component of UiSettings has a withX copy that changes it and nothing else. */
class UiSettingsCopiesTest {

    @Test
    void everyComponentHasACopyThatChangesItAlone() throws ReflectiveOperationException {
        assertThat(RecordCopies.assertCopies(UiSettings.defaults())).isGreaterThanOrEqualTo(1);
    }
}
