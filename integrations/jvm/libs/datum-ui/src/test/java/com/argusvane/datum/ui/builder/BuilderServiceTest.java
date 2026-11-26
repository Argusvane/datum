package com.argusvane.datum.ui.builder;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.core.DatumException;
import com.argusvane.datum.sandbox.protocol.SandboxService;
import com.argusvane.datum.ui.UiSettings;
import com.argusvane.datum.forms.DefinitionService;
import com.argusvane.datum.forms.FormDefinitionRepository;
import com.argusvane.datum.forms.FormStoreReadOnlyException;
import com.argusvane.datum.forms.SavedForm;
import com.argusvane.datum.forms.snapshot.InMemoryDefinitionSnapshotStore;
import com.argusvane.datum.forms.translation.InMemoryTranslationCatalogStore;
import com.argusvane.datum.forms.web.FormsReply;
import com.argusvane.datum.web.error.ErrorMapper;
import java.security.Principal;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

/**
 * The builder's writes with no transport: an import job or a git sync gets the outcome the routes map, from
 * the same steps (the existence and the expected hash, strict JSON, the shape, the language changes, the kernel's check,
 * the store under the lock), and the routes over a shared service answer exactly as {@link BuilderApiTest} pins them.
 */
class BuilderServiceTest {

    static final String KEY = BuilderFixtures.KEY;
    static final Clock CLOCK = Clock.fixed(Instant.parse("2026-10-17T10:15:30.700Z"), ZoneOffset.UTC);
    static final Principal AUTHOR = () -> "author";

    KernelStub kernel;
    MemoryRepository repository;
    InMemoryTranslationCatalogStore catalogs;
    List<Object> events;
    DefinitionService definitions;
    BuilderService service;
    String baseHash;

    @BeforeEach
    void setUp() {
        kernel = new KernelStub();
        SandboxService sandbox = kernel.service();
        repository = new MemoryRepository();
        catalogs = new InMemoryTranslationCatalogStore();
        events = Collections.synchronizedList(new ArrayList<>());
        definitions = DefinitionService.builder().repository(repository).snapshots(new InMemoryDefinitionSnapshotStore(100, warning -> { })).sandbox(() -> sandbox).events(events::add).publicCacheSize(16).build();
        service = BuilderService.builder().repository(repository).definitions(definitions).translations(catalogs).types(BuilderApiTest.TYPES).clock(CLOCK).build();
        repository.seed(BuilderFixtures.base());
        baseHash = repository.hashOf(KEY);
    }

    private static ObjectNode edited() {
        ObjectNode definition = BuilderFixtures.base();
        BuilderFixtures.content(definition).addObject().put("id", "extra").put("type", "text").putObject("configuration");
        return definition;
    }

    @Test
    void aSaveThatBuildsOnTheCurrentHashIsSavedWithTheHashTheRepositoryStored() {
        BuilderOutcome outcome = service.save(KEY, edited(), baseHash, AUTHOR);

        assertThat(outcome).isInstanceOf(BuilderOutcome.Saved.class);
        BuilderOutcome.Saved saved = (BuilderOutcome.Saved) outcome;
        assertThat(saved.sha256()).isEqualTo(repository.hashOf(KEY)).isNotEqualTo(baseHash);
        assertThat(saved.created()).isFalse();
        assertThat(saved.savedAt()).isEqualTo(Instant.parse("2026-10-17T10:15:30Z"));
        assertThat(repository.expectedHashes()).containsExactly(baseHash);
        assertThat(kernel.checks()).hasSize(1);
    }

    @Test
    void eachRefusalComesInTheRoutesOrderAndStoresNothing() {
        assertThat(service.save("missing", edited(), null, AUTHOR)).isEqualTo(new BuilderOutcome.NotFound("missing"));
        assertThat(service.save("not a key!", edited(), null, AUTHOR)).isEqualTo(new BuilderOutcome.NotFound("not a key!"));

        BuilderOutcome stale = service.save(KEY, edited(), "0".repeat(64), AUTHOR);
        assertThat(stale).isEqualTo(new BuilderOutcome.Outdated(baseHash, BuilderFixtures.base().path("version").stringValue()));

        ObjectNode lone = edited();
        lone.put("title", "\uDC00");
        assertThat(service.save(KEY, lone, null, AUTHOR)).isEqualTo(new BuilderOutcome.Malformed("The definition is not JSON."));

        ObjectNode renamed = edited();
        renamed.put("id", "another");
        assertThat(service.save(KEY, renamed, null, AUTHOR)).isInstanceOfSatisfying(BuilderOutcome.Refused.class,
            refused -> assertThat(refused.errors()).extracting(DefinitionShape.Finding::code).containsExactly("definition.id.mismatch"));

        ObjectNode huge = edited();
        huge.put("n", java.math.BigInteger.TEN.pow(400));
        assertThat(service.save(KEY, huge, null, AUTHOR)).isInstanceOfSatisfying(BuilderOutcome.Refused.class,
            refused -> assertThat(refused.errors()).extracting(DefinitionShape.Finding::code).containsExactly("definition.number.nonFinite"));

        assertThat(kernel.checks()).as("no refusal so far reached the kernel").isEmpty();
        assertThat(repository.saves()).isZero();
        assertThat(events).isEmpty();
    }

    @Test
    void theKernelsRefusalAndAnUnavailableKernelStoreNothing() {
        ObjectNode risky = BuilderFixtures.riskyPattern();
        kernel.answer(risky, BuilderFixtures.capturedAnswer("riskyPattern"));
        assertThat(service.save(KEY, risky, null, AUTHOR)).isInstanceOfSatisfying(BuilderOutcome.Refused.class, refused -> {
            assertThat(refused.code()).isEqualTo("definition.refused");
            assertThat(refused.errors()).extracting(DefinitionShape.Finding::code).containsExactly("pattern.risky");
        });

        kernel.mode(KernelStub.Mode.UNAVAILABLE);
        assertThat(service.save(KEY, edited(), null, AUTHOR)).isInstanceOfSatisfying(BuilderOutcome.Unavailable.class,
            unavailable -> assertThat(unavailable.code()).isEqualTo("server.unavailable"));
        assertThat(repository.saves()).isZero();
    }

    @Test
    void aCreateOfAnExistingIdIsExistsAndANewOneIsCreated() {
        assertThat(service.create(BuilderFixtures.base(), AUTHOR)).isEqualTo(new BuilderOutcome.Exists(KEY, baseHash));

        ObjectNode other = BuilderFixtures.base();
        other.put("id", "other-form");
        assertThat(service.create(other, AUTHOR)).isInstanceOfSatisfying(BuilderOutcome.Saved.class, saved -> {
            assertThat(saved.created()).isTrue();
            assertThat(saved.key()).isEqualTo("other-form");
        });
    }

    @Test
    void aRepositoryThatCannotSaveIsReadOnly() {
        FormStoreReadOnlyException readOnly = new FormStoreReadOnlyException();
        // The stored definition is the seeded one; every save is refused, as the resource repository refuses it.
        FormDefinitionRepository fixed = new FormDefinitionRepository() {
            @Override
            public java.util.Optional<ObjectNode> find(String key) {
                return repository.find(key);
            }

            @Override
            public SavedForm save(ObjectNode definition) {
                throw readOnly;
            }

            @Override
            public SavedForm save(ObjectNode definition, String expectedSha256) {
                throw readOnly;
            }
        };
        SandboxService sandbox = kernel.service();
        BuilderService over = BuilderService.builder().repository(fixed).definitions(DefinitionService.builder().repository(fixed).snapshots(new InMemoryDefinitionSnapshotStore(100, warning -> { }))
            .sandbox(() -> sandbox).events(events::add).publicCacheSize(16).build()).translations(catalogs).types(BuilderApiTest.TYPES).clock(CLOCK).build();

        assertThat(over.save(KEY, edited(), null, AUTHOR)).isEqualTo(new BuilderOutcome.ReadOnly(readOnly));
    }

    @Test
    void theLanguageChangesMoveTheCatalogWithTheSave() {
        catalogs.write(KEY, BuilderApiTest.cat("{\"en\":{\"form\":{\"title\":\"Hello\"}},\"fr\":{\"form\":{\"title\":\"Bonjour\"}}}"), null);
        LocaleChanges changes = new LocaleChanges(List.of(), List.of(new LocaleChanges.Rename("fr", "fr-CA")));

        BuilderOutcome outcome = service.save(KEY, edited(), null, changes, AUTHOR);

        assertThat(outcome).isInstanceOfSatisfying(BuilderOutcome.Saved.class,
            saved -> {
                assertThat(saved.catalog().path("fr-CA").path("form").path("title").asString()).isEqualTo("Bonjour");
                assertThat(saved.catalog().has("fr")).isFalse();
            });
    }

    @Test
    void aCatalogWriteChecksItsEtagItsDepthAndItsShape() {
        String etag = catalogs.read(KEY).etag();
        assertThat(service.saveTranslations(KEY, JsonNodeFactory.instance.objectNode(), "nope", AUTHOR))
            .isEqualTo(new BuilderOutcome.CatalogOutdated(etag));

        ObjectNode deep = JsonNodeFactory.instance.objectNode();
        ObjectNode node = deep;
        for (int i = 0; i < 40; i++) {
            node = node.putObject("n");
        }
        assertThat(service.saveTranslations(KEY, deep, null, AUTHOR)).isEqualTo(new BuilderOutcome.Malformed("The catalog is not JSON."));

        assertThat(service.saveTranslations(KEY, JsonNodeFactory.instance.arrayNode(), null, AUTHOR))
            .isInstanceOfSatisfying(BuilderOutcome.Refused.class, refused -> assertThat(refused.code()).isEqualTo("catalog.invalid"));

        ObjectNode catalog = JsonNodeFactory.instance.objectNode();
        catalog.putObject("en").putObject("form").put("title", "Hello");
        assertThat(service.saveTranslations("missing", catalog, null, AUTHOR)).isEqualTo(new BuilderOutcome.NotFound("missing"));
        assertThat(service.saveTranslations(KEY, catalog, etag, AUTHOR)).isInstanceOfSatisfying(BuilderOutcome.CatalogSaved.class,
            saved -> assertThat(saved.catalog().has("en")).isTrue());
    }

    /**
     * The size cap: a definition or a catalog handed to the service is held to
     * {@code datum.builder.max-definition-size} in the place the routes' 413 has (after the 404, before the precondition),
     * so an import cannot store a form its authors could then never save again through the routes.
     */
    @Test
    void aDefinitionOrCatalogPastTheCapIsTooLargeInTheRoutesPlaceAndStoresNothing() {
        BuilderService capped = BuilderService.builder().repository(repository).definitions(definitions).translations(catalogs).types(BuilderApiTest.TYPES).maxDefinitionBytes(4096).clock(CLOCK).build();
        assertThat(capped.maxDefinitionBytes()).isEqualTo(4096);
        ObjectNode big = edited();
        big.put("description", "x".repeat(5000));
        ObjectNode bigCatalog = JsonNodeFactory.instance.objectNode();
        bigCatalog.putObject("en").putObject("form").put("title", "x".repeat(5000));

        assertThat(capped.save("missing", big, null, AUTHOR)).isEqualTo(new BuilderOutcome.NotFound("missing"));
        assertThat(capped.save(KEY, big, "0".repeat(64), AUTHOR)).as("before the precondition, as the 413 is")
            .isEqualTo(new BuilderOutcome.TooLarge(4096));
        assertThat(capped.save(KEY, big, baseHash, AUTHOR)).isEqualTo(new BuilderOutcome.TooLarge(4096));
        ObjectNode bigCreate = big.deepCopy();
        bigCreate.put("id", "other-form");
        assertThat(capped.create(bigCreate, AUTHOR)).isEqualTo(new BuilderOutcome.TooLarge(4096));
        assertThat(capped.saveTranslations("missing", bigCatalog, null, AUTHOR)).isEqualTo(new BuilderOutcome.NotFound("missing"));
        assertThat(capped.saveTranslations(KEY, bigCatalog, "nope", AUTHOR)).isEqualTo(new BuilderOutcome.TooLarge(4096));

        ObjectNode loop = edited();
        loop.set("loop", loop);
        assertThat(capped.save(KEY, loop, null, AUTHOR)).as("a tree holding itself is measured, not walked forever")
            .isEqualTo(new BuilderOutcome.TooLarge(4096));

        assertThat(kernel.checks()).isEmpty();
        assertThat(repository.saves()).isZero();
        assertThat(capped.save(KEY, edited(), baseHash, AUTHOR)).isInstanceOf(BuilderOutcome.Saved.class);
    }

    @Test
    void theCapDefaultsToTheSettingsDefaultAndIsAtLeastOneByte() {
        assertThat(service.maxDefinitionBytes()).isEqualTo(com.argusvane.datum.ui.UiSettings.DEFAULT_MAX_DEFINITION_BYTES);
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> BuilderService.builder().repository(repository).definitions(definitions).translations(catalogs).types(List.of()).maxDefinitionBytes(0).clock(CLOCK).build())
            .isInstanceOf(IllegalArgumentException.class);
        BuilderApi api = new BuilderApi(repository, definitions, catalogs, BuilderApiTest.TYPES, 8192, "", CLOCK);
        assertThat(api.service().maxDefinitionBytes()).as("the routes' own service has the routes' cap").isEqualTo(8192);
    }

    /** A catalog write answers a form no one has before anything else, its etag included, as the route's 404 comes first. */
    @Test
    void aCatalogWriteForNoFormIsNotFoundBeforeItsEtagIsRead() {
        java.util.concurrent.atomic.AtomicInteger reads = new java.util.concurrent.atomic.AtomicInteger();
        com.argusvane.datum.forms.translation.TranslationCatalogStore counting = new com.argusvane.datum.forms.translation.TranslationCatalogStore() {
            @Override
            public com.argusvane.datum.forms.translation.StoredCatalog read(String key) {
                reads.incrementAndGet();
                return catalogs.read(key);
            }

            @Override
            public String write(String key, ObjectNode catalog, String expectedEtag) {
                return catalogs.write(key, catalog, expectedEtag);
            }
        };
        BuilderService over = BuilderService.builder().repository(repository).definitions(definitions).translations(counting).types(BuilderApiTest.TYPES).clock(CLOCK).build();
        ObjectNode catalog = JsonNodeFactory.instance.objectNode();
        catalog.putObject("en").putObject("form").put("title", "Hello");

        assertThat(over.saveTranslations("no-such-form", catalog, "abc", AUTHOR)).isEqualTo(new BuilderOutcome.NotFound("no-such-form"));
        assertThat(over.saveTranslations("not a key!", catalog, "abc", AUTHOR)).isEqualTo(new BuilderOutcome.NotFound("not a key!"));
        assertThat(over.saveTranslations(null, catalog, "abc", AUTHOR)).isEqualTo(new BuilderOutcome.NotFound(null));
        assertThat(over.save(null, edited(), null, AUTHOR)).isEqualTo(new BuilderOutcome.NotFound(null));
        assertThat(reads).as("no store read for a form that is not there").hasValue(0);
    }

    @Test
    void theRoutesOverASharedServiceAnswerItsOutcomesOnTheWire() {
        BuilderApi api = new BuilderApi(service, repository, catalogs, 1024 * 1024, "/ctx/api");
        assertThat(api.service()).isSameAs(service);

        FormsReply reply = api.update(api.admitUpdate(KEY), BuilderApiTest.bytes(edited()), "\"" + baseHash + "\"", null, AUTHOR);
        assertThat(reply.status()).isEqualTo(200);
        JsonNode body = BuilderApiTest.json(reply);
        assertThat(reply.headers()).containsEntry("ETag", "\"" + body.path("sha256").stringValue() + "\"");
        assertThat(body.path("savedAt").stringValue()).isEqualTo("2026-10-17T10:15:30Z");

        // The same stale save through the service and through the route: Outdated, and the route's 409 names the same hash.
        BuilderOutcome stale = service.save(KEY, edited(), baseHash, AUTHOR);
        assertThat(stale).isInstanceOf(BuilderOutcome.Outdated.class);
        DatumException refused = org.junit.jupiter.api.Assertions.assertThrows(DatumException.class,
            () -> api.update(api.admitUpdate(KEY), BuilderApiTest.bytes(edited()), "\"" + baseHash + "\"", null, AUTHOR));
        assertThat(new ErrorMapper(false, List.of()).map(refused).status()).isEqualTo(409);
        assertThat(((BuilderOutdatedException) refused).currentSha256()).isEqualTo(((BuilderOutcome.Outdated) stale).currentSha256());
    }

    // ---- the builder

    @Test
    void theBuilderMakesTheSameServiceAsTheDeprecatedConstructorWithTheDefaultCap() {
        BuilderService built = BuilderService.builder().repository(repository).definitions(definitions).translations(catalogs)
            .types(BuilderApiTest.TYPES).clock(CLOCK).build();

        assertThat(built.maxDefinitionBytes()).isEqualTo(UiSettings.DEFAULT_MAX_DEFINITION_BYTES);
        assertThat(built.save(KEY, edited(), baseHash, AUTHOR)).isInstanceOf(BuilderOutcome.Saved.class);
    }

    @Test
    void theBuilderNamesTheMissingPartAndRefusesACapBelowOneByteByItsProperty() {
        assertThatThrownBy(() -> BuilderService.builder().build()).isInstanceOf(NullPointerException.class).hasMessage("repository");
        assertThatThrownBy(() -> BuilderService.builder().repository(repository).build()).hasMessage("definitions");
        assertThatThrownBy(() -> BuilderService.builder().repository(repository).definitions(definitions).build()).hasMessage("translations");
        assertThatThrownBy(() -> BuilderService.builder().repository(repository).definitions(definitions).translations(catalogs)
            .maxDefinitionBytes(0).build()).isInstanceOfSatisfying(com.argusvane.datum.core.DatumConfigurationException.class,
                refusal -> assertThat(refusal.property()).isEqualTo("datum.builder.max-definition-size"));
    }
}
