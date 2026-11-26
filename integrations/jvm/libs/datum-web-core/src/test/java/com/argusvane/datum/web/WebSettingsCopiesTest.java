package com.argusvane.datum.web;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.core.RecordCopies;
import org.junit.jupiter.api.Test;

/** Every component of WebSettings has a withX copy that changes it and nothing else. */
class WebSettingsCopiesTest {

    @Test
    void everyComponentHasACopyThatChangesItAlone() throws ReflectiveOperationException {
        assertThat(RecordCopies.assertCopies(WebSettings.defaults())).isGreaterThanOrEqualTo(1);
    }
}
