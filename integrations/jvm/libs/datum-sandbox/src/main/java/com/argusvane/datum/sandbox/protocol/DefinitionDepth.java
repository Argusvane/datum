package com.argusvane.datum.sandbox.protocol;

import com.argusvane.datum.core.DefinitionTooDeepException;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import tools.jackson.databind.JsonNode;

/**
 * The depth guard run before any guest starts (conformance suite RES-07 and DEF-06).
 *
 * <p>The sandbox program's QuickJS has a fixed wasm shadow stack that no flag raises: its kernel walk traps,
 * where no JavaScript catch reaches, at about 81 levels, and QuickJS's own stack limit never fires. So a definition is measured here,
 * iteratively (a hostile tree costs no
 * recursion), and refused past {@link #MAX_COMPONENT_DEPTH} component levels, the root counting as level 1;
 * the form's tree and each node a journey page owns are measured apart. The raw JSON depth
 * ({@link #MAX_DEPTH}) bounds everything else in a definition (rules, options, layouts), which the component walk
 * does not see, and stays below the program's own request bound (320 levels, RES-06), so a deep definition is a typed
 * {@code definition.tooDeep} here rather than a refused request there; a definition may reach this host from any
 * repository, so it is measured here, before the guest. The walk is the kernel's {@code kernelComponentTooDeep}
 * (an explicit stack, the last child first, the same {@code root > slot > id} location).
 */
public final class DefinitionDepth {

    /** The most component levels a definition may nest, the root's included. */
    public static final int MAX_COMPONENT_DEPTH = 32;

    /**
     * The deepest a definition may nest as JSON, counted by {@link #jsonDepth}: the innermost value counts as a
     * level, so at most 255 arrays and objects nest (the builder's save refuses a 257-level body, BLD-06).
     */
    public static final int MAX_DEPTH = 256;

    /** The longest id written into a location; a longer one is named by its position, as the kernel does. */
    private static final int MAX_ID_LABEL = 64;

    /** The longest slot name written into a location; a longer one reads {@code ?}. */
    private static final int MAX_SLOT_LABEL = 32;

    private DefinitionDepth() {
    }

    /**
     * One node of the walk. Its location is a parent link written out only for the node the walk reports, so the
     * walk costs the size of the body: building {@code where + " > " + slot + " > " + id} for every
     * child pushed would cost the square of the body when a few ids are very long.
     */
    private record Frame(JsonNode node, int level, Frame parent, String slot, String label) {

        String where() {
            Deque<String> parts = new ArrayDeque<>();
            for (Frame at = this; at != null; at = at.parent) {
                parts.push(at.label);
                if (at.parent != null) {
                    parts.push(at.slot);
                }
            }
            return String.join(" > ", parts);
        }
    }

    private static String cut(String text, int codePoints) {
        return text.codePointCount(0, text.length()) <= codePoints ? text : text.substring(0, text.offsetByCodePoints(0, codePoints));
    }

    /**
     * Where a definition nests components deeper than {@link #MAX_COMPONENT_DEPTH}, if it does.
     *
     * @param definition a form definition: {@code root}, and {@code journey.journeys[].pages[].components[]}
     * @return the readable location of the first component found past the limit, in the walk's order (last child
     *     first, depth first: {@code root > content > g1 > content > ...})
     */
    public static Optional<String> tooDeep(JsonNode definition) {
        if (definition == null || !definition.isObject()) {
            return Optional.empty();
        }
        List<Frame> trees = new ArrayList<>();
        JsonNode root = definition.get("root");
        if (root != null && root.isObject()) {
            trees.add(new Frame(root, 1, null, null, "root"));
        }
        for (JsonNode entry : ownEntries(definition)) {
            JsonNode id = entry.get("id");
            trees.add(new Frame(entry, 1, null, null, id != null && id.isString() ? cut(id.stringValue(), MAX_ID_LABEL) : "a journey page entry"));
        }
        for (Frame tree : trees) {
            Deque<Frame> stack = new ArrayDeque<>();
            stack.push(tree);
            while (!stack.isEmpty()) {
                // A stack: the last child pushed is visited first, which decides which too-deep component is named.
                Frame top = stack.pop();
                if (top.level > MAX_COMPONENT_DEPTH) {
                    return Optional.of(top.where());
                }
                JsonNode children = top.node.get("children");
                if (children == null || !children.isObject()) {
                    continue;
                }
                for (Map.Entry<String, JsonNode> slot : children.properties()) {
                    JsonNode list = slot.getValue();
                    if (!list.isArray()) {
                        continue;
                    }
                    int index = 0;
                    for (JsonNode child : list.values()) {
                        if (child.isObject()) {
                            JsonNode id = child.get("id");
                            String label = id != null && id.isString() && id.stringValue().codePointCount(0, id.stringValue().length()) <= MAX_ID_LABEL
                                ? id.stringValue() : "#" + index;
                            String slotName = slot.getKey().codePointCount(0, slot.getKey().length()) <= MAX_SLOT_LABEL ? slot.getKey() : "?";
                            stack.push(new Frame(child, top.level + 1, top, slotName, label));
                        }
                        index++;
                    }
                }
            }
        }
        return Optional.empty();
    }

    /**
     * The objects a journey page owns, in order: the kernel's reading, {@code journey.journeys} as a list, each page's
     * {@code components} list, its object entries (a string entry names a form component, which the form's tree
     * measures).
     */
    static List<JsonNode> ownEntries(JsonNode definition) {
        List<JsonNode> entries = new ArrayList<>();
        JsonNode journey = definition.get("journey");
        if (journey == null || !journey.isObject()) {
            return entries;
        }
        JsonNode journeys = journey.get("journeys");
        if (journeys == null || !journeys.isArray()) {
            return entries;
        }
        for (JsonNode one : journeys.values()) {
            JsonNode pages = one.isObject() ? one.get("pages") : null;
            if (pages == null || !pages.isArray()) {
                continue;
            }
            for (JsonNode page : pages.values()) {
                JsonNode components = page.isObject() ? page.get("components") : null;
                if (components == null || !components.isArray()) {
                    continue;
                }
                for (JsonNode entry : components.values()) {
                    if (entry.isObject()) {
                        entries.add(entry);
                    }
                }
            }
        }
        return entries;
    }

    /**
     * A value's nesting depth, the innermost value counting as a level: a scalar is 1, a container one more than its
     * deepest member, an empty container 2. Iterative, so a hostile tree costs no recursion.
     */
    public static int jsonDepth(JsonNode value) {
        int deepest = 1;
        Deque<Object[]> stack = new ArrayDeque<>();
        stack.push(new Object[] {value, 1});
        while (!stack.isEmpty()) {
            Object[] top = stack.pop();
            JsonNode node = (JsonNode) top[0];
            int level = (Integer) top[1];
            if (node.isContainer()) {
                deepest = Math.max(deepest, level + 1);
                for (JsonNode child : node.values()) {
                    stack.push(new Object[] {child, level + 1});
                }
            } else {
                deepest = Math.max(deepest, level);
            }
        }
        return deepest;
    }

    /**
     * Refuses a definition that nests past either limit, before any guest starts.
     *
     * @throws DefinitionTooDeepException with the limit that was passed
     */
    public static void assertShallow(JsonNode definition) {
        assertRawDepth(definition, "definition");
        assertComponentDepth(definition);
    }

    /**
     * Refuses a value deeper than {@link #MAX_DEPTH}.
     *
     * @param what "definition", "form" or "journey", for the message
     */
    public static void assertRawDepth(JsonNode value, String what) {
        if (value != null && jsonDepth(value) > MAX_DEPTH) {
            throw new DefinitionTooDeepException(MAX_DEPTH, "The " + what + " nests more than " + MAX_DEPTH + " levels deep as JSON.");
        }
    }

    /** Refuses a definition whose components nest past {@link #MAX_COMPONENT_DEPTH}. */
    public static void assertComponentDepth(JsonNode definition) {
        Optional<String> where = tooDeep(definition);
        if (where.isPresent()) {
            throw new DefinitionTooDeepException(MAX_COMPONENT_DEPTH, "The definition nests components too deeply (at " + where.get() + ").");
        }
    }
}
