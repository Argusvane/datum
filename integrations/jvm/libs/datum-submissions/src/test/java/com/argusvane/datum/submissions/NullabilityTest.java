package com.argusvane.datum.submissions;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.submissions.spi.AcceptedSubmission;
import com.argusvane.datum.submissions.spi.SubmissionContext;
import com.argusvane.datum.submissions.spi.SubmissionReceipt;
import java.lang.reflect.RecordComponent;
import java.util.Set;
import org.jspecify.annotations.NullMarked;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.Test;

/** Nullability: the submissions SPI is {@code @NullMarked}, with {@code @Nullable} where a null is meant. */
class NullabilityTest {

    @Test
    void theSpiPackageIsNullMarked() {
        assertThat(SubmissionContext.class.getPackage().isAnnotationPresent(NullMarked.class)).isTrue();
    }

    private static Set<String> nullableComponents(Class<? extends Record> type) {
        Set<String> names = new java.util.TreeSet<>();
        for (RecordComponent component : type.getRecordComponents()) {
            if (component.getAnnotatedType().isAnnotationPresent(Nullable.class)) {
                names.add(component.getName());
            }
        }
        return names;
    }

    @Test
    void theOptionalFactsOfARequestAreMarked() {
        assertThat(nullableComponents(SubmissionContext.class)).containsExactlyInAnyOrder("principal", "remoteAddress", "userAgent", "throttleKey", "bodyDigest",
            "submissionKey"); // a check or a dry run carries none
        assertThat(nullableComponents(AcceptedSubmission.class)).containsExactlyInAnyOrder("remoteAddress", "userAgent", "signature", "journeyId", "principal");
        assertThat(nullableComponents(SubmissionReceipt.class)).containsExactlyInAnyOrder("reference", "receipt");
    }
}
