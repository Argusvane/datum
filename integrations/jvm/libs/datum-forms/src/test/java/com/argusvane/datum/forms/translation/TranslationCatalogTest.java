package com.argusvane.datum.forms.translation;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.forms.Fixtures;
import com.argusvane.datum.forms.FormOutdatedException;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

/** The catalog rules: the nested shape, and that locales are dropped only when a save removes them. */
class TranslationCatalogTest {

    private static JsonNode definition(String... locales) {
        StringBuilder supported = new StringBuilder();
        for (String locale : locales) {
            supported.append(supported.length() == 0 ? "" : ",").append(locale.startsWith("{") || locale.startsWith("\"") ? locale : "{\"code\":\"" + locale + "\"}");
        }
        return Fixtures.node("{\"id\":\"f\",\"localization\":{\"supportedLocales\":[" + supported + "]}}");
    }

    private static ObjectNode catalog() {
        return TranslationCatalog.normalize(Fixtures.node("""
            {"en": {"components": {"fullName": {"label": "Name"}}},
             "fr": {"components": {"fullName": {"label": "Nom"}, "city": {"label": "Ville"}}},
             "de": {"components": {"fullName": {"label": "Name"}}},
             "fr-CA": {"form": {"title": "Accueil"}, "chrome": {"footer": {"text": "Pied"}}},
             "es": {"chrome": {"footer": {"text": "Pie"}}}}
            """));
    }

    @Test
    void localesAreDroppedOnlyWhenTheSaveRemovesThem() {
        // Before: en, fr, de. After: en, fr. Only "de" goes; "es" and "fr-CA" were never declared, so they stay.
        ObjectNode after = TranslationCatalog.afterSave(catalog(), definition("en", "fr", "de"), definition("en", "fr"));

        assertThat(after.propertyNames()).containsExactlyInAnyOrder("en", "fr", "fr-CA", "es");
        assertThat(after.path("fr").path("components").path("city").path("label").asString()).isEqualTo("Ville");
    }

    @Test
    void nothingIsDroppedWhenNoLocaleIsRemovedOrTheFormIsNew() {
        assertThat(TranslationCatalog.afterSave(catalog(), definition("en"), definition("en", "fr", "de"))).isEqualTo(catalog());
        assertThat(TranslationCatalog.afterSave(catalog(), null, definition("en"))).isEqualTo(catalog());
        assertThat(TranslationCatalog.afterSave(catalog(), definition("en", "fr"), definition("en", "fr"))).isEqualTo(catalog());
    }

    @Test
    void localesAreReadFromCodeObjectsAndAnythingElseIsSkipped() {
        JsonNode definition = definition("en", "{\"code\":\"fr-CA\",\"label\":\"Francais\"}", "{\"code\":\"not a locale!\"}", "\"de\"");
        assertThat(TranslationCatalog.supportedLocales(definition)).containsExactly(Map.entry("en", "en"), Map.entry("fr-CA", "Francais"));
        assertThat(TranslationCatalog.removedLocales(definition("en", "fr"), definition("fr"))).containsExactly("en");
    }

    @Test
    void normalizeKeepsOnlyTheShapeSortedAndWithoutBlanksOrEmptyBranches() {
        ObjectNode clean = TranslationCatalog.normalize(Fixtures.node("""
            {"fr": {"pdf": {"copy": {"name": "Copie"}}, "components": {"b": {"label": "  ", "options": {"x": {"label": "X"}}},
                    "a": {"label": "A", "__proto__": {"label": "no"}}, "c": "oops", "d": {"label": 3}},
                    "bogus": {"a": {"label": "no"}}, "form": {"title": "Titre", "messages": {"required.x": "Requis"}}},
             "bad locale": {"form": {"title": "no"}}, "de": {"form": {"title": " "}}, "en": "oops"}
            """));

        assertThat(clean.toString()).isEqualTo("{\"fr\":{\"components\":{\"a\":{\"label\":\"A\"},"
            + "\"b\":{\"options\":{\"x\":{\"label\":\"X\"}}}},\"form\":{\"messages\":{\"required.x\":\"Requis\"},\"title\":\"Titre\"},"
            + "\"pdf\":{\"copy\":{\"name\":\"Copie\"}}}}");
    }

    @Test
    void theEnginesOwnWordsAreAKindAndAreKept() {
        JsonNode words = Fixtures.node("{\"fr\":{\"texts\":{\"form\":{\"back\":\"Retour\"},\"messages\":{\"required\":\"Obligatoire\"}}}}");

        assertThat(TranslationCatalog.problems(words)).isEmpty();
        assertThat(TranslationCatalog.normalize(words)).isEqualTo(words);
    }

    @Test
    void problemsNameWhatIsWrongWithTheJsonPathOfTheOffence() {
        assertThat(TranslationCatalog.problems(Fixtures.node("[1]"))).extracting(TranslationCatalog.Problem::path).containsExactly("$");
        assertThat(TranslationCatalog.problems(Fixtures.node("{\"fr-CA\":{\"components\":{\"fullName\":{\"label\":4}}}}")))
            .singleElement().satisfies(p -> {
                assertThat(p.path()).isEqualTo("$['fr-CA'].components.fullName.label");
                assertThat(p.message()).contains("must be text");
            });
        assertThat(TranslationCatalog.problems(Fixtures.node("{\"x y\":{}}"))).singleElement().satisfies(p -> {
            assertThat(p.path()).isEqualTo("$['x y']");
            assertThat(p.message()).contains("not a locale code");
        });
        assertThat(TranslationCatalog.problems(Fixtures.node("{\"fr\":{\"fields\":{}}}"))).singleElement()
            .satisfies(p -> assertThat(p.message()).contains("not a kind"));
        assertThat(TranslationCatalog.problems(Fixtures.node("{\"fr\":{\"components\":{\"a\":\"text\"}}}"))).singleElement()
            .satisfies(p -> assertThat(p.path()).isEqualTo("$.fr.components.a"));
        assertThat(TranslationCatalog.problems(Fixtures.node("{\"fr\":{\"components\":{\"a\":{\"constructor\":\"x\"}}}}"))).singleElement()
            .satisfies(p -> assertThat(p.message()).contains("not a usable key"));
        assertThat(TranslationCatalog.problems(Fixtures.node("{\"fr\":{\"form\":{\"title\":\"ok\",\"blank\":\" \"}}}"))).isEmpty();
    }

    @Test
    void problemsHoldTheCaps() {
        String longKey = "k".repeat(TranslationCatalog.MAX_KEY_LENGTH + 1);
        assertThat(TranslationCatalog.problems(Fixtures.node("{\"fr\":{\"components\":{\"" + longKey + "\":{\"label\":\"x\"}}}}")))
            .singleElement().satisfies(p -> assertThat(p.message()).contains("at most 190 characters"));

        String bigText = "x".repeat(TranslationCatalog.MAX_TEXT_BYTES + 1);
        assertThat(TranslationCatalog.problems(Fixtures.node("{\"fr\":{\"form\":{\"title\":\"" + bigText + "\"}}}")))
            .singleElement().satisfies(p -> assertThat(p.message()).contains("longer than 16384 bytes"));

        StringBuilder deep = new StringBuilder("\"leaf\"");
        for (int i = 0; i < TranslationCatalog.MAX_NESTING + 2; i++) {
            deep = new StringBuilder("{\"n\":" + deep + "}");
        }
        assertThat(TranslationCatalog.problems(Fixtures.node("{\"fr\":{\"form\":" + deep + "}}")))
            .singleElement().satisfies(p -> assertThat(p.message()).contains("nested more than 12 levels"));

        StringBuilder many = new StringBuilder("{\"fr\":{\"form\":{");
        for (int i = 0; i <= TranslationCatalog.MAX_ENTRIES; i++) {
            many.append(i == 0 ? "" : ",").append("\"k").append(i).append("\":\"v\"");
        }
        many.append("}}}");
        assertThat(TranslationCatalog.problems(Fixtures.node(many.toString()))).singleElement()
            .satisfies(p -> assertThat(p.message()).contains("at most 10000 texts"));

        StringBuilder locales = new StringBuilder("{");
        for (int i = 0; i <= TranslationCatalog.MAX_LOCALES; i++) {
            locales.append(i == 0 ? "" : ",").append("\"xx-").append(i).append("\":{}");
        }
        locales.append("}");
        assertThat(TranslationCatalog.problems(Fixtures.node(locales.toString())))
            .extracting(TranslationCatalog.Problem::message).anyMatch(m -> m.contains("at most 64 locales"));
    }

    @Test
    void theOldFlatCatalogIsRefusedWithThePathOfTheFirstOffence() {
        // key -> locale -> text: "fullName.label" is no locale code, so the first offence is the top-level key itself.
        assertThat(TranslationCatalog.problems(Fixtures.node("{\"fullName.label\":{\"fr\":\"Nom\",\"en\":\"Name\"}}")))
            .first().satisfies(p -> {
                assertThat(p.path()).isEqualTo("$['fullName.label']");
                assertThat(p.message()).contains("not a locale code");
            });
        // A flat key that happens to look like a locale ("title") passes that test; its locale-keyed children are not kinds.
        assertThat(TranslationCatalog.problems(Fixtures.node("{\"title\":{\"fr\":\"Titre\"}}")))
            .first().satisfies(p -> {
                assertThat(p.path()).isEqualTo("$.title.fr");
                assertThat(p.message()).contains("not a kind");
            });
        // The first offence comes first even after a valid locale.
        assertThat(TranslationCatalog.problems(Fixtures.node("{\"en\":{\"form\":{\"title\":\"ok\"}},\"label one\":{\"fr\":\"x\"}}")))
            .first().extracting(TranslationCatalog.Problem::path).isEqualTo("$['label one']");
    }

    @Test
    void aTopLevelKeyThatIsNotALocaleIsRefusedWithItsPath() {
        assertThat(TranslationCatalog.problems(Fixtures.node("{\"en_US\":{\"form\":{\"title\":\"x\"}}}")))
            .singleElement().satisfies(p -> {
                assertThat(p.path()).isEqualTo("$.en_US");
                assertThat(p.message()).contains("not a locale code");
            });
        assertThat(TranslationCatalog.problems(Fixtures.node("{\"e\":{}}"))).singleElement()
            .satisfies(p -> assertThat(p.path()).isEqualTo("$.e"));
    }

    @Test
    void aBlankLeafIsDroppedSilentlyWithItsEmptyBranchesAndIsNeverAProblem() {
        JsonNode input = Fixtures.node("""
            {"fr": {"components": {"a": {"label": " ", "options": {"x": {"label": ""}}}, "b": {"label": "B"}},
                    "form": {"title": "   "}},
             "de": {"chrome": {"footer": {"text": "  "}}}}
            """);

        assertThat(TranslationCatalog.problems(input)).isEmpty();
        assertThat(TranslationCatalog.normalize(input).toString()).isEqualTo("{\"fr\":{\"components\":{\"b\":{\"label\":\"B\"}}}}");
    }

    @Test
    void leavesAreCounted() {
        assertThat(TranslationCatalog.leafCount(catalog())).isEqualTo(7);
        assertThat(TranslationCatalog.leafCount(TranslationCatalog.empty())).isZero();
    }

    @Test
    void mergeLetsTheImportWinAndKeepsStoredTextItDoesNotName() {
        ObjectNode merged = TranslationCatalog.merge(catalog(),
            TranslationCatalog.normalize(Fixtures.node("{\"fr\":{\"components\":{\"fullName\":{\"label\":\"Prenom\"}}},\"it\":{\"form\":{\"title\":\"Nuovo\"}}}")));

        assertThat(merged.path("fr").path("components").path("fullName").path("label").asString()).isEqualTo("Prenom");
        assertThat(merged.path("fr").path("components").path("city").path("label").asString()).as("stored text stays").isEqualTo("Ville");
        assertThat(merged.path("en").path("components").path("fullName").path("label").asString()).isEqualTo("Name");
        assertThat(merged.has("it")).isTrue();
    }

    @Test
    void theInMemoryStoreWritesWithIfMatchAndAnEtagOfTheCanonicalCatalog() {
        InMemoryTranslationCatalogStore store = new InMemoryTranslationCatalogStore();
        StoredCatalog empty = store.read("f");
        assertThat(empty.catalog()).isEmpty();
        assertThat(empty.etag()).hasSize(64);

        String first = store.write("f", catalog(), empty.etag());
        assertThat(store.read("f").etag()).isEqualTo(first).isEqualTo(InMemoryTranslationCatalogStore.etag(catalog()));
        assertThat(store.read("f").catalog()).isEqualTo(catalog());

        assertThatThrownBy(() -> store.write("f", TranslationCatalog.empty(), empty.etag())).isInstanceOfSatisfying(FormOutdatedException.class, e -> {
            assertThat(e.currentSha256()).isEqualTo(first);
            assertThat(e.httpStatus()).isEqualTo(409);
            assertThat(e.code()).isEqualTo("form.outdated");
        });
        assertThat(store.read("f").etag()).as("a refused write changes nothing").isEqualTo(first);

        String second = store.write("f", TranslationCatalog.normalize(Fixtures.node("{\"fr\":{\"form\":{\"title\":\"x\"}}}")), first);
        assertThat(second).isNotEqualTo(first);
        assertThat(store.write("f", TranslationCatalog.empty(), null)).as("no If-Match, no precondition").isNotEqualTo(second);
    }

    @Test
    void aStoredCatalogIsACopy() {
        InMemoryTranslationCatalogStore store = new InMemoryTranslationCatalogStore();
        store.write("f", catalog(), null);
        store.read("f").catalog().removeAll();
        assertThat(store.read("f").catalog()).isEqualTo(catalog());
    }

    @Test
    void aSaveDropsOnlyRemovedLocalesThroughTheStoreToo() {
        InMemoryTranslationCatalogStore store = new InMemoryTranslationCatalogStore();
        store.write("f", catalog(), null);
        ObjectNode dropped = TranslationCatalog.afterSave(store.read("f").catalog(), definition("en", "fr", "de"), definition("en", "fr"));
        store.write("f", dropped, store.read("f").etag());

        assertThat(Set.copyOf(List.copyOf(store.read("f").catalog().propertyNames()))).containsExactlyInAnyOrder("en", "fr", "fr-CA", "es");
    }
}
