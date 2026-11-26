package com.argusvane.datum.web.error;

import static org.assertj.core.api.Assertions.assertThat;

import java.lang.reflect.RecordComponent;
import org.jspecify.annotations.NullMarked;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.Test;

/** The error model is {@code @NullMarked}; an entry with no field or message says so. */
class NullabilityTest {

    @Test
    void thePackageIsNullMarkedAndAnEntryMayNameNoFieldOrMessage() {
        assertThat(ErrorMapper.class.getPackage().isAnnotationPresent(NullMarked.class)).isTrue();
        for (RecordComponent component : ErrorItem.class.getRecordComponents()) {
            assertThat(component.getAnnotatedType().isAnnotationPresent(Nullable.class)).as(component.getName()).isEqualTo(!component.getName().equals("code"));
        }
    }
}
