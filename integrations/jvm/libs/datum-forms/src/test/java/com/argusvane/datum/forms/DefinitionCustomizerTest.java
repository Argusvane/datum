package com.argusvane.datum.forms;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.core.canonical.CanonicalJson;
import com.argusvane.datum.core.hooks.HookProblem;
import com.argusvane.datum.core.hooks.HookRefusedException;
import com.argusvane.datum.forms.snapshot.InMemoryDefinitionSnapshotStore;
import com.argusvane.datum.forms.web.AuthorCopy;
import com.argusvane.datum.forms.web.FormsApi;
import com.argusvane.datum.forms.web.FormsReply;
import com.argusvane.datum.web.EntityTags;
import com.argusvane.datum.web.error.ErrorItem;
import com.argusvane.datum.web.error.ErrorMapper;
import com.argusvane.datum.web.error.ErrorResponse;
import com.argusvane.datum.web.json.DatumJsonMapper;
import java.security.Principal;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.TreeMap;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.node.ObjectNode;

/**
 * The forms side of the hook model: {@link DefinitionCustomizer}s adjust the public copy on its way to a filler,
 * in order, refuse with a typed refusal the wire maps by its kind, fail the request when they throw, and never touch the
 * author's copy or the form's identity. The public-copy cache follows their declared keys.
 */
class DefinitionCustomizerTest {

    private static final String KEY = "datum-security-suite";
    private static final Principal ADA = () -> "ada";

    private static final class MapRepository implements FormDefinitionRepository {
        final Map<String, ObjectNode> forms = new TreeMap<>();

        @Override
        public Optional<ObjectNode> find(String key) {
            return Optional.ofNullable(forms.get(key)).map(ObjectNode::deepCopy);
        }

        @Override
        public SavedForm save(ObjectNode definition) {
            String key = definition.path("id").asString();
            forms.put(key, definition.deepCopy());
            return new SavedForm(key, CanonicalJson.digest(definition));
        }

        @Override
        public SavedForm save(ObjectNode definition, String expectedSha256) {
            ObjectNode existing = forms.get(definition.path("id").asString());
            String current = existing == null ? null : CanonicalJson.digest(existing);
            if (current == null ? expectedSha256 != null : !current.equals(expectedSha256)) {
                throw new FormOutdatedException(current == null ? "" : current);
            }
            return save(definition);
        }
    }

    private final FakeGuestRuntime runtime = new FakeGuestRuntime();
    private final MapRepository repository = new MapRepository();
    private final ErrorMapper errors = new ErrorMapper(false, List.of());

    private DefinitionService service(List<DefinitionCustomizer> customizers) {
        repository.save(Fixtures.endpointFixture());
        return DefinitionService.builder().repository(repository).snapshots(new InMemoryDefinitionSnapshotStore(50, message -> { })).sandbox(runtime::service).events(event -> { }).publicCacheSize(8)
            .clock(Clock.systemUTC()).tooCostlyMemory(Duration.ofMinutes(5)).customizers(customizers).build();
    }

    private static FormsApi api(DefinitionService service) {
        return api(service, AuthorCopy.SERVED);
    }

    private static FormsApi api(DefinitionService service, AuthorCopy authorCopy) {
        return new FormsApi(service, null, null, null, DatumJsonMapper.create(1 << 20), "no-store", "public, max-age=60", authorCopy);
    }

    private static ObjectNode body(FormsReply reply) {
        return Fixtures.parse(new String(reply.body(), java.nio.charset.StandardCharsets.UTF_8));
    }

    @Test
    void theCustomizersRunInOrderOverACopyAndTheKernelStripsWhatTheyLeft() {
        List<DefinitionRequest> seen = new ArrayList<>();
        DefinitionCustomizer first = draft -> {
            seen.add(draft.request());
            draft.definition().put("stamp", "first");
            // A server-secret rule a customizer adds is the kernel's to take out, like any other.
            draft.definition().putObject("rules").putObject("added").put("run", "server-secret");
        };
        DefinitionCustomizer second = draft -> draft.definition().put("stamp", draft.definition().path("stamp").asString() + ",second");
        DefinitionService service = service(List.of(first, second));

        FormsReply reply = api(service).definition(KEY, null, null, null, ADA, Locale.CANADA_FRENCH);

        ObjectNode served = body(reply);
        assertThat(served.path("stamp").asString()).isEqualTo("first,second");
        assertThat(CanonicalJson.serialize(served)).doesNotContain("server-secret");
        assertThat(reply.headers().get("ETag")).as("the tag names what was served").isEqualTo(EntityTags.of(CanonicalJson.digest(served)));
        assertThat(repository.find(KEY).orElseThrow().has("stamp")).as("the stored definition is not touched").isFalse();
        assertThat(seen).singleElement().satisfies(request -> {
            assertThat(request.formKey()).isEqualTo(KEY);
            assertThat(request.principal()).isSameAs(ADA);
            assertThat(request.locale()).isEqualTo(Locale.CANADA_FRENCH);
            assertThat(request.current()).isTrue();
            assertThat(request.sha256()).isEqualTo(CanonicalJson.digest(Fixtures.endpointFixture()));
        });
    }

    @Test
    void aRefusalAnswersItsKindWithTheErrorsBodyAndStopsTheLaterCustomizers() {
        List<String> ran = new ArrayList<>();
        DefinitionService forbidding = service(List.of(draft -> {
            ran.add("first");
            throw HookRefusedException.forbidden("tenant.closed", "This form is closed for your organization.");
        }, draft -> ran.add("second")));

        assertThatThrownBy(() -> api(forbidding).definition(KEY, null, null, null, ADA, null)).isInstanceOfSatisfying(HookRefusedException.class, e -> {
            ErrorResponse answer = errors.map(e);
            assertThat(answer.status()).isEqualTo(403);
            assertThat(answer.body().get("errors")).isEqualTo(List.of(new ErrorItem(null, "tenant.closed", "This form is closed for your organization.")));
        });
        assertThat(ran).containsExactly("first");

        DefinitionService invalid = service(List.of(draft -> {
            throw HookRefusedException.invalid(List.of(HookProblem.at("name", "tenant.field", "Not for this tenant."), HookProblem.of("tenant.other", null)));
        }));
        assertThatThrownBy(() -> api(invalid).definition(KEY, null, null, null, null, null)).isInstanceOfSatisfying(HookRefusedException.class, e -> {
            ErrorResponse answer = errors.map(e);
            assertThat(answer.status()).isEqualTo(422);
            assertThat(answer.body().get("errors")).isEqualTo(List.of(new ErrorItem("name", "tenant.field", "Not for this tenant."),
                new ErrorItem(null, "tenant.other", null)));
        });
        DefinitionService conflict = service(List.of(draft -> {
            throw HookRefusedException.conflict("tenant.moved", null);
        }));
        assertThatThrownBy(() -> api(conflict).definition(KEY, null, null, null, null, null))
            .isInstanceOfSatisfying(HookRefusedException.class, e -> assertThat(errors.map(e).status()).isEqualTo(409));
    }

    @Test
    void aCustomizerThatThrowsFailsTheRequestAndServesNothing() {
        DefinitionService broken = service(List.of(draft -> {
            throw new IllegalStateException("tenant directory down");
        }));

        assertThatThrownBy(() -> api(broken).definition(KEY, null, null, null, ADA, null))
            .isInstanceOfSatisfying(IllegalStateException.class, e -> assertThat(errors.map(e).status()).isEqualTo(500));
        assertThat(runtime.count("public")).as("no copy was made").isZero();
    }

    @Test
    void theIdAndTheVersionAreNeverACustomizersToChange() {
        for (String member : List.of("id", "version")) {
            DefinitionService changing = service(List.of(draft -> draft.definition().put(member, "other")));
            assertThatThrownBy(() -> api(changing).definition(KEY, null, null, null, null, null))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining(member);
        }
    }

    @Test
    void theAuthorsCopyIsNeverCustomized() {
        List<String> ran = new ArrayList<>();
        DefinitionService service = service(List.of(draft -> {
            ran.add("customized");
            draft.definition().put("stamp", "x");
        }));

        FormsReply reply = api(service).definition(KEY, "false", null, null, ADA, null);

        assertThat(body(reply).has("stamp")).isFalse();
        assertThat(reply.headers().get("ETag")).isEqualTo(EntityTags.of(CanonicalJson.digest(Fixtures.endpointFixture())));
        assertThat(ran).isEmpty();
    }

    /**
     * With the builder off the author's copy is not served: 404 with no body, for a form that exists and one that does not,
     * before the repository or the kernel is asked; the public copy is served as before.
     */
    @Test
    void theAuthorsCopyIsWithheldUnlessTheBuilderIsOn() {
        DefinitionService service = service(List.of());
        FormsApi withheld = api(service, AuthorCopy.WITHHELD);
        long reads = runtime.count("public");
        for (String key : List.of(KEY, "no-such-form", "Not A Key!", KEY + "@1")) {
            FormsReply reply = withheld.definition(key, "false", null, null, ADA, null);
            assertThat(reply.status()).as(key).isEqualTo(404);
            assertThat(reply.body()).as(key).isNull();
            assertThat(reply.headers()).as(key).doesNotContainKey("ETag").containsEntry("Cache-Control", "no-store");
        }
        assertThat(withheld.definition(KEY, "false", CanonicalJson.digest(Fixtures.endpointFixture()), null, ADA, null).status())
            .as("by hash too").isEqualTo(404);
        assertThat(runtime.count("public")).isEqualTo(reads);
        // A bad value is still the caller's 400, whatever the builder.
        assertThatThrownBy(() -> withheld.definition(KEY, "maybe", null, null, ADA, null))
            .isInstanceOf(com.argusvane.datum.web.error.BadRequestException.class);
        FormsReply publicCopy = withheld.definition(KEY, null, null, null, ADA, null);
        assertThat(publicCopy.status()).isEqualTo(200);
        assertThat(new String(publicCopy.body(), java.nio.charset.StandardCharsets.UTF_8)).doesNotContain("server-secret");
        // The constructors without the switch withhold it: a facade nobody told about the builder fails closed.
        FormsApi plain = new FormsApi(service, null, null, null, DatumJsonMapper.create(1 << 20), "no-store", "no-store");
        assertThat(plain.definition(KEY, "false", null, null, ADA, null).status()).isEqualTo(404);
        assertThat(api(service, AuthorCopy.SERVED).definition(KEY, "false", null, null, ADA, null).status()).isEqualTo(200);
    }

    @Test
    void aDeclaredKeyCachesOneCopyPerVariantAndNoKeyMakesOneEveryTime() {
        DefinitionCustomizer byTenant = new DefinitionCustomizer() {
            @Override
            public void customize(DefinitionDraft draft) {
                draft.definition().put("tenant", draft.request().principal().getName());
            }

            @Override
            public Optional<String> cacheKey(DefinitionRequest request) {
                return Optional.of("tenant:" + request.principal().getName());
            }
        };
        DefinitionService cached = service(List.of(byTenant));
        cached.currentPublic(KEY, ADA, null);
        cached.currentPublic(KEY, ADA, null);
        assertThat(runtime.count("public")).as("one run for one variant").isEqualTo(1);
        assertThat(cached.currentPublic(KEY, () -> "grace", null).definition().path("tenant").asString()).isEqualTo("grace");
        assertThat(runtime.count("public")).as("one more for another variant").isEqualTo(2);

        FakeGuestRuntime counted = runtime;
        long before = counted.count("public");
        DefinitionService uncached = service(List.of(draft -> draft.definition().put("tenant", "any")));
        uncached.currentPublic(KEY, ADA, null);
        uncached.currentPublic(KEY, ADA, null);
        assertThat(counted.count("public") - before).as("a customizer with no key is never cached").isEqualTo(2);
    }

    @Test
    void aKeyThatDoesNotNameTheAdjustmentNeverServesAnotherRequestsCopy() {
        DefinitionCustomizer lying = new DefinitionCustomizer() {
            @Override
            public void customize(DefinitionDraft draft) {
                draft.definition().put("tenant", draft.request().principal().getName());
            }

            @Override
            public Optional<String> cacheKey(DefinitionRequest request) {
                return Optional.of("same-for-everyone");
            }
        };
        DefinitionService service = service(List.of(lying));

        assertThat(service.currentPublic(KEY, ADA, null).definition().path("tenant").asString()).isEqualTo("ada");
        assertThat(service.currentPublic(KEY, () -> "grace", null).definition().path("tenant").asString()).isEqualTo("grace");
        assertThat(service.currentPublic(KEY, ADA, null).definition().path("tenant").asString()).isEqualTo("ada");
    }

    @Test
    void withCustomizersAVersionByHashNeverGetsTheShareableHeader() {
        String sha = CanonicalJson.digest(Fixtures.endpointFixture());
        DefinitionService plain = service(List.of());
        assertThat(api(plain).definition(KEY, null, sha, null).headers().get("Cache-Control")).isEqualTo("public, max-age=60");

        DefinitionService customized = service(List.of(draft -> draft.definition().put("tenant", "x")));
        FormsReply reply = api(customized).definition(KEY, null, sha, null, ADA, null);
        assertThat(reply.headers().get("Cache-Control")).isEqualTo("no-store");
        assertThat(body(reply).path("tenant").asString()).isEqualTo("x");
    }
}
