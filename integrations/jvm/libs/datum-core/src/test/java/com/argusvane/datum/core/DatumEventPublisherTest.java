package com.argusvane.datum.core;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.assertThatNullPointerException;

import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * The one guard over every Datum publication: a listener's failure is logged and never reaches the code
 * that published, with the catch set the submission service had (exceptions, linkage errors, failed assertions, a
 * listener's stack overflow); any other {@link Error} (an {@code OutOfMemoryError}) is the JVM's and goes on.
 */
class DatumEventPublisherTest {

    private static final Object EVENT = new Object();

    @Test
    void theGuardedPublisherHandsEveryEventOn() {
        List<Object> seen = new ArrayList<>();
        DatumEventPublisher.guarded(seen::add).publish(EVENT);
        assertThat(seen).containsExactly(EVENT);
    }

    @Test
    void aListenersExceptionIsLoggedNotThrown() {
        assertThatCode(() -> DatumEventPublisher.guarded(event -> {
            throw new IllegalStateException("a listener's bug");
        }).publish(EVENT)).doesNotThrowAnyException();
    }

    @Test
    void aListenersCheckedExceptionIsLoggedNotThrown() {
        assertThatCode(() -> DatumEventPublisher.guarded(event -> sneaky(new java.io.IOException("disk full"))).publish(EVENT))
            .doesNotThrowAnyException();
    }

    @Test
    void aListenersAssertionLinkageAndStackOverflowErrorsAreLoggedNotThrown() {
        for (Error error : List.of(new AssertionError("broken invariant"), new NoClassDefFoundError("missing"),
            new StackOverflowError())) {
            assertThatCode(() -> DatumEventPublisher.guarded(event -> {
                throw error;
            }).publish(EVENT)).as(error.getClass().getSimpleName()).doesNotThrowAnyException();
        }
    }

    @Test
    void anyOtherErrorIsTheJvmsAndGoesOn() {
        assertThatThrownBy(() -> DatumEventPublisher.guarded(event -> {
            throw new OutOfMemoryError("heap");
        }).publish(EVENT)).isInstanceOf(OutOfMemoryError.class);
    }

    @Test
    void guardingTwiceIsOneGuard() {
        DatumEventPublisher once = DatumEventPublisher.guarded(event -> { });
        assertThat(DatumEventPublisher.guarded(once)).isSameAs(once);
        assertThat(DatumEventPublisher.guarded(DatumEventPublisher.noop())).isSameAs(DatumEventPublisher.noop());
        assertThatNullPointerException().isThrownBy(() -> DatumEventPublisher.guarded(null));
    }

    @Test
    void theNoopPublisherDropsEverything() {
        assertThatCode(() -> DatumEventPublisher.noop().publish(EVENT)).doesNotThrowAnyException();
    }

    @SuppressWarnings("unchecked")
    private static <T extends Throwable> void sneaky(Throwable e) throws T {
        throw (T) e;
    }
}
