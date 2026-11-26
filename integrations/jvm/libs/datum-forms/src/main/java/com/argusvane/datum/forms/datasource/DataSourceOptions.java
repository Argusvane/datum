package com.argusvane.datum.forms.datasource;

import com.argusvane.datum.core.DatumException;
import com.argusvane.datum.core.canonical.CanonicalJson;
import com.argusvane.datum.core.contracts.OptionItem;
import com.argusvane.datum.forms.DataSourceNotFoundException;
import com.argusvane.datum.forms.DataSourceUnavailableException;
import java.nio.charset.StandardCharsets;
import java.security.Principal;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executor;
import java.util.concurrent.FutureTask;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.locks.LockSupport;
import java.util.function.Supplier;
import java.util.regex.Pattern;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

/**
 * The data sources a definition names, and the option snapshot built from them, which the submissions path sends
 * with a validation (sandbox ABI 2.9.0, {@code optionSnapshot}) and the PDF path before a render.
 *
 * <p>Every provider call runs under {@code timeout}. A source that does not answer in time or throws is
 * never judged against: for validation that is {@link DataSourceUnavailableException} (503
 * {@code data_source.unavailable}); for a PDF render the source is left out, so its answers print as stored.
 */
public final class DataSourceOptions {

    /** How deep {@link #candidateTexts} reads a submission's answers for candidates. */
    private static final int CANDIDATE_DEPTH = 64;

    /**
     * The most distinct texts one source is asked about in a submission: a body of
     * 100,000 short strings would otherwise become one query of 100,000 ids. Past it the source is given no
     * options, so every answer to it is refused ({@code option.notAllowed}).
     */
    public static final int MAX_CANDIDATES = 1000;

    /** The longest candidate text, in bytes: an option value is a short key. */
    public static final int MAX_CANDIDATE_BYTES = 512;

    private static final Pattern DATA_KEY = Pattern.compile("^[A-Za-z0-9_-]+$");

    /** How often a rejected submission is retried, and the pause between tries (about 20 ms in all). */
    private static final int SUBMIT_ATTEMPTS = 20;
    private static final long SUBMIT_RETRY_NANOS = TimeUnit.MILLISECONDS.toNanos(1);

    private final DataSourceProvider provider;
    private final Duration timeout;
    private final Executor executor;

    /**
     * @param provider the application's provider, or null when it has none
     * @param timeout how long one provider call may take
     * @param executor runs the calls (any {@link Executor}: Spring's {@code ThreadPoolTaskExecutor}, a virtual-thread
     *     executor, ...); its owner stops it. A pool that is full rejects, and a rejected call is
     *     {@link DataSourceUnavailableException}. Null runs the calls on the caller's thread with no timeout (tests)
     */
    public DataSourceOptions(DataSourceProvider provider, Duration timeout, Executor executor) {
        this.provider = provider;
        this.timeout = timeout;
        this.executor = executor;
    }

    /** Whether the application has a provider; without one the data-source endpoint answers 404. */
    public boolean available() {
        return provider != null;
    }

    /**
     * One source's options, for the data-source endpoint.
     *
     * @throws DataSourceNotFoundException when there is no provider or the source is unknown to it
     * @throws DataSourceUnavailableException on a timeout or a failure
     */
    public List<OptionItem> items(String id, String locale, Principal principal) {
        if (provider == null || !guarded(id, () -> provider.exists(id), null)) {
            throw new DataSourceNotFoundException(id);
        }
        return guarded(id, () -> provider.items(id, locale == null ? "" : locale, principal), null);
    }

    // ---------------------------------------------------------------- the walks

    /** The source ids a definition's components name (a component's {@code configuration.data.sourceId}), sorted. */
    public static List<String> sourceIds(JsonNode definition) {
        Set<String> ids = new TreeSet<>();
        walk(definition, node -> {
            JsonNode id = node.path("configuration").path("data").path("sourceId");
            if (id.isString() && !id.stringValue().isEmpty()) {
                ids.add(id.stringValue());
            }
        });
        return new ArrayList<>(ids);
    }

    /**
     * The options of the data sources a definition names, by source id: sandbox ABI 2.9.0's
     * {@code optionSnapshot}, as the principal may see them.
     *
     * <p>For validation the kernel holds each choice answer to its source's entry and leaves a source the
     * snapshot lacks unchecked. So a source whose {@code validatesAnswers} is off is left out
     * ({@link #withAnswersFree} marks its choices instead), a source the provider lacks is left out, and every
     * other one is given, an empty list when it allows none of the answers. Given the answers, a source is
     * asked through {@code allowed()}, afresh for the person submitting, about every text the answers hold
     * under the keys its choices store (see {@link #candidateTexts}); its entry holds exactly the answers it
     * allows, each as {@code {value}}. Without answers its items are the entry.
     *
     * <p>Otherwise (a PDF) every source that loads gives its items in the locale, validating or not; one that
     * fails is left out.
     *
     * @param forValidation whether the snapshot judges answers
     * @param answers for validation, the values the run judges; null lists each source's items instead
     * @return {@code {sourceId: [{value, label?, description?}]}} in {@link #sourceIds} order
     * @throws DataSourceUnavailableException for validation, when a source could not answer
     */
    public ObjectNode snapshotFor(JsonNode definition, Principal principal, boolean forValidation, ObjectNode answers,
                                  String locale) {
        ObjectNode snapshot = JsonNodeFactory.instance.objectNode();
        if (provider == null) {
            return snapshot;
        }
        String where = locale == null ? "" : locale;
        // One deadline for the whole snapshot: twenty hung sources must not hold a request for twenty timeouts.
        // Callers on a reactive stack run this off the event loop (it blocks while providers answer).
        Instant deadline = Instant.now().plus(timeout);
        for (String id : sourceIds(definition)) {
            try {
                if (!guarded(id, () -> provider.exists(id), deadline)
                    || (forValidation && !guarded(id, () -> provider.validatesAnswers(id), deadline))) {
                    continue;
                }
                if (forValidation && answers != null) {
                    List<String> candidates = candidateTexts(answers, choiceKeys(definition, id));
                    List<String> allowed = candidates == null || candidates.isEmpty() ? List.of()
                        : guarded(id, () -> provider.allowed(id, candidates, where, principal), deadline);
                    ArrayNode entry = snapshot.putArray(id);
                    if (allowed == null) {
                        throw new DataSourceUnavailableException(id, new IllegalStateException("The data source answered allowed() with null, not a list."));
                    }
                    for (String value : allowedTexts(allowed, candidates == null ? List.of() : candidates)) {
                        entry.addObject().put("value", value);
                    }
                    continue;
                }
                snapshot.set(id, DataSourceItems.resolve(guarded(id, () -> provider.items(id, where, principal), deadline), where));
            } catch (DataSourceUnavailableException e) {
                if (forValidation) {
                    throw e;
                }
                // A PDF render does not need the source: its answers print as stored. This covers every call for
                // the source, the exists() check included: once a hung source has spent the shared deadline, the
                // next source's exists() runs on the 1 ms that remains and may time out as well.
            }
        }
        return snapshot;
    }

    /**
     * A copy of a definition whose free-answer sources are marked as such: a choice that names a source set to
     * not validate answers gets {@code configuration.data.answersFree = true} (sandbox ABI 2.10.0), so the
     * kernel skips the option check. A source the provider lacks is left unmarked, so its answers are refused
     * rather than let through.
     *
     * <p>The mark is the host's alone: an {@code answersFree} an author wrote anywhere
     * in the definition is removed, so the builder's switch changes nothing here.
     *
     * @return the definition itself when nothing is to be marked or removed, else a copy
     */
    public ObjectNode withAnswersFree(ObjectNode definition) {
        Set<String> free = new LinkedHashSet<>();
        if (provider != null) {
            for (String id : sourceIds(definition)) {
                if (guarded(id, () -> provider.exists(id), null) && !guarded(id, () -> provider.validatesAnswers(id), null)) {
                    free.add(id);
                }
            }
        }
        if (free.isEmpty() && !writesAnswersFree(definition)) {
            return definition;
        }
        ObjectNode copy = definition.deepCopy();
        walk(copy, node -> {
            JsonNode data = node.path("configuration").path("data");
            if (data.isObject()) {
                ObjectNode object = (ObjectNode) data;
                object.remove("answersFree");
                if (object.path("sourceId").isString() && free.contains(object.path("sourceId").stringValue())) {
                    object.put("answersFree", true);
                }
            }
        });
        return copy;
    }

    private static boolean writesAnswersFree(JsonNode value) {
        boolean[] found = {false};
        walk(value, node -> {
            JsonNode data = node.path("configuration").path("data");
            if (data.isObject() && data.has("answersFree")) {
                found[0] = true;
            }
        });
        return found[0];
    }

    /**
     * The stored key names of the choices that name a source: the component's id, its
     * {@code configuration.dataKey} and, for a journey page's alias, the field it fills. The last segment of a
     * stored path is one of them.
     *
     * @return the names, or null when a choice of the source has none to go by (every text within the caps is
     *     then a candidate)
     */
    public static Set<String> choiceKeys(JsonNode definition, String sourceId) {
        Set<String> names = new LinkedHashSet<>();
        boolean[] unnamed = {false};
        collectKeys(definition, sourceId, names, unnamed);
        return unnamed[0] || names.isEmpty() ? null : names;
    }

    private static void collectKeys(JsonNode value, String sourceId, Set<String> names, boolean[] unnamed) {
        if (value == null) {
            return;
        }
        if (value.isObject()) {
            JsonNode named = value.path("configuration").path("data").path("sourceId");
            if (named.isString() && named.stringValue().equals(sourceId)) {
                List<String> own = new ArrayList<>();
                own.add(textOf(value.path("id")));
                own.add(textOf(value.path("configuration").path("dataKey")));
                own.add(textOf(value.path("configuration").path("fills")));
                own.removeIf(name -> name == null || name.isEmpty());
                names.addAll(own);
                unnamed[0] = unnamed[0] || own.isEmpty();
            }
            for (Map.Entry<String, JsonNode> field : value.properties()) {
                collectKeys(field.getValue(), sourceId, names, unnamed);
            }
        } else if (value.isArray()) {
            for (JsonNode child : value) {
                collectKeys(child, sourceId, names, unnamed);
            }
        }
    }

    /**
     * The texts in a submission's answers the kernel could read as picked: a string, a finite number's text as
     * JavaScript writes it, and an object's keys, at any depth. Given {@code names}, only what lies under a
     * key whose last path segment is one of them counts (a stored path is {@code items[0].size}); null keeps
     * every text. A text longer than {@value #MAX_CANDIDATE_BYTES} bytes is no option value and is left out.
     *
     * @return the distinct texts, or null when there are more than {@value #MAX_CANDIDATES}
     */
    public static List<String> candidateTexts(ObjectNode answers, Set<String> names) {
        Set<String> found = new LinkedHashSet<>();
        for (Map.Entry<String, JsonNode> entry : answers.properties()) {
            if (!collect(entry.getValue(), entry.getKey(), 0, names, names == null, found)) {
                return null;
            }
        }
        return new ArrayList<>(found);
    }

    private static boolean collect(JsonNode value, String key, int depth, Set<String> wanted, boolean inside, Set<String> found) {
        inside = inside || (wanted != null && wanted.contains(lastSegment(key)));
        String text = null;
        if (inside && value.isString()) {
            text = value.stringValue();
        } else if (inside && value.isNumber()) {
            text = CanonicalJson.serialize(value);
        } else if ((value.isObject() || value.isArray()) && depth < CANDIDATE_DEPTH) {
            if (value.isObject()) {
                for (Map.Entry<String, JsonNode> child : value.properties()) {
                    if (inside && !add(child.getKey(), found)) {
                        return false;
                    }
                    if (!collect(child.getValue(), child.getKey(), depth + 1, wanted, inside, found)) {
                        return false;
                    }
                }
            } else {
                // A list keeps its key: its items are that answer's.
                for (JsonNode child : value) {
                    if (!collect(child, key, depth + 1, wanted, inside, found)) {
                        return false;
                    }
                }
            }
        }
        return text == null || add(text, found);
    }

    private static boolean add(String text, Set<String> found) {
        if (text.getBytes(StandardCharsets.UTF_8).length <= MAX_CANDIDATE_BYTES) {
            found.add(text);
        }
        return found.size() <= MAX_CANDIDATES;
    }

    /** The last segment of a stored path: {@code items[0].size} is {@code size}. */
    static String lastSegment(String path) {
        int dot = path.lastIndexOf('.');
        String segment = dot < 0 ? path : path.substring(dot + 1);
        // A scan from the end, not a regex: a key of thousands of "[]" overflowed the stack of the regex engine
        // and a long run of "[" took quadratic time, on attacker-chosen answer keys.
        int end = segment.length();
        while (end > 0 && segment.charAt(end - 1) == ']') {
            int open = segment.lastIndexOf('[', end - 1);
            if (open < 0) {
                break;
            }
            end = open;
        }
        return segment.substring(0, end);
    }

    /**
     * What a source's {@code allowed()} answered, as the texts it allows: distinct, in the order given, and
     * only those that were asked about (a provider is the application's own code, but its answer is read as
     * data).
     */
    public static List<String> allowedTexts(List<String> allowed, List<String> asked) {
        if (allowed == null) {
            throw new IllegalStateException("A data source answered allowed() with null, not a list.");
        }
        Set<String> askedSet = new LinkedHashSet<>(asked);
        Set<String> texts = new LinkedHashSet<>();
        for (String value : allowed) {
            if (value != null && askedSet.contains(value)) {
                texts.add(value);
            }
        }
        return new ArrayList<>(texts);
    }

    /** The stored segment of a node: its data key, else its id. Exposed for the submission walks. */
    public static String storedKey(JsonNode node) {
        String key = textOf(node.path("configuration").path("dataKey"));
        if (key != null && DATA_KEY.matcher(key).matches() && !key.chars().allMatch(Character::isDigit)) {
            return key;
        }
        return textOf(node.path("id"));
    }

    // ---------------------------------------------------------------- calls

    /**
     * Runs one provider call under the timeout (or what remains of {@code deadline}). A {@link DatumException}
     * the provider throws on purpose (not found, access denied) goes on unchanged; anything else is the
     * source being unavailable.
     */
    /**
     * Hands one call to the pool. An elastic pool with no queue (the binding's: core 0, a bound, queue 0) takes a
     * task only on a worker already waiting for one, and rejects once the bound is reached. The snapshot's calls are
     * sequential, but the worker that has just answered one is still on its way back to waiting when the caller
     * submits the next, so a few submissions in a row can each start a new worker and the bound is met with every
     * worker idle (seen on a 2-vCPU runner under JDK 17: a source left out of a PDF
     * snapshot). A rejection is retried a few times over a few milliseconds; a pool that stays full is the source
     * being unavailable.
     */
    private void submit(String id, FutureTask<?> future) {
        RejectedExecutionException rejected = null;
        for (int attempt = 0; attempt < SUBMIT_ATTEMPTS; attempt++) {
            try {
                executor.execute(future);
                return;
            } catch (RejectedExecutionException e) {
                rejected = e;
                LockSupport.parkNanos(SUBMIT_RETRY_NANOS);
            }
        }
        throw new DataSourceUnavailableException(id, rejected);
    }

    private <T> T guarded(String id, Supplier<T> call, Instant deadline) {
        if (executor == null) {
            try {
                return call.get();
            } catch (DatumException e) {
                throw e;
            } catch (RuntimeException e) {
                throw new DataSourceUnavailableException(id, e);
            }
        }
        long millis = timeout.toMillis();
        if (deadline != null) {
            millis = Math.min(millis, Math.max(1, Duration.between(Instant.now(), deadline).toMillis()));
        }
        FutureTask<T> future = new FutureTask<>(call::get);
        submit(id, future);
        try {
            return future.get(millis, TimeUnit.MILLISECONDS);
        } catch (TimeoutException e) {
            future.cancel(true);
            throw new DataSourceUnavailableException(id, e);
        } catch (InterruptedException e) {
            future.cancel(true);
            Thread.currentThread().interrupt();
            throw new DataSourceUnavailableException(id, e);
        } catch (ExecutionException e) {
            Throwable cause = e.getCause() != null ? e.getCause() : e;
            if (cause instanceof DatumException datum) {
                throw datum;
            }
            throw new DataSourceUnavailableException(id, cause);
        }
    }

    private static String textOf(JsonNode node) {
        return node != null && node.isString() ? node.stringValue() : null;
    }

    /** Calls {@code onObject} for every object in the tree, the root included. */
    private static void walk(JsonNode value, java.util.function.Consumer<JsonNode> onObject) {
        if (value == null) {
            return;
        }
        if (value.isObject()) {
            onObject.accept(value);
        }
        if (value.isContainer()) {
            for (JsonNode child : value.values()) {
                walk(child, onObject);
            }
        }
    }
}
