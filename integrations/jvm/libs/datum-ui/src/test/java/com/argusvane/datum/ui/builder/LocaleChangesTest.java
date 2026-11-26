package com.argusvane.datum.ui.builder;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Map;
import tools.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;

/** The locale-changes header, read by data binding, and applied to a catalog. */
class LocaleChangesTest {

    @Test
    void aBlankHeaderIsNoChange() {
        assertThat(LocaleChanges.read(null)).contains(LocaleChanges.none());
        assertThat(LocaleChanges.read("  ")).contains(LocaleChanges.none());
    }

    @Test
    void theChangesAreRead() {
        LocaleChanges changes = LocaleChanges.read("{\"removed\":[\"de\"],\"renamed\":[{\"from\":\"fr\",\"to\":\"fr-CA\"},{\"from\":\"en\",\"to\":\"en\"}]}").orElseThrow();
        assertThat(changes.removed()).containsExactly("de");
        assertThat(changes.renamed()).containsExactly(new LocaleChanges.Rename("fr", "fr-CA"));
    }

    @Test
    void aMissingOrNullListIsEmpty() {
        assertThat(LocaleChanges.read("{\"removed\":null}").orElseThrow().isEmpty()).isTrue();
        assertThat(LocaleChanges.read("{}").orElseThrow().isEmpty()).isTrue();
        assertThat(LocaleChanges.read("{\"removed\":[\"de\"],\"extra\":1}").orElseThrow().removed()).containsExactly("de");
    }

    @Test
    void whatIsNotValidIsRefused() {
        for (String header : List.of("{", "1", "true", "null", "[\"de\"]", "{\"removed\":\"de\"}", "{\"removed\":[1]}", "{\"removed\":[true]}", "{\"removed\":[1.5]}", "{\"renamed\":[{\"from\":true,\"to\":\"fr\"}]}", "{\"removed\":[null]}",
            "{\"removed\":[\"not a locale\"]}", "{\"renamed\":[{\"from\":\"fr\",\"to\":3}]}", "{\"renamed\":[{\"from\":\"fr\"}]}",
            "{\"renamed\":\"fr\"}", "{} {}", "{\"removed\":" + "[".repeat(16) + "]".repeat(16) + "}")) {
            assertThat(LocaleChanges.read(header)).as(header).isEmpty();
        }
    }

    @Test
    void removedGoFirstThenRenamesMoveWithTheMovedTextWinning() {
        // The catalog's top-level keys are the locales; a move onto a locale that exists merges, moved text winning.
        ObjectNode catalog = BuilderApiTest.cat("""
            {"en": {"form": {"title": "A"}},
             "fr": {"form": {"title": "A-fr", "description": "D-fr"}},
             "fr-CA": {"form": {"title": "old", "messages": {"required": "kept"}}},
             "de": {"form": {"title": "A-de"}}}
            """);
        LocaleChanges changes = new LocaleChanges(List.of("de"), List.of(new LocaleChanges.Rename("fr", "fr-CA")));
        assertThat(changes.applyTo(catalog)).isEqualTo(BuilderApiTest.cat("""
            {"en": {"form": {"title": "A"}},
             "fr-CA": {"form": {"title": "A-fr", "description": "D-fr", "messages": {"required": "kept"}}}}
            """));
    }

    @Test
    void aRenameChainReadsTheCatalogAsItWas() {
        ObjectNode catalog = BuilderApiTest.cat("{\"aa\": {\"form\": {\"title\": \"from a\"}}, \"bb\": {\"form\": {\"title\": \"from b\"}}}");
        LocaleChanges changes = new LocaleChanges(List.of(), List.of(new LocaleChanges.Rename("aa", "bb"), new LocaleChanges.Rename("bb", "cc")));
        assertThat(changes.applyTo(catalog)).isEqualTo(BuilderApiTest.cat("{\"bb\": {\"form\": {\"title\": \"from a\"}}, \"cc\": {\"form\": {\"title\": \"from b\"}}}"));
    }
}
