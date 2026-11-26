package com.argusvane.datum.sandbox.protocol;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.sandbox.protocol.SandboxException.Reason;
import java.time.Duration;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

/** The run slots: the plain wait, and the patient wait a half-done PDF seal takes (one timed wait, never a poll). */
class RunSlotsTest {

    @Test
    void aPatientWaitTakesTheSlotFreedWithinItsPatience() throws Exception {
        RunSlots slots = new RunSlots(1, Duration.ZERO, "PDF render");
        RunSlots.Permit held = slots.acquire();
        assertThatThrownBy(slots::acquire).isInstanceOfSatisfying(SandboxException.class, e -> {
            assertThat(e.reason()).isEqualTo(Reason.BUSY);
            assertThat(e.getMessage()).isEqualTo("Every PDF render slot (1) is taken.");
        });
        CompletableFuture<RunSlots.Permit> patient = CompletableFuture.supplyAsync(() -> slots.acquire(Duration.ofSeconds(10)));
        Thread.sleep(200);
        assertThat(patient).isNotDone();
        held.close();
        RunSlots.Permit taken = patient.get(5, TimeUnit.SECONDS);
        assertThat(slots.available()).isZero();
        taken.close();
        assertThat(slots.available()).isEqualTo(1);
    }

    @Test
    void aPatientWaitIsNeverShorterThanTheSlotsOwnAndSaysHowLongItWaited() {
        RunSlots slots = new RunSlots(1, Duration.ofSeconds(1), "PDF render");
        try (RunSlots.Permit held = slots.acquire()) {
            long started = System.nanoTime();
            assertThatThrownBy(() -> slots.acquire(Duration.ZERO)).isInstanceOfSatisfying(SandboxException.class, e -> {
                assertThat(e.reason()).isEqualTo(Reason.BUSY);
                assertThat(e.getMessage()).isEqualTo("Every PDF render slot (1) is taken (waited 1 s).");
            });
            assertThat(System.nanoTime() - started).isGreaterThanOrEqualTo(TimeUnit.MILLISECONDS.toNanos(900));
            assertThatThrownBy(() -> slots.acquire(Duration.ofSeconds(2))).isInstanceOfSatisfying(SandboxException.class,
                e -> assertThat(e.getMessage()).isEqualTo("Every PDF render slot (1) is taken (waited 2 s)."));
        }
    }

    /** The slots say when they refuse, whoever asked, so the busy count does not depend on the HTTP mapper. */
    @Test
    void everyBusyRefusalIsToldToTheListenerAndOnlyThose() {
        AtomicInteger busy = new AtomicInteger();
        RunSlots slots = new RunSlots(1, Duration.ZERO, "validation", busy::incrementAndGet);
        try (RunSlots.Permit held = slots.acquire()) {
            assertThat(busy).as("a slot taken is no refusal").hasValue(0);
            assertThatThrownBy(slots::acquire).isInstanceOf(SandboxException.class);
            assertThatThrownBy(() -> slots.acquire(Duration.ZERO)).isInstanceOf(SandboxException.class);
        }
        assertThat(busy).hasValue(2);
        slots.acquire().close();
        assertThat(busy).hasValue(2);
    }

    @Test
    void aListenerThatThrowsLeavesTheRefusalBusy() {
        RunSlots slots = RunSlots.validation(ProgramLimits.defaults(), () -> {
            throw new IllegalStateException("meter registry down");
        });
        java.util.List<RunSlots.Permit> held = new java.util.ArrayList<>();
        try {
            for (int i = 0; i < slots.size(); i++) {
                held.add(slots.acquire());
            }
            RunSlots none = new RunSlots(1, Duration.ZERO, "validation", () -> {
                throw new IllegalStateException("meter registry down");
            });
            try (RunSlots.Permit one = none.acquire()) {
                assertThatThrownBy(none::acquire).isInstanceOfSatisfying(SandboxException.class,
                    e -> assertThat(e.reason()).isEqualTo(Reason.BUSY));
            }
        } finally {
            held.forEach(RunSlots.Permit::close);
        }
    }

    /**
     * Work handed over while a permit is held runs on the same thread once the slot is free again (so a slow trace
     * holds no slot), at once when no permit is held, and whatever it throws never escapes the permit's close.
     */
    @Test
    void workAfterReleaseRunsOnceTheSlotIsFreeOnTheSameThread() {
        RunSlots slots = new RunSlots(1, Duration.ZERO, "validation", null, true);
        java.util.List<String> seen = new java.util.ArrayList<>();
        try (RunSlots.Permit ignored = slots.acquire()) {
            slots.afterRelease(() -> seen.add("after:" + slots.available() + ":" + Thread.currentThread().getName()));
            slots.afterRelease(() -> {
                throw new AssertionError("an observer's bug");
            });
            slots.afterRelease(() -> seen.add("second"));
            seen.add("held:" + slots.available());
        }
        assertThat(seen).containsExactly("held:0", "after:1:" + Thread.currentThread().getName(), "second");
        slots.afterRelease(() -> seen.add("now"));
        assertThat(seen).last().isEqualTo("now");
        RunSlots unmeasured = new RunSlots(1, Duration.ZERO, "validation");
        try (RunSlots.Permit ignored = unmeasured.acquire()) {
            unmeasured.afterRelease(() -> seen.add("unmeasured"));
            assertThat(seen).as("unmeasured slots keep nothing per thread: at once").last().isEqualTo("unmeasured");
        }
    }
}
