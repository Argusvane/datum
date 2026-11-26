package com.argusvane.datum.ui.builder;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.core.canonical.CanonicalJson;
import com.argusvane.datum.core.hooks.HookFindings;
import com.argusvane.datum.core.hooks.HookProblem;
import com.argusvane.datum.core.hooks.HookRefusedException;
import com.argusvane.datum.sandbox.protocol.SandboxService;
import com.argusvane.datum.forms.DefinitionService;
import com.argusvane.datum.forms.snapshot.InMemoryDefinitionSnapshotStore;
import com.argusvane.datum.forms.translation.InMemoryTranslationCatalogStore;
import com.argusvane.datum.web.error.ErrorItem;
import com.argusvane.datum.web.error.ErrorMapper;
import com.argusvane.datum.web.error.ErrorResponse;
import java.nio.charset.StandardCharsets;
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
import tools.jackson.databind.node.ObjectNode;

/**
 * The builder side of the hook model: {@link BuilderSaveCustomizer}s adjust or refuse before the kernel's check
 * and what they leave is what is checked and stored; {@link BuilderSaveValidator}s judge the kernel's verdict before the
 * store. Order, the refusal on the wire by its kind, and a hook that throws failing the save.
 */
class BuilderSaveHooksTest {

    static final String KEY = BuilderFixtures.KEY;
    static final Clock CLOCK = Clock.fixed(Instant.parse("2026-10-17T10:15:30Z"), ZoneOffset.UTC);
    static final Principal AUTHOR = () -> "author";

    KernelStub kernel;
    MemoryRepository repository;
    InMemoryTranslationCatalogStore catalogs;
    List<Object> events;
    DefinitionService definitions;
    final ErrorMapper errors = new ErrorMapper(false, List.of());

    @BeforeEach
    void setUp() {
        kernel = new KernelStub();
        SandboxService sandbox = kernel.service();
        repository = new MemoryRepository();
        catalogs = new InMemoryTranslationCatalogStore();
        events = Collections.synchronizedList(new ArrayList<>());
        definitions = DefinitionService.builder().repository(repository).snapshots(new InMemoryDefinitionSnapshotStore(100, warning -> { })).sandbox(() -> sandbox).events(events::add).publicCacheSize(16).build();
        repository.seed(BuilderFixtures.base());
    }

    private BuilderService service(List<BuilderSaveCustomizer> customizers, List<BuilderSaveValidator> validators) {
        return BuilderService.builder().repository(repository).definitions(definitions).translations(catalogs).types(BuilderApiTest.TYPES).maxDefinitionBytes(1 << 20).clock(CLOCK).customizers(customizers).validators(validators).build();
    }

    private BuilderApi api(BuilderService service) {
        return new BuilderApi(service, repository, catalogs, 1 << 20, "/api");
    }

    private static byte[] bytes(ObjectNode definition) {
        return CanonicalJson.serialize(definition).getBytes(StandardCharsets.UTF_8);
    }

    private static ObjectNode stamped(ObjectNode definition, String name, String value) {
        ObjectNode metadata = definition.get("metadata") instanceof ObjectNode existing ? existing : definition.putObject("metadata");
        metadata.put(name, value);
        return definition;
    }

    @Test
    void theCustomizersRunInOrderBeforeTheKernelAndTheStoredDefinitionIsWhatTheyLeft() {
        List<String> seen = new ArrayList<>();
        BuilderSaveCustomizer tenant = draft -> {
            seen.add("tenant:" + draft.key() + ":" + draft.creating() + ":" + draft.principal().getName());
            stamped(draft.definition(), "tenant", "acme");
        };
        BuilderSaveCustomizer by = draft -> {
            seen.add("by:" + draft.definition().path("metadata").path("tenant").asString());
            stamped(draft.definition(), "by", draft.principal().getName());
        };
        ObjectNode sent = BuilderFixtures.base();

        BuilderOutcome outcome = service(List.of(tenant, by), List.of()).save(KEY, sent, null, AUTHOR);

        assertThat(outcome).isInstanceOf(BuilderOutcome.Saved.class);
        assertThat(seen).containsExactly("tenant:" + KEY + ":false:author", "by:acme");
        assertThat(kernel.checks()).singleElement().satisfies(check ->
            assertThat(check.definition().path("metadata").path("by").asString()).as("the kernel judged the customized one").isEqualTo("author"));
        ObjectNode stored = repository.find(KEY).orElseThrow();
        assertThat(stored.path("metadata").path("tenant").asString()).isEqualTo("acme");
        assertThat(((BuilderOutcome.Saved) outcome).sha256()).as("the next If-Match names what is stored").isEqualTo(CanonicalJson.digest(stored));
        assertThat(sent.has("metadata")).as("the caller's tree is not touched").isFalse();

        repository.clear();
        BuilderOutcome created = service(List.of(tenant), List.of()).create(BuilderFixtures.base(), AUTHOR);
        assertThat(created).isInstanceOf(BuilderOutcome.Saved.class);
        assertThat(seen).last().isEqualTo("tenant:" + KEY + ":true:author");
    }

    @Test
    void aCustomizersRefusalIsDeclinedStoresNothingAndTheRoutesAnswerItsKind() {
        List<String> ran = new ArrayList<>();
        BuilderSaveCustomizer naming = draft -> {
            ran.add("naming");
            throw HookRefusedException.invalid(List.of(HookProblem.at("id", "naming.prefix", "Form ids start with acme-.")));
        };
        BuilderService service = service(List.of(naming, draft -> ran.add("later")), List.of());

        assertThat(service.save(KEY, BuilderFixtures.base(), null, AUTHOR)).isInstanceOfSatisfying(BuilderOutcome.Declined.class,
            declined -> assertThat(declined.refusal().kind()).isEqualTo(HookRefusedException.Kind.INVALID));
        assertThat(ran).containsExactly("naming");

        assertThatThrownBy(() -> api(service).update(api(service).admitUpdate(KEY), bytes(BuilderFixtures.base()), null, null, AUTHOR))
            .isInstanceOfSatisfying(BuilderRefusedException.class, refused -> {
                ErrorResponse answer = errors.map(refused);
                assertThat(answer.status()).isEqualTo(422);
                assertThat(refused.code()).isEqualTo("definition.refused");
                assertThat(answer.body().get("errors")).isEqualTo(List.of(new ErrorItem(null, "naming.prefix", "Form ids start with acme-.")));
                assertThat(answer.body().get("kernel")).isEqualTo(List.of(Map.of("code", "naming.prefix", "where", "id")));
            });

        BuilderService forbidding = service(List.of(draft -> {
            throw HookRefusedException.forbidden("tenant.readOnly", "This tenant's forms are frozen.");
        }), List.of());
        assertThatThrownBy(() -> api(forbidding).update(api(forbidding).admitUpdate(KEY), bytes(BuilderFixtures.base()), null, null, AUTHOR))
            .isInstanceOfSatisfying(HookRefusedException.class, refused -> {
                ErrorResponse answer = errors.map(refused);
                assertThat(answer.status()).isEqualTo(403);
                assertThat(answer.body().get("errors")).isEqualTo(List.of(new ErrorItem(null, "tenant.readOnly", "This tenant's forms are frozen.")));
            });
        BuilderService conflicting = service(List.of(draft -> {
            throw HookRefusedException.conflict("tenant.locked", null);
        }), List.of());
        assertThatThrownBy(() -> api(conflicting).update(api(conflicting).admitUpdate(KEY), bytes(BuilderFixtures.base()), null, null, AUTHOR))
            .isInstanceOfSatisfying(HookRefusedException.class, refused -> assertThat(errors.map(refused).status()).isEqualTo(409));

        assertThat(kernel.checks()).as("a refusal before the kernel costs no check").isEmpty();
        assertThat(repository.saves()).isZero();
        assertThat(events).isEmpty();
    }

    @Test
    void aCustomizerThatThrowsOrChangesTheIdFailsTheSave() {
        BuilderService broken = service(List.of(draft -> {
            throw new IllegalStateException("tenant directory down");
        }), List.of());
        assertThatThrownBy(() -> api(broken).update(api(broken).admitUpdate(KEY), bytes(BuilderFixtures.base()), null, null, AUTHOR))
            .isInstanceOfSatisfying(IllegalStateException.class, e -> assertThat(errors.map(e).status()).isEqualTo(500));

        BuilderService renaming = service(List.of(draft -> draft.definition().put("id", "acme-" + draft.key())), List.of());
        assertThatThrownBy(() -> renaming.save(KEY, BuilderFixtures.base(), null, AUTHOR))
            .isInstanceOf(IllegalStateException.class).hasMessageContaining("changed the id");
        assertThat(kernel.checks()).isEmpty();
        assertThat(repository.saves()).isZero();
    }

    @Test
    void whatTheCustomizersLeaveIsHeldToTheHostsRulesAgain() {
        BuilderService nonFinite = service(List.of(draft -> draft.definition().put("n", java.math.BigInteger.TEN.pow(400))), List.of());
        assertThat(nonFinite.save(KEY, BuilderFixtures.base(), null, AUTHOR)).isInstanceOfSatisfying(BuilderOutcome.Refused.class,
            refused -> assertThat(refused.errors()).extracting(DefinitionShape.Finding::code).containsExactly("definition.number.nonFinite"));

        BuilderService rootless = service(List.of(draft -> draft.definition().remove("root")), List.of());
        assertThat(rootless.save(KEY, BuilderFixtures.base(), null, AUTHOR)).isInstanceOfSatisfying(BuilderOutcome.Refused.class,
            refused -> assertThat(refused.code()).isEqualTo("definition.refused"));

        BuilderService inflating = BuilderService.builder().repository(repository).definitions(definitions).translations(catalogs).types(BuilderApiTest.TYPES).maxDefinitionBytes(64 * 1024).clock(CLOCK)
            .customizers(List.of(draft -> draft.definition().put("padding", "x".repeat(70 * 1024)))).validators(List.of()).build();
        assertThat(inflating.save(KEY, BuilderFixtures.base(), null, AUTHOR)).isEqualTo(new BuilderOutcome.TooLarge(64 * 1024));
        assertThat(kernel.checks()).isEmpty();
        assertThat(repository.saves()).isZero();
    }

    @Test
    void everyValidatorRunsInOrderOverTheVerdictAndTheirErrorsRefuseTogether() {
        List<String> seen = new ArrayList<>();
        BuilderSaveValidator first = candidate -> {
            seen.add("first:" + candidate.key() + ":" + candidate.verdict().refused() + ":" + candidate.principal().getName());
            return HookFindings.errors(HookProblem.at("name", "policy.label", "Every field needs a label."));
        };
        BuilderSaveValidator second = candidate -> {
            seen.add("second");
            candidate.definition().put("tampered", true);
            return new HookFindings(List.of(HookProblem.of("policy.owner", "Name an owner.")), List.of(HookProblem.of("policy.note", "A note.")));
        };
        BuilderService service = service(List.of(), List.of(first, second));

        BuilderOutcome outcome = service.save(KEY, BuilderFixtures.base(), null, AUTHOR);

        assertThat(seen).containsExactly("first:" + KEY + ":false:author", "second");
        assertThat(outcome).isInstanceOfSatisfying(BuilderOutcome.Declined.class, declined -> {
            assertThat(declined.refusal().kind()).isEqualTo(HookRefusedException.Kind.INVALID);
            assertThat(declined.refusal().problems()).extracting(HookProblem::code).containsExactly("policy.label", "policy.owner");
        });
        assertThat(kernel.checks()).as("the validators came after the kernel").hasSize(1);
        assertThat(repository.saves()).isZero();
        assertThatThrownBy(() -> api(service).update(api(service).admitUpdate(KEY), bytes(BuilderFixtures.base()), null, null, AUTHOR))
            .isInstanceOfSatisfying(BuilderRefusedException.class, refused -> {
                ErrorResponse answer = errors.map(refused);
                assertThat(answer.status()).isEqualTo(422);
                assertThat(answer.body().get("errors")).isEqualTo(List.of(new ErrorItem(null, "policy.label", "Every field needs a label."),
                    new ErrorItem(null, "policy.owner", "Name an owner.")));
                assertThat(answer.body().get("kernel")).isEqualTo(List.of(Map.of("code", "policy.label", "where", "name"),
                    Map.of("code", "policy.owner", "where", "definition")));
            });
    }

    @Test
    void validatorWarningsRideInTheSavedAnswerAfterTheKernels() {
        BuilderService service = service(List.of(), List.of(candidate -> HookFindings.warnings(HookProblem.of("policy.note", "Remember the owner."),
            HookProblem.of("policy.code", null))));

        BuilderOutcome outcome = service.save(KEY, BuilderFixtures.base(), null, AUTHOR);

        assertThat(outcome).isInstanceOfSatisfying(BuilderOutcome.Saved.class,
            saved -> assertThat(saved.warnings()).endsWith("Remember the owner.", "policy.code"));
        assertThat(repository.saves()).isEqualTo(1);
    }

    @Test
    void aValidatorThatThrowsFailsTheSaveAndOneThatRefusesKeepsItsKind() {
        BuilderService broken = service(List.of(), List.of(candidate -> {
            throw new IllegalStateException("policy service down");
        }));
        assertThatThrownBy(() -> broken.save(KEY, BuilderFixtures.base(), null, AUTHOR)).isInstanceOf(IllegalStateException.class);

        BuilderService conflict = service(List.of(), List.of(candidate -> {
            throw HookRefusedException.conflict("policy.review", "This form is under review.");
        }, candidate -> {
            throw new AssertionError("a refusal stops the later validators");
        }));
        assertThat(conflict.save(KEY, BuilderFixtures.base(), null, AUTHOR)).isInstanceOfSatisfying(BuilderOutcome.Declined.class,
            declined -> assertThat(declined.refusal().kind()).isEqualTo(HookRefusedException.Kind.CONFLICT));

        BuilderService answersNull = service(List.of(), List.of(candidate -> null));
        assertThatThrownBy(() -> answersNull.save(KEY, BuilderFixtures.base(), null, AUTHOR)).isInstanceOf(IllegalStateException.class);
        assertThat(repository.saves()).isZero();
    }
}
