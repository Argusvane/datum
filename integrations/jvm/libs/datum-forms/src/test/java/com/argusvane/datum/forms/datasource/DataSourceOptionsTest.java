package com.argusvane.datum.forms.datasource;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.core.contracts.OptionItem;
import com.argusvane.datum.forms.DataSourceNotFoundException;
import com.argusvane.datum.forms.DataSourceUnavailableException;
import com.argusvane.datum.forms.Fixtures;
import java.security.Principal;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

/** The option snapshot walk over a definition with data-sourced choices (sandbox ABI 2.9.0, {@code optionSnapshot}). */
class DataSourceOptionsTest {

    /** A definition: two plain sources on a select and a scoped select, a select in a grid's row, and a free-text source. */
    private static final String DEFINITION = """
        {"id":"survey","root":{"id":"form","type":"form","configuration":{},"children":{"content":[
          {"id":"country","type":"select","configuration":{"data":{"sourceId":"countries"}}},
          {"id":"where","type":"container","configuration":{},"children":{"default":[
            {"id":"province","type":"select","configuration":{"dataKey":"prov","data":{"sourceId":"provinces"}}}]}},
          {"id":"grid","type":"dataGrid","configuration":{},"collection":{"collectionPath":"grid"},"children":{"content":[
            {"id":"x","type":"select","configuration":{"dataKey":"c1","data":{"sourceId":"countries"}}}]}},
          {"id":"hobby","type":"radio","configuration":{"data":{"sourceId":"hobbies","answersFree":true}}},
          {"id":"plain","type":"select","configuration":{"data":{"answersFree":true}}}
        ]}}}
        """;

    private static final Principal ALICE = () -> "alice";

    /** A provider over fixed lists that records what it was asked. */
    private static final class FakeProvider implements DataSourceProvider {
        final Map<String, List<OptionItem>> sources = new java.util.LinkedHashMap<>();
        final Set<String> freeText = new java.util.HashSet<>();
        final Set<String> failing = new java.util.HashSet<>();
        final List<String> asked = new ArrayList<>();
        final List<Principal> principals = new ArrayList<>();
        long sleepMillis;
        List<String> allowedOverride;

        FakeProvider with(String id, String... values) {
            List<OptionItem> items = new ArrayList<>();
            for (String value : values) {
                items.add(new OptionItem(value, JsonNodeFactory.instance.stringNode(value.toUpperCase()), null, null, null));
            }
            sources.put(id, items);
            return this;
        }

        @Override
        public List<OptionItem> items(String id, String locale, Principal principal) {
            asked.add("items:" + id + ":" + locale);
            principals.add(principal);
            if (sleepMillis > 0) {
                try {
                    Thread.sleep(sleepMillis);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException(e);
                }
            }
            if (failing.contains(id)) {
                throw new IllegalStateException("boom for " + id);
            }
            List<OptionItem> items = sources.get(id);
            if (items == null) {
                throw new DataSourceNotFoundException(id);
            }
            return items;
        }

        @Override
        public boolean exists(String id) {
            return sources.containsKey(id);
        }

        @Override
        public boolean validatesAnswers(String id) {
            return !freeText.contains(id);
        }

        @Override
        public List<String> allowed(String id, List<String> candidates, String locale, Principal principal) {
            asked.add("allowed:" + id + ":" + candidates);
            principals.add(principal);
            if (allowedOverride != null) {
                return allowedOverride;
            }
            return DataSourceProvider.super.allowed(id, candidates, locale, principal);
        }
    }

    private ExecutorService executor;

    @AfterEach
    void stop() {
        if (executor != null) {
            executor.shutdownNow();
        }
    }

    private static FakeProvider provider() {
        FakeProvider provider = new FakeProvider().with("countries", "ca", "us", "mx").with("provinces", "qc", "on").with("hobbies", "chess");
        provider.freeText.add("hobbies");
        return provider;
    }

    /** A small elastic pool like the binding's: a hung provider can hold at most {@code max} threads. */
    private static ExecutorService newExecutor(int max) {
        java.util.concurrent.atomic.AtomicInteger count = new java.util.concurrent.atomic.AtomicInteger();
        return new java.util.concurrent.ThreadPoolExecutor(0, max, 30, java.util.concurrent.TimeUnit.SECONDS,
            new java.util.concurrent.SynchronousQueue<>(), runnable -> {
                Thread thread = new Thread(runnable, "test-data-source-" + count.incrementAndGet());
                thread.setDaemon(true);
                return thread;
            });
    }

    private DataSourceOptions options(FakeProvider provider, Duration timeout) {
        executor = newExecutor(4);
        return new DataSourceOptions(provider, timeout, executor);
    }

    @Test
    void sourceIdsAreFoundAnywhereAndSorted() {
        assertThat(DataSourceOptions.sourceIds(Fixtures.parse(DEFINITION))).containsExactly("countries", "hobbies", "provinces");
        assertThat(DataSourceOptions.sourceIds(Fixtures.endpointFixture())).isEmpty();
    }

    @Test
    void choiceKeysAreTheIdTheDataKeyAndAGridColumnsOwnId() {
        JsonNode definition = Fixtures.parse(DEFINITION);

        assertThat(DataSourceOptions.choiceKeys(definition, "countries")).containsExactlyInAnyOrder("country", "x", "c1");
        assertThat(DataSourceOptions.choiceKeys(definition, "provinces")).containsExactlyInAnyOrder("province", "prov");
        assertThat(DataSourceOptions.choiceKeys(definition, "missing")).as("no choice names it").isNull();
        // A choice with no id and no key to go by makes every text a candidate.
        assertThat(DataSourceOptions.choiceKeys(Fixtures.node("{\"c\":{\"type\":\"select\",\"configuration\":{\"data\":{\"sourceId\":\"s\"}}}}"), "s")).isNull();
    }

    @Test
    void candidateTextsAreTheStringsNumbersAndObjectKeysUnderTheChoicesKeys() {
        ObjectNode answers = Fixtures.parse("""
            {"country":"ca","grid":[{"c1":"us"},{"c1":7}],"note":"not a candidate","prov":{"qc":true,"on":false},
             "longer":{"country[0]":["mx"]}}
            """);

        List<String> candidates = DataSourceOptions.candidateTexts(answers, Set.of("country", "c1", "prov"));

        // The checkboxes-style object contributes its keys; the index brackets of a stored path are ignored.
        assertThat(candidates).containsExactlyInAnyOrder("ca", "us", "7", "qc", "on", "mx");
        assertThat(DataSourceOptions.candidateTexts(answers, null)).contains("not a candidate", "ca");
        assertThat(DataSourceOptions.lastSegment("items[0].size[2]")).isEqualTo("size");
    }

    @Test
    void moreThanTheCapOfCandidatesIsRefusedWholeAndLongTextsAreNoOptionValues() {
        ObjectNode many = JsonNodeFactory.instance.objectNode();
        for (int i = 0; i < DataSourceOptions.MAX_CANDIDATES + 1; i++) {
            many.put("k" + i, "v" + i);
        }
        assertThat(DataSourceOptions.candidateTexts(many, null)).isNull();

        ObjectNode longText = JsonNodeFactory.instance.objectNode().put("country", "x".repeat(DataSourceOptions.MAX_CANDIDATE_BYTES + 1));
        assertThat(DataSourceOptions.candidateTexts(longText, Set.of("country"))).isEmpty();
    }

    @Test
    void validationAsksTheSourceOnlyAboutThePickedAnswersAndKeepsWhatItAllows() {
        FakeProvider provider = provider();
        DataSourceOptions options = options(provider, Duration.ofSeconds(5));
        ObjectNode answers = Fixtures.parse("{\"country\":\"ca\",\"grid\":[{\"c1\":\"zz\"}],\"hobby\":\"anything\"}");

        ObjectNode snapshot = options.snapshotFor(Fixtures.parse(DEFINITION), ALICE, true, answers, "fr");

        // countries: asked about ca and zz, allows ca. provinces: nothing was answered, so an empty entry (every answer refused).
        // hobbies does not validate answers, so it is absent and its choices are marked answersFree instead.
        assertThat(snapshot.toString()).isEqualTo("{\"countries\":[{\"value\":\"ca\"}],\"provinces\":[]}");
        assertThat(provider.asked).contains("allowed:countries:[ca, zz]").doesNotContain("items:hobbies:fr");
        assertThat(provider.asked.stream().filter(a -> a.startsWith("allowed:provinces"))).as("nothing to ask").isEmpty();
        assertThat(provider.principals).as("asked as the person submitting").containsOnly(ALICE);
    }

    @Test
    void withoutAnswersOrForAPdfTheItemsAreResolvedInTheLocale() {
        FakeProvider provider = provider();
        provider.sources.put("provinces", List.of(new OptionItem("qc",
            Fixtures.node("{\"default\":\"Quebec\",\"locales\":{\"de\":\"Quebeck\",\"fr\":\"Quebec (fr)\"}}"),
            Fixtures.node("\"the province\""), null, null)));
        DataSourceOptions options = options(provider, Duration.ofSeconds(5));

        ObjectNode pdf = options.snapshotFor(Fixtures.parse(DEFINITION), null, false, null, "fr");

        assertThat(pdf.path("provinces").toString()).isEqualTo("[{\"value\":\"qc\",\"label\":\"Quebec (fr)\",\"description\":\"the province\"}]");
        assertThat(pdf.path("countries").toString()).startsWith("[{\"value\":\"ca\",\"label\":\"CA\"}");
        assertThat(pdf.has("hobbies")).as("a PDF lists every source that loads, validating or not").isTrue();
        assertThat(options.snapshotFor(Fixtures.parse(DEFINITION), null, false, null, "de").path("provinces").path(0).path("label").asString())
            .isEqualTo("Quebeck");
    }

    @Test
    void aSourceThatFailsLeavesAPdfAloneButStopsAValidation() {
        FakeProvider provider = provider();
        provider.failing.add("provinces");
        DataSourceOptions options = options(provider, Duration.ofSeconds(5));
        JsonNode definition = Fixtures.parse(DEFINITION);

        assertThat(options.snapshotFor(definition, null, false, null, "en").has("provinces")).isFalse();
        assertThatThrownBy(() -> options.snapshotFor(definition, null, true, Fixtures.parse("{\"prov\":\"qc\"}"), "en"))
            .isInstanceOfSatisfying(DataSourceUnavailableException.class, e -> {
                assertThat(e.httpStatus()).isEqualTo(503);
                assertThat(e.code()).isEqualTo("data_source.unavailable");
                assertThat(e.sourceId()).isEqualTo("provinces");
                assertThat(e.getMessage()).as("never what the provider threw").doesNotContain("boom");
            });
    }

    @Test
    void aSourceThatIsTooSlowIsUnavailable() {
        FakeProvider provider = provider();
        provider.sleepMillis = 2000;
        DataSourceOptions options = options(provider, Duration.ofMillis(100));

        assertThatThrownBy(() -> options.snapshotFor(Fixtures.parse(DEFINITION), null, true, Fixtures.parse("{\"country\":\"ca\"}"), "en"))
            .isInstanceOf(DataSourceUnavailableException.class).hasRootCauseInstanceOf(java.util.concurrent.TimeoutException.class);
        assertThatThrownBy(() -> options.items("countries", "en", null)).isInstanceOf(DataSourceUnavailableException.class);
    }

    @Test
    void aProviderThatAllowsMoreThanWasAskedIsHeldToTheQuestion() {
        FakeProvider provider = new FakeProvider().with("countries", "ca");
        provider.allowedOverride = List.of("ca", "never-asked", "ca");
        DataSourceOptions options = options(provider, Duration.ofSeconds(5));

        ObjectNode snapshot = options.snapshotFor(Fixtures.parse(DEFINITION), null, true, Fixtures.parse("{\"country\":\"ca\"}"), "en");

        assertThat(snapshot.path("countries").toString()).isEqualTo("[{\"value\":\"ca\"}]");
    }

    @Test
    void withAnswersFreeMarksFreeSourcesAndStripsWhatAnAuthorWrote() {
        DataSourceOptions options = options(provider(), Duration.ofSeconds(5));
        ObjectNode definition = Fixtures.parse(DEFINITION);
        String before = definition.toString();

        ObjectNode marked = options.withAnswersFree(definition);

        assertThat(definition.toString()).as("the definition itself is not changed").isEqualTo(before);
        JsonNode content = marked.path("root").path("children").path("content");
        assertThat(content.path(3).path("configuration").path("data").path("answersFree").asBoolean()).as("hobbies does not validate").isTrue();
        assertThat(content.path(4).path("configuration").path("data").has("answersFree")).as("an author's own mark is removed").isFalse();
        assertThat(content.path(0).path("configuration").path("data").has("answersFree")).isFalse();
    }

    @Test
    void withAnswersFreeReturnsTheSameDefinitionWhenNothingIsToBeDone() {
        ObjectNode plain = Fixtures.endpointFixture();
        assertThat(options(provider(), Duration.ofSeconds(1)).withAnswersFree(plain)).isSameAs(plain);
    }

    @Test
    void aSourceTheProviderLacksIsLeftUnmarkedAndOutOfTheSnapshot() {
        FakeProvider provider = new FakeProvider().with("countries", "ca");
        DataSourceOptions options = options(provider, Duration.ofSeconds(5));
        ObjectNode definition = Fixtures.parse(DEFINITION);

        ObjectNode snapshot = options.snapshotFor(definition, null, true, Fixtures.parse("{\"country\":\"ca\",\"hobby\":\"x\"}"), "en");

        assertThat(snapshot.propertyNames().stream().toList()).containsExactly("countries");
        assertThat(options.withAnswersFree(definition).path("root").path("children").path("content").path(3).path("configuration").path("data").has("answersFree"))
            .as("the author's mark goes and the host does not set one for a source it lacks").isFalse();
    }

    @Test
    void withoutAProviderThereAreNoOptionsAndTheEndpointIs404() {
        DataSourceOptions none = new DataSourceOptions(null, Duration.ofSeconds(1), null);

        assertThat(none.available()).isFalse();
        assertThat(none.snapshotFor(Fixtures.parse(DEFINITION), null, true, Fixtures.parse("{\"country\":\"ca\"}"), "en")).isEmpty();
        assertThatThrownBy(() -> none.items("countries", "en", null)).isInstanceOfSatisfying(DataSourceNotFoundException.class,
            e -> assertThat(e.httpStatus()).isEqualTo(404));
    }

    @Test
    void itemsComeStraightFromTheProviderForTheEndpoint() {
        FakeProvider provider = provider();
        DataSourceOptions options = options(provider, Duration.ofSeconds(5));

        assertThat(options.items("countries", null, ALICE)).extracting(OptionItem::value).containsExactly("ca", "us", "mx");
        assertThat(provider.asked).containsExactly("items:countries:");
        assertThatThrownBy(() -> options.items("nope", "en", null)).isInstanceOf(DataSourceNotFoundException.class);
    }

    @Test
    void aHugeAnswerKeyOfBracketsIsReadInLinearTimeWithoutOverflowingTheStack() {
        String pairs = "x" + "[]".repeat(500_000);
        String opens = "x" + "[".repeat(500_000);
        assertThat(DataSourceOptions.lastSegment(pairs)).isEqualTo("x");
        assertThat(DataSourceOptions.lastSegment(opens)).isEqualTo(opens);
        assertThat(DataSourceOptions.lastSegment("a.b[1][2]")).isEqualTo("b");
        ObjectNode answers = JsonNodeFactory.instance.objectNode().put(pairs, "ca");
        assertThat(DataSourceOptions.candidateTexts(answers, Set.of("country"))).isEmpty();
    }

    @Test
    void aProviderThatThrowsADatumExceptionOnPurposeIsNotTurnedInto503() {
        DataSourceProvider provider = new DataSourceProvider() {
            @Override
            public List<OptionItem> items(String id, String locale, Principal principal) {
                throw new DataSourceNotFoundException(id);
            }
        };
        executor = newExecutor(2);
        DataSourceOptions options = new DataSourceOptions(provider, Duration.ofSeconds(2), executor);

        assertThatThrownBy(() -> options.items("nope", "en", null)).isInstanceOf(DataSourceNotFoundException.class);
    }

    @Test
    void aProviderWhoseAllowedAnswersNullIsUnavailableNotA500() {
        FakeProvider provider = new FakeProvider().with("countries", "ca");
        DataSourceProvider nullAllowed = new DataSourceProvider() {
            @Override
            public List<OptionItem> items(String id, String locale, Principal principal) {
                return provider.items(id, locale, principal);
            }

            @Override
            public List<String> allowed(String id, List<String> candidates, String locale, Principal principal) {
                return null;
            }
        };
        executor = newExecutor(2);
        DataSourceOptions options = new DataSourceOptions(nullAllowed, Duration.ofSeconds(2), executor);

        assertThatThrownBy(() -> options.snapshotFor(Fixtures.parse(DEFINITION), null, true, Fixtures.parse("{\"country\":\"ca\"}"), "en"))
            .isInstanceOf(DataSourceUnavailableException.class);
    }

    @Test
    void aSourceWhoseExistsCheckFailsIsLeftOutOfAPdfSnapshotAndRefusesValidation() {
        FakeProvider provider = provider();
        DataSourceProvider brokenExists = new DataSourceProvider() {
            @Override
            public boolean exists(String id) {
                if ("provinces".equals(id)) {
                    throw new IllegalStateException("the directory is down");
                }
                return provider.exists(id);
            }

            @Override
            public List<OptionItem> items(String id, String locale, Principal principal) {
                return provider.items(id, locale, principal);
            }
        };
        executor = newExecutor(2);
        DataSourceOptions options = new DataSourceOptions(brokenExists, Duration.ofSeconds(2), executor);

        // A PDF snapshot leaves the broken source out and keeps the others, whichever call of the source failed.
        ObjectNode pdf = options.snapshotFor(Fixtures.parse(DEFINITION), null, false, null, "en");
        assertThat(pdf.has("provinces")).isFalse();
        assertThat(pdf.size()).isEqualTo(DataSourceOptions.sourceIds(Fixtures.parse(DEFINITION)).size() - 1);

        // Validation still refuses: an answer cannot be judged against a source that cannot be reached.
        assertThatThrownBy(() -> options.snapshotFor(Fixtures.parse(DEFINITION), null, true, Fixtures.parse("{\"country\":\"ca\"}"), "en"))
            .isInstanceOf(DataSourceUnavailableException.class);
    }

    @Test
    void oneDeadlineCoversAllTheSourcesOfASnapshot() {
        FakeProvider provider = provider();
        // Every source hangs far past the timeout, so only the deadline can end the snapshot.
        provider.sleepMillis = 30_000;
        Duration timeout = Duration.ofMillis(1000);
        DataSourceOptions options = options(provider, timeout);
        long started = System.nanoTime();

        // A PDF snapshot leaves failing sources out, so it returns; but three hung sources cost one timeout, not three.
        ObjectNode snapshot = options.snapshotFor(Fixtures.parse(DEFINITION), null, false, null, "en");

        Duration elapsed = Duration.ofNanos(System.nanoTime() - started);
        assertThat(snapshot.size()).isZero();
        // Order and bounds, not wall-clock proximity: the deadline was waited for (not given up early) and the
        // wait was one deadline's, well short of three in a row (3 s) and of a source's own 30 s. The 1.5 s of
        // slack above one timeout absorbs a loaded build machine; three sequential timeouts would still fail.
        assertThat(elapsed).isGreaterThanOrEqualTo(timeout.minusMillis(150));
        assertThat(elapsed).isLessThan(timeout.multipliedBy(5).dividedBy(2));
    }

    /**
     * Calls run on any {@link java.util.concurrent.Executor} (Spring's task executor, a virtual-thread executor), a
     * pool that refuses is the source being unavailable.
     */
    @Test
    void anyExecutorRunsTheCalls() {
        java.util.concurrent.atomic.AtomicReference<String> thread = new java.util.concurrent.atomic.AtomicReference<>();
        java.util.concurrent.Executor named = task -> new Thread(task, "app-pool-thread").start();
        FakeProvider backing = new FakeProvider().with("countries", "ca");
        DataSourceProvider seen = new DataSourceProvider() {
            @Override
            public boolean exists(String id) {
                thread.set(Thread.currentThread().getName());
                return backing.exists(id);
            }

            @Override
            public List<OptionItem> items(String id, String locale, Principal principal) {
                return backing.items(id, locale, principal);
            }
        };
        DataSourceOptions options = new DataSourceOptions(seen, Duration.ofSeconds(2), named);
        assertThat(options.items("countries", "en", null)).isNotEmpty();
        assertThat(thread.get()).isEqualTo("app-pool-thread");

        java.util.concurrent.Executor refusing = task -> {
            throw new java.util.concurrent.RejectedExecutionException("full");
        };
        assertThatThrownBy(() -> new DataSourceOptions(seen, Duration.ofSeconds(2), refusing).items("countries", "en", null))
            .isInstanceOf(com.argusvane.datum.forms.DataSourceUnavailableException.class);
    }

    @Test
    void aSubmissionRejectedWhileTheWorkersReturnToWaitingIsRetriedAndAPoolThatStaysFullIsUnavailable() {
        FakeProvider provider = provider();
        // An elastic pool with no queue rejects while every worker is still on its way back to waiting for a task,
        // and takes the next one a moment later: the call goes through, nothing is left out.
        java.util.concurrent.atomic.AtomicInteger rejections = new java.util.concurrent.atomic.AtomicInteger();
        java.util.concurrent.Executor briefly = task -> {
            if (rejections.incrementAndGet() <= 3) {
                throw new java.util.concurrent.RejectedExecutionException("every worker between tasks");
            }
            task.run();
        };
        DataSourceOptions options = new DataSourceOptions(provider, Duration.ofSeconds(2), briefly);
        ObjectNode pdf = options.snapshotFor(Fixtures.parse(DEFINITION), null, false, null, "en");
        assertThat(pdf.size()).isEqualTo(DataSourceOptions.sourceIds(Fixtures.parse(DEFINITION)).size());
        assertThat(rejections.get()).isGreaterThan(3);

        // A pool that stays full is the source being unavailable: a PDF snapshot leaves it out, validation refuses.
        java.util.concurrent.atomic.AtomicInteger asked = new java.util.concurrent.atomic.AtomicInteger();
        java.util.concurrent.Executor full = task -> {
            asked.incrementAndGet();
            throw new java.util.concurrent.RejectedExecutionException("full");
        };
        DataSourceOptions refused = new DataSourceOptions(provider, Duration.ofSeconds(2), full);
        assertThat(refused.snapshotFor(Fixtures.parse(DEFINITION), null, false, null, "en").size()).isZero();
        assertThat(asked.get()).as("a bounded number of tries per call").isEqualTo(3 * 20);
        assertThatThrownBy(() -> refused.snapshotFor(Fixtures.parse(DEFINITION), null, true, Fixtures.parse("{\"country\":\"ca\"}"), "en"))
            .isInstanceOf(DataSourceUnavailableException.class);
    }
}
