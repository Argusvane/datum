package com.argusvane.datum.forms.translation;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.regex.Pattern;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

/**
 * A form's host translation catalog in a nested shape: locale, then kind, then the owner's key, then a
 * tree of property segments whose leaves are strings (the engine's {@code TranslationCatalog},
 * {@code translations.ts}). A stored catalog never holds a blank text: {@link #normalize} drops a blank leaf, and the
 * branches it leaves empty, silently, and {@link #problems} never calls a blank leaf an offence (the
 * "non-blank strings" rule is what remains after normalisation). The {@code form} kind has no owner: its tree holds the form's own properties directly.
 *
 * <p>The in-memory type is an {@link ObjectNode} of exactly that shape, with every object's keys sorted. A tree this
 * deep and this open-ended is what JSON already is, and a typed tree would only copy it to and from the wire; this
 * class holds the rules (what is accepted, how it is cleaned, how locales move) so no caller reads the shape by hand.
 * Nodes handed out by a store are copies: change them freely, write them back.
 *
 * <p>Locales are the definition's own codes ({@code localization.supportedLocales}), not the platform's.
 * Locales are dropped only when a save removes them from the form: a locale the form never declared stays (one added
 * in the builder but not saved yet, or a language the runtime falls back to for a region), so a save never deletes
 * text the builder has not been told to delete.
 *
 * <p>There is no separate key index: the address (locale, kind, owner, path) is the key.
 */
public final class TranslationCatalog {

    /** The most texts (leaves) a catalog may hold, over all locales. */
    public static final int MAX_ENTRIES = 10000;
    /** The most locales a catalog may hold. */
    public static final int MAX_LOCALES = 64;
    /** The longest text, in bytes. */
    public static final int MAX_TEXT_BYTES = 16384;
    /** The longest segment (owner key or property name), in characters. */
    public static final int MAX_KEY_LENGTH = 190;
    /** The most levels of objects below a kind (below the owner, for kinds with owners); the engine's reader stops there too. */
    public static final int MAX_NESTING = 12;
    /** The most problems {@link #problems} lists: a hostile catalog is not described to the last leaf. */
    public static final int MAX_PROBLEMS = 50;

    /** The six kinds, the fixed vocabulary a locale's second level draws from ({@code texts} holds the engine's own words: {@code form} and {@code messages} tables). */
    public static final List<String> KINDS = List.of("form", "components", "chrome", "journeys", "pdf", "texts");

    private static final Set<String> UNSAFE_SEGMENTS = Set.of("__proto__", "constructor", "prototype");
    private static final Pattern LOCALE = Pattern.compile("^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$");
    private static final Pattern PLAIN_SEGMENT = Pattern.compile("^[A-Za-z_][A-Za-z0-9_]*$");

    private TranslationCatalog() {
    }

    /** One thing wrong with a catalog: the JSON path of the offence and a sentence that names it. */
    public record Problem(String path, String message) {
    }

    /** Whether a string looks like a locale code (fr, fr-CA, zh-Hant). */
    public static boolean isLocale(String code) {
        return code != null && LOCALE.matcher(code).matches();
    }

    /** The engine's {@code isSafeSegment}: non-empty and not {@code __proto__}, {@code constructor} or {@code prototype}. */
    public static boolean isSafeSegment(String segment) {
        return segment != null && !segment.isEmpty() && !UNSAFE_SEGMENTS.contains(segment);
    }

    private static boolean isAcceptedSegment(String segment) {
        return isSafeSegment(segment) && segment.length() <= MAX_KEY_LENGTH;
    }

    /** An empty catalog. */
    public static ObjectNode empty() {
        return JsonNodeFactory.instance.objectNode();
    }

    /**
     * The catalog with everything that is not part of the shape dropped: locales that are not codes, kinds that are
     * not one of the five, unsafe or over-long segments, anything but strings at the leaves, blank strings (dropped
     * silently, never an error), trees nested past {@link #MAX_NESTING}; empty branches go with them. Keys are sorted at every level. Whether the input is
     * <em>acceptable</em> is {@link #problems}' question; this never throws.
     *
     * @param catalog decoded JSON
     */
    public static ObjectNode normalize(JsonNode catalog) {
        ObjectNode clean = empty();
        if (catalog == null || !catalog.isObject()) {
            return clean;
        }
        for (Map.Entry<String, JsonNode> locale : sorted(catalog).entrySet()) {
            if (!isLocale(locale.getKey()) || !locale.getValue().isObject()) {
                continue;
            }
            ObjectNode kinds = empty();
            for (Map.Entry<String, JsonNode> kind : sorted(locale.getValue()).entrySet()) {
                if (!KINDS.contains(kind.getKey()) || !kind.getValue().isObject()) {
                    continue;
                }
                if (kind.getKey().equals("form")) {
                    ObjectNode tree = cleanTree(kind.getValue(), 0);
                    if (tree != null) {
                        kinds.set("form", tree);
                    }
                    continue;
                }
                ObjectNode owners = empty();
                for (Map.Entry<String, JsonNode> owner : sorted(kind.getValue()).entrySet()) {
                    ObjectNode tree = isAcceptedSegment(owner.getKey()) ? cleanTree(owner.getValue(), 0) : null;
                    if (tree != null) {
                        owners.set(owner.getKey(), tree);
                    }
                }
                if (!owners.isEmpty()) {
                    kinds.set(kind.getKey(), owners);
                }
            }
            if (!kinds.isEmpty()) {
                clean.set(locale.getKey(), kinds);
            }
        }
        return clean;
    }

    private static ObjectNode cleanTree(JsonNode node, int depth) {
        if (node == null || !node.isObject() || depth > MAX_NESTING) {
            return null;
        }
        ObjectNode out = empty();
        for (Map.Entry<String, JsonNode> entry : sorted(node).entrySet()) {
            if (!isAcceptedSegment(entry.getKey())) {
                continue;
            }
            JsonNode value = entry.getValue();
            if (value.isString()) {
                if (!value.stringValue().isBlank()) {
                    out.put(entry.getKey(), value.stringValue());
                }
            } else {
                ObjectNode child = cleanTree(value, depth + 1);
                if (child != null) {
                    out.set(entry.getKey(), child);
                }
            }
        }
        return out.isEmpty() ? null : out;
    }

    private static TreeMap<String, JsonNode> sorted(JsonNode object) {
        TreeMap<String, JsonNode> sorted = new TreeMap<>();
        object.properties().forEach(e -> sorted.put(e.getKey(), e.getValue()));
        return sorted;
    }

    /** The catalog as a JSON object, a copy the caller may keep (an empty catalog stays an object). */
    public static ObjectNode toJson(ObjectNode catalog) {
        return catalog.deepCopy();
    }

    /** How many texts the catalog holds, over all locales. */
    public static int leafCount(JsonNode catalog) {
        if (catalog == null) {
            return 0;
        }
        if (catalog.isString()) {
            return 1;
        }
        int count = 0;
        if (catalog.isObject()) {
            for (JsonNode child : catalog.values()) {
                count += leafCount(child);
            }
        }
        return count;
    }

    /**
     * Why a decoded value is not a catalog, one entry per offence with its JSON path; empty when it is
     * one. Blank texts are accepted (normalization drops them); everything else outside the shape is a problem. At
     * most {@link #MAX_PROBLEMS} are listed.
     */
    public static List<Problem> problems(JsonNode catalog) {
        List<Problem> problems = new ArrayList<>();
        if (catalog == null || !catalog.isObject()) {
            problems.add(new Problem("$", "A catalog is an object of locale codes, each an object of kinds ("
                + String.join(", ", KINDS) + ")."));
            return problems;
        }
        if (catalog.size() > MAX_LOCALES) {
            problems.add(new Problem("$", "A catalog may hold at most " + MAX_LOCALES + " locales."));
        }
        int[] leaves = {0};
        for (Map.Entry<String, JsonNode> locale : catalog.properties()) {
            if (problems.size() >= MAX_PROBLEMS) {
                break;
            }
            String path = join("$", locale.getKey());
            if (!isLocale(locale.getKey())) {
                problems.add(new Problem(path, path + " is not a locale code."));
            } else if (!locale.getValue().isObject()) {
                problems.add(new Problem(path, path + " must be an object of kinds (" + String.join(", ", KINDS) + ")."));
            } else {
                localeProblems(locale.getValue(), path, leaves, problems);
            }
        }
        if (leaves[0] > MAX_ENTRIES && problems.size() < MAX_PROBLEMS) {
            problems.add(new Problem("$", "A catalog may hold at most " + MAX_ENTRIES + " texts."));
        }
        return problems;
    }

    private static void localeProblems(JsonNode locale, String path, int[] leaves, List<Problem> problems) {
        for (Map.Entry<String, JsonNode> kind : locale.properties()) {
            if (problems.size() >= MAX_PROBLEMS) {
                return;
            }
            String kindPath = join(path, kind.getKey());
            if (!KINDS.contains(kind.getKey())) {
                problems.add(new Problem(kindPath, kindPath + " is not a kind; the kinds are " + String.join(", ", KINDS) + "."));
            } else if (!kind.getValue().isObject()) {
                problems.add(new Problem(kindPath, kindPath + " must be an object."));
            } else if (kind.getKey().equals("form")) {
                treeProblems(kind.getValue(), kindPath, 0, leaves, problems);
            } else {
                for (Map.Entry<String, JsonNode> owner : kind.getValue().properties()) {
                    if (problems.size() >= MAX_PROBLEMS) {
                        return;
                    }
                    String ownerPath = join(kindPath, owner.getKey());
                    if (!isSafeSegment(owner.getKey())) {
                        problems.add(new Problem(ownerPath, ownerPath + " is not a usable key."));
                    } else if (owner.getKey().length() > MAX_KEY_LENGTH) {
                        problems.add(new Problem(ownerPath, "A key may be at most " + MAX_KEY_LENGTH + " characters: " + ownerPath + "."));
                    } else if (!owner.getValue().isObject()) {
                        problems.add(new Problem(ownerPath, ownerPath + " must be an object of the owner's properties."));
                    } else {
                        treeProblems(owner.getValue(), ownerPath, 0, leaves, problems);
                    }
                }
            }
        }
    }

    private static void treeProblems(JsonNode tree, String path, int depth, int[] leaves, List<Problem> problems) {
        for (Map.Entry<String, JsonNode> entry : tree.properties()) {
            if (problems.size() >= MAX_PROBLEMS) {
                return;
            }
            String here = join(path, entry.getKey());
            if (!isSafeSegment(entry.getKey())) {
                problems.add(new Problem(here, here + " is not a usable key."));
                continue;
            }
            if (entry.getKey().length() > MAX_KEY_LENGTH) {
                problems.add(new Problem(here, "A key may be at most " + MAX_KEY_LENGTH + " characters: " + here + "."));
                continue;
            }
            JsonNode value = entry.getValue();
            if (value.isString()) {
                leaves[0]++;
                if (value.stringValue().getBytes(StandardCharsets.UTF_8).length > MAX_TEXT_BYTES) {
                    problems.add(new Problem(here, here + " is longer than " + MAX_TEXT_BYTES + " bytes."));
                }
            } else if (value.isObject()) {
                if (depth + 1 > MAX_NESTING) {
                    problems.add(new Problem(here, here + " is nested more than " + MAX_NESTING + " levels deep."));
                } else {
                    treeProblems(value, here, depth + 1, leaves, problems);
                }
            } else {
                problems.add(new Problem(here, here + " must be text or an object."));
            }
        }
    }

    /** {@code parent} extended by a segment in JSON path notation: dotted when plain, bracketed (and clipped) otherwise. */
    static String join(String parent, String segment) {
        String shown = segment.length() > 40 ? segment.substring(0, 40) + "..." : segment;
        return PLAIN_SEGMENT.matcher(shown).matches() ? parent + "." + shown : parent + "['" + shown.replace("'", "\\'") + "']";
    }

    /** The catalog without some locales. */
    public static ObjectNode dropLocales(ObjectNode catalog, Set<String> locales) {
        ObjectNode kept = catalog.deepCopy();
        kept.remove(locales);
        return kept;
    }

    /**
     * The catalog after a save: locales are dropped only when {@code before} supported them and {@code after} no longer
     * does.
     *
     * @param before the definition as it was stored (null for a first save: nothing is dropped)
     * @param after the definition being saved
     */
    public static ObjectNode afterSave(ObjectNode catalog, JsonNode before, JsonNode after) {
        return dropLocales(catalog, removedLocales(before, after));
    }

    /** The locale codes {@code before} declared that {@code after} does not. */
    public static Set<String> removedLocales(JsonNode before, JsonNode after) {
        Set<String> removed = new LinkedHashSet<>(supportedLocales(before).keySet());
        removed.removeAll(supportedLocales(after).keySet());
        return removed;
    }

    /** The locales a definition supports, code to label, in the definition's order. */
    public static Map<String, String> supportedLocales(JsonNode definition) {
        Map<String, String> locales = new LinkedHashMap<>();
        if (definition == null) {
            return locales;
        }
        for (JsonNode entry : definition.path("localization").path("supportedLocales")) {
            String code = entry.path("code").isString() ? entry.path("code").stringValue() : null;
            if (code != null && isLocale(code)) {
                JsonNode label = entry.path("label");
                locales.put(code, label.isString() && !label.stringValue().isEmpty() ? label.stringValue() : code);
            }
        }
        return locales;
    }

    /**
     * An import merged into a stored catalog, text by text: the import's texts win, everything stored that it does not
     * name stays. The result is normalized.
     */
    public static ObjectNode merge(ObjectNode stored, ObjectNode imported) {
        return normalize(mergeTrees(stored, imported));
    }

    /** {@code over} laid on {@code base}, object by object; where the two differ in kind (text against object) {@code over} wins. */
    public static ObjectNode mergeTrees(ObjectNode base, ObjectNode over) {
        ObjectNode merged = base.deepCopy();
        for (Map.Entry<String, JsonNode> entry : over.properties()) {
            JsonNode existing = merged.get(entry.getKey());
            if (existing != null && existing.isObject() && entry.getValue().isObject()) {
                merged.set(entry.getKey(), mergeTrees((ObjectNode) existing, (ObjectNode) entry.getValue()));
            } else {
                merged.set(entry.getKey(), entry.getValue().deepCopy());
            }
        }
        return merged;
    }
}
