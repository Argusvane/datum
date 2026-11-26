package com.argusvane.datum.core;

import static org.assertj.core.api.Assertions.assertThat;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.RecordComponent;
import java.time.Duration;
import java.util.Objects;

/**
 * Checks the {@code withX} copy methods of a settings record, for every library that has settings records
 * (datum-core-test-support, never published). For each component the record has a {@code withX}
 * method; a copy with the component's own value equals the original; and a copy with a changed value holds it in that component
 * and every other component unchanged. A record that gains a component without a copy method, or a copy method that swaps two
 * arguments, fails here.
 */
public final class RecordCopies {

    private RecordCopies() {
    }

    /**
     * @param original a record with at least one component (usually {@code defaults()})
     * @return how many components were changed by a value the record accepted (a value its constructor refuses is skipped)
     */
    public static int assertCopies(Object original) throws ReflectiveOperationException {
        Class<?> type = original.getClass();
        assertThat(type.isRecord()).as(type.getName() + " is a record").isTrue();
        int changed = 0;
        for (RecordComponent component : type.getRecordComponents()) {
            String name = component.getName();
            Method with = type.getMethod("with" + Character.toUpperCase(name.charAt(0)) + name.substring(1), component.getType());
            Object value = component.getAccessor().invoke(original);
            Object same = with.invoke(original, value);
            assertSameComponents(original, same, null);
            if (value != null && value.getClass().isRecord() && hasCopies(value.getClass())) {
                assertCopies(value);
            }
            Object other = alternative(component.getType(), value);
            if (other == null) {
                continue;
            }
            Object copy;
            try {
                copy = with.invoke(original, other);
            } catch (InvocationTargetException refused) {
                continue;
            }
            assertThat(Objects.deepEquals(component.getAccessor().invoke(copy), other)).as(type.getSimpleName() + "." + name + " holds the new value").isTrue();
            assertSameComponents(original, copy, name);
            changed++;
        }
        return changed;
    }

    private static boolean hasCopies(Class<?> type) {
        RecordComponent[] components = type.getRecordComponents();
        if (components.length == 0) {
            return false;
        }
        String name = components[0].getName();
        try {
            type.getMethod("with" + Character.toUpperCase(name.charAt(0)) + name.substring(1), components[0].getType());
            return true;
        } catch (NoSuchMethodException none) {
            return false;
        }
    }

    private static void assertSameComponents(Object original, Object copy, String except) throws ReflectiveOperationException {
        for (RecordComponent component : original.getClass().getRecordComponents()) {
            if (component.getName().equals(except)) {
                continue;
            }
            assertThat(Objects.deepEquals(component.getAccessor().invoke(copy), component.getAccessor().invoke(original)))
                .as(original.getClass().getSimpleName() + "." + component.getName() + " is kept").isTrue();
        }
    }

    private static Object alternative(Class<?> type, Object value) {
        if (type == boolean.class) {
            return !(Boolean) value;
        }
        if (type == int.class) {
            return (Integer) value + 1;
        }
        if (type == long.class) {
            return (Long) value + 1;
        }
        if (type == Long.class && value != null) {
            return (Long) value + 1;
        }
        if (type == Duration.class && value != null) {
            return ((Duration) value).plusSeconds(1);
        }
        return null;
    }
}
