package com.argusvane.datum.core;

/**
 * Where the libraries hand their events ({@code FormDefinitionSavedEvent}, {@code SubmissionValidatedEvent},
 * {@code SandboxReadyEvent}, {@code PdfRenderedEvent}, {@code PdfVerifiedEvent}, {@code TimestampIssuedEvent}, ...),
 * without naming a framework (integrations/jvm/README.md "Libraries and bindings").
 *
 * <p>Each host binding adapts its own bus: Spring passes {@code ApplicationEventPublisher::publishEvent}, and a Quarkus
 * binding would pass CDI's {@code Event<Object>}. A publisher delivers synchronously on the calling thread when the bus does (Spring's
 * default multicaster does). The contract: every event follows the effect it
 * reports (the submission handled, the PDF made, the token issued, the passkey stored). A host's DEFAULT publisher is
 * {@link #guarded}: a listener that fails (an {@link Exception}, a {@link LinkageError}, an {@link AssertionError}, a
 * {@link StackOverflowError}) is logged and never changes Datum's answer or undoes the effect, so through it a listener
 * cannot veto; a rule that must refuse is a {@code *Customizer}, {@code *Validator} or {@code *Check} hook. The guard is the host binding's to apply to the default it builds (the Spring binding's
 * {@code datumEventPublisher} bean is {@code guarded(SpringEventPublisher)}); a library uses the publisher it is given as
 * given. An application's own publisher therefore owns its failure semantics: one that throws (an outbox
 * write that failed) reaches the code that published, after the effect, and fails the operation there (the caller sees
 * the failure though the submission was stored or the token issued), which is what a publisher whose failure must
 * surface wants; a publisher that must not fail the operation guards itself with {@link #guarded}. Each event's javadoc
 * says when it is published and whether it can be inside a caller's transaction. Whether a listener runs on the calling
 * thread is the application's choice (an asynchronous multicaster or {@code @Async}). Libraries built without a bus take
 * {@link #noop()}.
 */
@FunctionalInterface
public interface DatumEventPublisher {

    /** Hands {@code event} to the host's listeners. */
    void publish(Object event);

    /** A publisher that drops every event. */
    static DatumEventPublisher noop() {
        return NoopEventPublisher.INSTANCE;
    }

    /**
     * {@code publisher} behind the one guard: a listener's failure is logged under {@code datum.events}
     * and never reaches the code that published; an {@code OutOfMemoryError} or another {@link VirtualMachineError}
     * but a stack overflow still does. Guarding a guarded publisher, or {@link #noop()}, answers it as it is.
     */
    static DatumEventPublisher guarded(DatumEventPublisher publisher) {
        java.util.Objects.requireNonNull(publisher, "publisher");
        if (publisher instanceof GuardedEventPublisher || publisher == NoopEventPublisher.INSTANCE) {
            return publisher;
        }
        return new GuardedEventPublisher(publisher);
    }
}
