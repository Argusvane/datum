package com.argusvane.datum.ui.builder;

import com.argusvane.datum.forms.translation.TranslationCatalog;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import tools.jackson.core.JacksonException;
import tools.jackson.core.StreamReadConstraints;
import tools.jackson.core.json.JsonFactory;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.MapperFeature;
import tools.jackson.databind.cfg.CoercionAction;
import tools.jackson.databind.cfg.CoercionInputShape;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;
import tools.jackson.databind.type.LogicalType;

/**
 * The builder's LocaleChanges since the page's baseline: which locales were removed and which were renamed, sent
 * with a save in the {@code X-Datum-Locale-Changes} header as JSON {@code {removed: string[], renamed: [{from, to}]}}.
 * The save moves the host catalog's top-level locale keys with them, so a renamed language keeps its translations (the header of endpoint catalog
 * {@code saveForm}; BLD-06 sends hostile values of it).
 *
 * @param removed the locale codes the author removed
 * @param renamed the moves, {@code from} to {@code to}; a move onto itself is dropped
 */
public record LocaleChanges(List<String> removed, List<Rename> renamed) {

    /** The request header the builder sends them in. */
    public static final String HEADER = "X-Datum-Locale-Changes";

    /** The deepest nesting the header may carry; Datum's limit for this header (deeper is not valid). */
    static final int MAX_DEPTH = 16;

    /**
     * Data binding of the header: strict about trailing text and about a scalar of the wrong type (a number is not
     * a locale), and tolerant of members it does not know. The nesting limit is a stream constraint.
     */
    private static final JsonMapper JSON = JsonMapper.builder(JsonFactory.builder()
            .streamReadConstraints(StreamReadConstraints.builder().maxNestingDepth(MAX_DEPTH).build())
            .build())
        .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
        .disable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
        .disable(MapperFeature.ALLOW_COERCION_OF_SCALARS)
        // Jackson still reads a boolean or a number as the text of a String: a locale is a string, so refuse them.
        .withCoercionConfig(LogicalType.Textual, config -> config
            .setCoercion(CoercionInputShape.Boolean, CoercionAction.Fail)
            .setCoercion(CoercionInputShape.Integer, CoercionAction.Fail)
            .setCoercion(CoercionInputShape.Float, CoercionAction.Fail))
        .build();

    /** One rename. */
    public record Rename(String from, String to) {
    }

    /** The header as it is sent; either list may be absent or null. */
    private record Wire(List<String> removed, List<Rename> renamed) {
    }

    public LocaleChanges {
        removed = List.copyOf(removed);
        renamed = List.copyOf(renamed);
    }

    /** No change at all. */
    public static LocaleChanges none() {
        return new LocaleChanges(List.of(), List.of());
    }

    /** Whether the catalog has anything to move: the changes are applied only then. */
    public boolean isEmpty() {
        return removed.isEmpty() && renamed.isEmpty();
    }

    /**
     * Reads the header: blank is no change; anything that is not a JSON object of the shape
     * {@code {removed?: string[], renamed?: [{from, to}]}}, is nested deeper than {@link #MAX_DEPTH}, or holds a code
     * that is not a locale, is invalid (empty). A missing or null list is empty.
     *
     * @return the changes, {@link #none()} for a blank header, or empty when the header is not valid
     */
    public static Optional<LocaleChanges> read(String header) {
        if (header == null || header.isBlank()) {
            return Optional.of(none());
        }
        Wire wire;
        try {
            wire = JSON.readValue(header, Wire.class);
        } catch (JacksonException e) {
            return Optional.empty();
        }
        if (wire == null) {
            return Optional.empty();
        }
        List<String> removed = new ArrayList<>();
        for (String code : wire.removed() == null ? List.<String>of() : wire.removed()) {
            if (code == null || !TranslationCatalog.isLocale(code)) {
                return Optional.empty();
            }
            removed.add(code);
        }
        List<Rename> renamed = new ArrayList<>();
        for (Rename move : wire.renamed() == null ? List.<Rename>of() : wire.renamed()) {
            if (move == null || move.from() == null || move.to() == null
                || !TranslationCatalog.isLocale(move.from()) || !TranslationCatalog.isLocale(move.to())) {
                return Optional.empty();
            }
            // A move onto itself is dropped.
            if (!move.from().equals(move.to())) {
                renamed.add(move);
            }
        }
        return Optional.of(new LocaleChanges(removed, renamed));
    }

    /**
     * The catalog with these changes applied (the catalog's top-level keys are the locales). The removed
     * locales go first; then each renamed locale's tree moves to its new code. A move onto a locale the catalog already
     * holds merges the two, the moved text winning; every renamed-from key is taken out, and the result is normalized.
     */
    public ObjectNode applyTo(ObjectNode catalog) {
        ObjectNode out = TranslationCatalog.dropLocales(catalog, Set.copyOf(removed));
        Map<String, ObjectNode> moved = new LinkedHashMap<>();
        for (Rename move : renamed) {
            JsonNode tree = out.get(move.from());
            if (tree != null && tree.isObject()) {
                ObjectNode earlier = moved.get(move.to());
                moved.put(move.to(), earlier == null ? (ObjectNode) tree : TranslationCatalog.mergeTrees(earlier, (ObjectNode) tree));
            }
        }
        if (moved.isEmpty()) {
            return TranslationCatalog.normalize(out);
        }
        for (Rename move : renamed) {
            out.remove(move.from());
        }
        moved.forEach((to, tree) -> {
            JsonNode existing = out.get(to);
            out.set(to, existing != null && existing.isObject() ? TranslationCatalog.mergeTrees((ObjectNode) existing, tree) : tree);
        });
        return TranslationCatalog.normalize(out);
    }
}
