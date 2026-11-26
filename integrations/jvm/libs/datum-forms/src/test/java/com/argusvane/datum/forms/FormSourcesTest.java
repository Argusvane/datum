package com.argusvane.datum.forms;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Test;

/**
 * The framework-free half of {@code datum.forms.locations}: the key rule in one place and a file read as a
 * definition in one place. The {@code file:} and {@code classpath:} globs are Spring's own resolver's, in the
 * binding.
 */
class FormSourcesTest {

    @Test
    void theKeyRuleIsWrittenOnce() {
        assertThat(FormKeys.isValid("intake.v2_x-1")).isTrue();
        assertThat(FormKeys.isValid("a".repeat(128))).isTrue();
        assertThat(FormKeys.isValid("a".repeat(129))).isFalse();
        assertThat(FormKeys.isValid("")).isFalse();
        assertThat(FormKeys.isValid(null)).isFalse();
        assertThat(FormKeys.isValid("a/b")).isFalse();
        assertThat(FormKeys.isValid("intake@1")).isFalse();
        assertThatThrownBy(() -> FormKeys.validate("a b", "file:/x/bad.json")).isInstanceOf(IllegalStateException.class)
            .hasMessage("The form definition file:/x/bad.json has the key \"a b\", which is not 1 to 128 letters, digits, dots, "
                + "hyphens or underscores. Rename the file or change its id.");
    }

    @Test
    void aFileIsReadAsOneJsonObject() {
        assertThat(FormSources.read("x", "{\"id\":\"a\"}".getBytes(StandardCharsets.UTF_8)).path("id").asString()).isEqualTo("a");
        assertThatThrownBy(() -> FormSources.read("file:/x/list.json", "[1]".getBytes(StandardCharsets.UTF_8)))
            .isInstanceOf(IllegalStateException.class).hasMessage("The form definition file:/x/list.json is not a JSON object.");
        assertThatThrownBy(() -> FormSources.read("file:/x/broken.json", "{".getBytes(StandardCharsets.UTF_8)))
            .isInstanceOf(IllegalStateException.class).hasMessageStartingWith("The form definition file:/x/broken.json cannot be read as JSON: ");
    }
}
