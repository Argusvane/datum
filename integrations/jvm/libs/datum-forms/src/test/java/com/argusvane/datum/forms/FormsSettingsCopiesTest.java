package com.argusvane.datum.forms;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.core.RecordCopies;
import org.junit.jupiter.api.Test;

/** Every component of FormsSettings has a withX copy that changes it and nothing else. */
class FormsSettingsCopiesTest {

    @Test
    void everyComponentHasACopyThatChangesItAlone() throws ReflectiveOperationException {
        assertThat(RecordCopies.assertCopies(FormsSettings.defaults())).isGreaterThanOrEqualTo(4);
    }
}
