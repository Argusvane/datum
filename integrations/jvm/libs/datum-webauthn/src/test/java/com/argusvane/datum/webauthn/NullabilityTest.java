package com.argusvane.datum.webauthn;

import static org.assertj.core.api.Assertions.assertThat;

import java.lang.reflect.RecordComponent;
import java.util.Set;
import org.jspecify.annotations.NullMarked;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.Test;

/** The webauthn package is {@code @NullMarked}, with {@code @Nullable} where a null is meant. */
class NullabilityTest {

    @Test
    void thePackageIsNullMarked() {
        assertThat(WebAuthnVerdict.class.getPackage().isAnnotationPresent(NullMarked.class)).isTrue();
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
    void aVerdictThatPassedHasNoFailureAndAPerFormSettingMayBeLeftToTheSite() {
        assertThat(nullableComponents(WebAuthnVerdict.class)).containsExactlyInAnyOrder("failed", "reason", "credential");
        assertThat(nullableComponents(PasskeySettings.FormSettings.class)).containsExactlyInAnyOrder("mode", "scope", "placement", "userVerification",
            "statement", "verify", "unavailable");
        assertThat(nullableComponents(PasskeyRecord.class)).containsExactlyInAnyOrder("id", "lastUsed", "revoked", "revokedBy", "removed");
    }
}
