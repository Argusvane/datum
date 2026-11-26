package com.argusvane.datum.web.error;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;

/** The problem-details titles are Spring's reason phrases for every status. */
class HttpReasonsParityTest {

    @Test
    void everyStatusHasSpringsPhrase() {
        List<String> differences = new ArrayList<>();
        for (int status = 100; status < 600; status++) {
            HttpStatus spring = HttpStatus.resolve(status);
            String expected = spring == null ? null : spring.getReasonPhrase();
            String ours = HttpReasons.of(status);
            if (expected == null ? ours != null : !expected.equals(ours)) {
                differences.add(status + ": spring " + expected + ", ours " + ours);
            }
        }
        assertThat(differences).isEmpty();
    }
}
