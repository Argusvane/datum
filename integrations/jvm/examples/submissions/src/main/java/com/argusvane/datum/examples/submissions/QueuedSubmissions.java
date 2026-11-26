package com.argusvane.datum.examples.submissions;

import com.argusvane.datum.sandbox.protocol.ProgramLimits;
import com.argusvane.datum.submissions.service.FormRef;
import com.argusvane.datum.submissions.service.SubmissionOutcome;
import com.argusvane.datum.submissions.service.SubmissionService;
import com.argusvane.datum.submissions.spi.SubmissionContext;
import com.argusvane.datum.sandbox.spring.DatumSandboxLifecycle;
import com.argusvane.datum.web.json.DatumJsonMapper;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.SmartLifecycle;
import org.springframework.stereotype.Component;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;

/**
 * The example's way in without HTTP: documents put on an
 * in-memory queue (what a message listener, a JDBC batch or a sync endpoint would put there) are taken by one worker and
 * handed to the {@link SubmissionService} bean on channel {@code bus}, the same service the {@code POST /api/submissions}
 * route uses. So a document is judged exactly as the route judges it (the version, the option snapshot, the sandbox, the
 * validators), the example's {@code SubmissionHandler} stores it once whichever way it came first, and the events carry
 * {@code bus}.
 *
 * <p>A message as a broker hands it is bytes ({@link #offer(byte[], String)}): the worker refuses one past the routes' body cap
 * ({@code datum.web.api.max-body-size}, the {@link ProgramLimits} bean) before it reads a byte, and reads the rest with
 * Datum's capped mapper ({@link DatumJsonMapper#create}), so a message costs no more memory than a request would. A tree
 * handed over already parsed ({@link #offer(JsonNode, String)}) meets the service's own cap, the same number.
 *
 * <p>Every message carries the submission key it was sent under, and there is no way to queue one without: a key minted
 * per call would make each redelivery of one message a submission of its own.
 *
 * <p>The queue's own bound is its backpressure, so the context names no throttle key and the throttle does not count it;
 * nor has it a principal or client facts. A real consumer would acknowledge a message after a final outcome
 * ({@code Accepted}, {@code Redelivered}, {@code Rejected}, {@code Outdated}, ...) and leave it for a retry after
 * {@code Unavailable}.
 */
@Component
public class QueuedSubmissions implements SmartLifecycle {

    private static final Logger LOG = LoggerFactory.getLogger(QueuedSubmissions.class);

    /**
     * What the queue holds: a parsed document or a message's bytes, the submission key it was sent under (a broker's
     * message id, the same when the broker delivers it again), and where its outcome goes.
     */
    private record Message(JsonNode document, byte[] bytes, String submissionKey, CompletableFuture<SubmissionOutcome> outcome) {
    }

    private static final SubmissionContext CONTEXT = SubmissionContext.of(SubmissionContext.BUS);

    private final SubmissionService service;
    private final long maxBytes;
    private final DatumJsonMapper json;
    private final BlockingQueue<Message> queue = new LinkedBlockingQueue<>(1_000);
    private volatile boolean running;
    private Thread worker;

    public QueuedSubmissions(SubmissionService service, ProgramLimits limits) {
        this.service = service;
        this.maxBytes = limits.maxBodyBytes();
        this.json = DatumJsonMapper.create(maxBytes);
    }

    /**
     * Puts a parsed document on the queue under its submission key: the same key and document again is answered with
     * the first receipt, the same key with another document is a {@code KeyConflict}.
     *
     * @return the outcome, once the worker judged it; failed at once when the queue is full
     */
    public CompletableFuture<SubmissionOutcome> offer(JsonNode document, String submissionKey) {
        return enqueue(new Message(document, null, submissionKey, new CompletableFuture<>()));
    }

    /**
     * Puts a message's bytes on the queue, as a broker hands them over, under its submission key (the broker's message
     * id): read by the worker under the routes' body cap.
     *
     * @return the outcome, once the worker judged it; failed at once when the queue is full
     */
    public CompletableFuture<SubmissionOutcome> offer(byte[] message, String submissionKey) {
        return enqueue(new Message(null, message, submissionKey, new CompletableFuture<>()));
    }

    private CompletableFuture<SubmissionOutcome> enqueue(Message message) {
        if (!queue.offer(message)) {
            message.outcome().completeExceptionally(new IllegalStateException("The submission queue is full."));
        }
        return message.outcome();
    }

    /**
     * The message's document: the bytes past the cap or not JSON are refused here, in the service's words, before the
     * service is asked (a real consumer would send such a message to its dead-letter queue).
     */
    private Object read(Message message) {
        if (message.document() != null) {
            return message.document();
        }
        if (message.bytes().length > maxBytes) {
            return new SubmissionOutcome.TooLarge(maxBytes);
        }
        try {
            return json.mapper().readTree(message.bytes());
        } catch (JacksonException e) {
            return new SubmissionOutcome.Malformed("The submission is not JSON.");
        }
    }

    private void consume() {
        while (running) {
            Message message;
            try {
                message = queue.poll(250, TimeUnit.MILLISECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            }
            if (message == null) {
                continue;
            }
            try {
                Object read = read(message);
                SubmissionOutcome outcome = read instanceof SubmissionOutcome refused ? refused
                    : service.submit(FormRef.fromDocument(), (JsonNode) read, CONTEXT.withSubmissionKey(message.submissionKey()));
                LOG.info("Queued submission judged: {}.", outcome.getClass().getSimpleName());
                message.outcome().complete(outcome);
            } catch (RuntimeException e) {
                // A hook's own exception: the message is not acknowledged, the worker goes on with the next one.
                message.outcome().completeExceptionally(e);
            } catch (Error e) {
                // The JVM is failing: the caller hears of it, and the worker stops.
                message.outcome().completeExceptionally(e);
                throw e;
            }
        }
    }

    @Override
    public synchronized void start() {
        running = true;
        worker = new Thread(this::consume, "datum-example-queue");
        worker.setDaemon(true);
        worker.start();
    }

    @Override
    public synchronized void stop() {
        running = false;
        if (worker != null) {
            worker.interrupt();
            try {
                worker.join(5_000);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            worker = null;
        }
    }

    @Override
    public boolean isRunning() {
        return running;
    }

    /** After the Datum runtime starts and before it stops: no document is taken while the sandbox is not there. */
    @Override
    public int getPhase() {
        return DatumSandboxLifecycle.PHASE + 1;
    }
}
