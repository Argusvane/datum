package com.argusvane.datum.ui.builder;

import com.argusvane.datum.sandbox.protocol.DefinitionDepth;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.function.Supplier;
import java.util.regex.Pattern;
import tools.jackson.databind.JsonNode;

/**
 * The host's own reading of a definition's shape before the kernel is asked (conformance suite BLD-03,
 * BLD-06, DEF-05, DEF-06).
 *
 * <p>Why a second reading at all: the size caps are the kernel's own ({@code limits} in the {@code check} answer),
 * counted here in one early-exit pass so a hostile definition is refused before a
 * sandbox run starts and before a 32 MiB guest has to parse it. Every finding carries a stable code named as the
 * kernel names its structure problems, so a client reads codes from one list whichever side found the problem.
 *
 * <p>The checks and their sentences are the builder's 422 body (endpoint catalog {@code saveForm}), in a fixed order
 * (identity first, then the components, then depth or size, then PDF layout ids) so the same body always gets the same
 * list. The walks are iterative; the component walk is pre-order, children in slot and list order.
 *
 * <p>Cost: this runs on a body nobody has checked yet, before any cap but the byte
 * size, so every walk is linear in the body. A location is a {@link Where}: a link to its parent plus one step,
 * written out only for a finding that is kept, with each id and slot name cut to {@value #LABEL_MAX} code points
 * as the kernel cuts its labels. A walk that built every child's full path string eagerly would cost the square of
 * the body for one long id over many siblings (a 980 KB body can exhaust an 8 GiB heap), so here a location
 * costs one small object. Each list of findings stops at the kernel's {@value #MAX_PROBLEMS} with
 * {@code definition.problemsTruncated}.
 */
public final class DefinitionShape {

    /** The longest version a definition may carry: every snapshot and submission records it (64). */
    public static final int MAX_VERSION_LENGTH = 64;

    /** The most components a definition may hold, the root's form not counted (kernel limit). */
    public static final int MAX_COMPONENTS = 10000;

    /** The most inline options one component may hold. */
    public static final int MAX_OPTIONS_PER_COMPONENT = 2000;

    /** The most inline options a definition may hold in all. */
    public static final int MAX_OPTIONS_TOTAL = 50000;

    /** The most findings one list holds before {@code definition.problemsTruncated}: the kernel's {@code problems} limit. */
    public static final int MAX_PROBLEMS = 200;

    /** The most code points of an id or slot name shown in a location (the kernel shows at most 64 of an id). */
    public static final int LABEL_MAX = 64;

    /** A journey page's reference to a form component and its worked-out value: they draw no type of their own. */
    private static final Set<String> UNDRAWN_TYPES = Set.of("journey-field", "journey-value");

    /** A PDF layout id is part of its PDF's address (the layout a PDF request names), so it is a URL-safe word. */
    private static final Pattern LAYOUT_ID = Pattern.compile("^[A-Za-z0-9_.:-]{1,128}$");

    private DefinitionShape() {
    }

    /**
     * One finding: a stable code, where it is, a sentence for the author, and the limit when a cap was passed.
     */
    public record Finding(String code, String where, String message, Integer limit) {

        /** A finding of the size pass, worded by {@link #describe}. */
        static Finding sized(String code, String where, int limit) {
            return new Finding(code, where, describe(code, where, limit, null), limit);
        }
    }

    /**
     * What is wrong with a decoded definition's shape, in this order: not an object; id, version and
     * schemaVersion (each a string that is not blank); the version's length; the root; every component's id and
     * type; the component depth, else
     * the size caps; PDF layout ids. Empty when the shape is sound.
     */
    public static List<Finding> problemList(JsonNode definition) {
        if (definition == null || !definition.isObject()) {
            return List.of(new Finding("definition.notRecord", "definition", "A form definition is a JSON object.", null));
        }
        List<Finding> problems = new ArrayList<>();
        for (String key : List.of("id", "version", "schemaVersion")) {
            JsonNode value = definition.get(key);
            if (value == null || !value.isString() || value.stringValue().isBlank()) {
                problems.add(new Finding("definition." + key + ".invalid", "definition",
                    "The definition needs a \"" + key + "\" string.", null));
            }
        }
        JsonNode version = definition.get("version");
        if (version != null && version.isString()
            && version.stringValue().codePointCount(0, version.stringValue().length()) > MAX_VERSION_LENGTH) {
            problems.add(new Finding("definition.version.tooLong", "definition",
                "The version may be at most " + MAX_VERSION_LENGTH + " characters.", MAX_VERSION_LENGTH));
        }
        JsonNode root = definition.get("root");
        if (root == null || !root.isObject()) {
            problems.add(new Finding("definition.root.missing", "definition", "The definition needs a \"root\" component.", null));
        } else if (!"form".equals(textOrNull(root.get("type")))) {
            problems.add(new Finding("definition.root.type", "root", "The root component must have type \"form\".", null));
        } else {
            Capped components = new Capped(problems);
            walk(root, Where.root("root"), (node, where) -> {
                JsonNode id = node.get("id");
                if (id == null || !id.isString() || id.stringValue().isEmpty()) {
                    components.add(() -> {
                        String at = where.text();
                        return new Finding("component.id.invalid", at, "A component at " + at + " has no id.", null);
                    });
                }
                JsonNode type = node.get("type");
                if (type == null || !type.isString() || type.stringValue().isEmpty()) {
                    components.add(() -> {
                        String at = where.text();
                        return new Finding("component.type.invalid", at, "A component at " + at + " has no type.", null);
                    });
                }
            });
        }
        Depth depth = depth(definition);
        if (depth.tooDeep() != null) {
            int limit = DefinitionDepth.MAX_COMPONENT_DEPTH;
            String at = depth.tooDeep().text();
            problems.add(new Finding("definition.tooDeep", at, describe("definition.tooDeep", at, limit, null), limit));
        } else {
            // Counted only when the nesting is sound: a definition too deep is refused already, and its count would
            // name components the author cannot reach anyway.
            problems.addAll(sizeFindings(definition));
        }
        JsonNode pdf = definition.get("pdf");
        JsonNode layouts = pdf != null && pdf.isObject() ? pdf.get("layouts") : null;
        if (layouts != null && layouts.isArray()) {
            Capped layoutProblems = new Capped(problems);
            for (JsonNode layout : layouts.values()) {
                String id = layout.isObject() ? textOrNull(layout.get("id")) : null;
                if (id != null && !id.isEmpty() && !LAYOUT_ID.matcher(id).matches()) {
                    layoutProblems.add(() -> new Finding("pdf.layout.invalid", "pdf", "The PDF layout id \"" + codePoints(id, LABEL_MAX)
                        + "\" may hold only letters, digits, \"_\", \".\", \":\" and \"-\", at most 128: it is part of the PDF's address.", null));
                }
            }
        }
        return problems;
    }

    /**
     * The size caps a definition passes, found without a sandbox (the kernel's caps, DEF-05). One pass with
     * an early exit at the component cap over the form's tree, each journey page's own nodes and each PDF layout's
     * tree, so the work is bounded by the cap and not by the definition.
     */
    public static List<Finding> sizeFindings(JsonNode definition) {
        List<Finding> findings = new ArrayList<>();
        Capped options = new Capped(findings);
        int count = 0;
        long optionsTotal = 0;
        boolean over = false;
        List<Step> trees = new ArrayList<>();
        JsonNode root = definition.get("root");
        if (root != null && root.isObject()) {
            trees.add(new Step(root, Where.root("root"), 0));
        }
        for (JsonNode entry : ownEntries(definition)) {
            trees.add(new Step(entry, Where.root("journey"), 0));
        }
        JsonNode pdf = definition.get("pdf");
        JsonNode layouts = pdf != null && pdf.isObject() ? pdf.get("layouts") : null;
        if (layouts != null && layouts.isArray()) {
            for (JsonNode layout : layouts.values()) {
                JsonNode layoutRoot = layout.isObject() ? layout.get("root") : null;
                if (layoutRoot != null && layoutRoot.isObject()) {
                    trees.add(new Step(layoutRoot, Where.root("pdf"), 0));
                }
            }
        }
        for (Step tree : trees) {
            Deque<Step> stack = new ArrayDeque<>();
            stack.push(tree);
            while (!stack.isEmpty() && !over) {
                // A stack: the last child pushed is visited next (the order of datum-core's depth guard).
                Step top = stack.pop();
                JsonNode node = top.node();
                Where where = top.where();
                if (node != root) {
                    count++;
                }
                if (count > MAX_COMPONENTS) {
                    over = true;
                    break;
                }
                JsonNode configuration = node.get("configuration");
                JsonNode list = configuration != null && configuration.isObject() ? configuration.get("options") : null;
                if (list != null && list.isArray()) {
                    optionsTotal += list.size();
                    if (list.size() > MAX_OPTIONS_PER_COMPONENT) {
                        options.add(() -> Finding.sized("option.tooMany", where.text(), MAX_OPTIONS_PER_COMPONENT));
                    }
                }
                pushChildren(stack, node, where, 0, false);
            }
            if (over) {
                break;
            }
        }
        if (over) {
            findings.add(Finding.sized("definition.tooManyComponents", "definition", MAX_COMPONENTS));
        }
        if (optionsTotal > MAX_OPTIONS_TOTAL) {
            findings.add(Finding.sized("option.total.tooMany", "definition", MAX_OPTIONS_TOTAL));
        }
        return findings;
    }

    /**
     * A finding in words for a person: the builder's own sentences for the problems it finds itself and for the size
     * caps; for any other code the kernel's own message and where it is, so an
     * unknown future code never reads as nothing.
     */
    public static String describe(String code, String where, Integer limit, String message) {
        String at = where == null ? "" : where;
        return switch (code) {
            case "definition.id.invalid" -> "The definition needs a \"id\" string.";
            case "definition.version.invalid" -> "The definition needs a \"version\" string.";
            case "definition.schemaVersion.invalid" -> "The definition needs a \"schemaVersion\" string.";
            case "definition.version.tooLong" -> "The version may be at most " + (limit != null ? limit : MAX_VERSION_LENGTH) + " characters.";
            case "definition.root.type" -> "The root component must have type \"form\".";
            case "definition.tooDeep" -> "Components nest more than " + DefinitionDepth.MAX_COMPONENT_DEPTH + " levels deep (at " + at
                + "): the validator reads at most " + DefinitionDepth.MAX_COMPONENT_DEPTH + ".";
            case "definition.tooManyComponents" -> {
                int cap = limit != null ? limit : MAX_COMPONENTS;
                yield "The definition has more than " + cap + " components: a form may have at most " + cap + ".";
            }
            case "option.tooMany" -> "The component at " + at + " has more than " + (limit != null ? limit : MAX_OPTIONS_PER_COMPONENT)
                + " inline options: put long lists in a data source.";
            case "option.total.tooMany" -> "The definition has more than " + (limit != null ? limit : MAX_OPTIONS_TOTAL) + " inline options in all.";
            // A host-only code: the kernel's sentence.
            case "definition.problemsTruncated" -> "More problems were found than are listed.";
            default -> (message != null && !message.isEmpty() ? message : code) + (at.isEmpty() ? "" : " (at " + at + ")");
        };
    }

    /**
     * Every component type a definition uses, the root's included and a journey page's own nodes too;
     * a reference ({@code journey-field}) and a worked-out value ({@code journey-value}) draw no type of their own.
     * Sorted, unique.
     */
    public static List<String> types(JsonNode definition) {
        Set<String> types = new TreeSet<>();
        JsonNode root = definition.get("root");
        if (root != null && root.isObject()) {
            walk(root, Where.root("root"), (node, where) -> {
                String type = textOrNull(node.get("type"));
                if (type != null) {
                    types.add(type);
                }
            });
        }
        for (JsonNode entry : ownEntries(definition)) {
            walk(entry, Where.root("journey"), (node, where) -> {
                String type = textOrNull(node.get("type"));
                if (type != null && !UNDRAWN_TYPES.contains(type)) {
                    types.add(type);
                }
            });
        }
        return List.copyOf(types);
    }

    /** The types a definition uses that nothing this host knows draws, sorted. */
    public static List<String> unknownTypes(JsonNode definition, List<String> known) {
        Set<String> knownSet = Set.copyOf(known);
        return types(definition).stream().filter(type -> !knownSet.contains(type)).toList();
    }

    /**
     * Whether the definition holds a number JSON cannot write (1e999 decodes to infinity): a save answers 422
     * {@code definition.number.nonFinite} (BLD-06, numbers past the float range) because such a number breaks the
     * snapshot and the sandbox request after the save began, and would hash as {@code null} (the canonical writer has
     * no form for it).
     */
    public static boolean hasNonFiniteNumber(JsonNode value) {
        Deque<JsonNode> stack = new ArrayDeque<>();
        stack.push(value);
        while (!stack.isEmpty()) {
            JsonNode node = stack.pop();
            // Through java.lang.Number: Jackson's own doubleValue() throws for an integer past the double range,
            // where BigInteger.doubleValue() answers infinity.
            if (node.isNumber() && !Double.isFinite(node.numberValue().doubleValue())) {
                return true;
            }
            if (node.isContainer()) {
                for (JsonNode child : node.values()) {
                    stack.push(child);
                }
            }
        }
        return false;
    }

    /** The visitor of {@link #walk}: a node and its location, written out only if the visitor asks. */
    @FunctionalInterface
    interface Visitor {
        void visit(JsonNode node, Where where);
    }

    /**
     * Visits every component depth first, pre-order, children in slot and list order, without recursion. A child
     * without a string id is named by its index. Linear in the tree: a location is
     * a link to its parent ({@link Where}), not a string.
     */
    static void walk(JsonNode start, Where startWhere, Visitor visitor) {
        Deque<Step> stack = new ArrayDeque<>();
        stack.push(new Step(start, startWhere, 0));
        while (!stack.isEmpty()) {
            Step top = stack.pop();
            visitor.visit(top.node(), top.where());
            // Pushed in reverse so the first child is visited first, as the recursion does.
            pushChildren(stack, top.node(), top.where(), 0, true);
        }
    }

    /**
     * Pushes a component's object children with their locations: in document order (popped last first, the depth and
     * size walks), or reversed (popped in document order, the pre-order walk).
     */
    private static void pushChildren(Deque<Step> stack, JsonNode node, Where where, int level, boolean reversed) {
        JsonNode children = node.get("children");
        if (children == null || !children.isObject()) {
            return;
        }
        List<Step> next = reversed ? new ArrayList<>() : null;
        for (Map.Entry<String, JsonNode> slot : children.properties()) {
            if (!slot.getValue().isArray()) {
                continue;
            }
            int index = 0;
            for (JsonNode child : slot.getValue().values()) {
                if (child.isObject()) {
                    Step step = new Step(child, where.child(slot.getKey(), textOrNull(child.get("id")), index), level + 1);
                    if (reversed) {
                        next.add(step);
                    } else {
                        stack.push(step);
                    }
                }
                index++;
            }
        }
        if (reversed) {
            for (int i = next.size() - 1; i >= 0; i--) {
                stack.push(next.get(i));
            }
        }
    }

    /** What {@link #depth} found: the first component past the depth limit, or null. */
    record Depth(Where tooDeep) {
    }

    /**
     * datum-core's {@code DefinitionDepth.tooDeep}: the first component, in its stack order (the last child first)
     * over the form's tree and then each journey page's own nodes, that nests past
     * {@link DefinitionDepth#MAX_COMPONENT_DEPTH} levels, the root counting as one. Measured here so a hostile
     * body costs a linear walk. datum-core's method is linear too (its locations are parent links, as here);
     * this copy stays because it names the location with the builder's cut labels.
     */
    static Depth depth(JsonNode definition) {
        List<Step> trees = new ArrayList<>();
        JsonNode root = definition.get("root");
        if (root != null && root.isObject()) {
            trees.add(new Step(root, Where.root("root"), 1));
        }
        for (JsonNode entry : ownEntries(definition)) {
            String id = textOrNull(entry.get("id"));
            trees.add(new Step(entry, Where.root(id != null ? id : "a journey page entry"), 1));
        }
        for (Step tree : trees) {
            Deque<Step> stack = new ArrayDeque<>();
            stack.push(tree);
            while (!stack.isEmpty()) {
                Step top = stack.pop();
                if (top.level() > DefinitionDepth.MAX_COMPONENT_DEPTH) {
                    return new Depth(top.where());
                }
                pushChildren(stack, top.node(), top.where(), top.level(), false);
            }
        }
        return new Depth(null);
    }

    /** A component waiting in a walk: the node, where it is, and its level (the root is 1 where levels count). */
    record Step(JsonNode node, Where where, int level) {
    }

    /**
     * A component's location, {@code root > slot > id > slot > #index}, kept as a link to its parent and written
     * out only when a finding needs it ({@link #text()}), each id and slot name cut to {@value #LABEL_MAX} code
     * points.
     */
    static final class Where {

        private final Where parent;
        private final String slot;
        private final String label;

        private Where(Where parent, String slot, String label) {
            this.parent = parent;
            this.slot = slot;
            this.label = label;
        }

        static Where root(String name) {
            return new Where(null, null, name);
        }

        /** A child in {@code slot}, named by its id, else {@code #index}. */
        Where child(String slotName, String id, int index) {
            return new Where(this, slotName, id != null ? id : "#" + index);
        }

        /** The location for a person, ids and slot names cut to {@value #LABEL_MAX} code points. */
        String text() {
            Deque<Where> chain = new ArrayDeque<>();
            for (Where at = this; at != null; at = at.parent) {
                chain.push(at);
            }
            StringBuilder out = new StringBuilder();
            for (Where at : chain) {
                if (at.parent != null) {
                    out.append(" > ").append(codePoints(at.slot, LABEL_MAX)).append(" > ");
                }
                out.append(codePoints(at.label, LABEL_MAX));
            }
            return out.toString();
        }
    }

    /**
     * One list of findings that stops at {@link #MAX_PROBLEMS}, then says so once with the kernel's
     * {@code definition.problemsTruncated}. A finding past the cap is never built, so its location is never
     * written out.
     */
    static final class Capped {

        private final List<Finding> into;
        private int kept;
        private boolean truncated;

        Capped(List<Finding> into) {
            this.into = into;
        }

        void add(Supplier<Finding> finding) {
            if (kept < MAX_PROBLEMS) {
                into.add(finding.get());
                kept++;
            } else if (!truncated) {
                truncated = true;
                into.add(new Finding("definition.problemsTruncated", "definition",
                    describe("definition.problemsTruncated", "", MAX_PROBLEMS, null), MAX_PROBLEMS));
            }
        }
    }

    /**
     * The object entries of every journey page (a presentation's own nodes), read as the kernel and
     * datum-core's depth guard read them: {@code journey.journeys} as a list.
     */
    static List<JsonNode> ownEntries(JsonNode definition) {
        List<JsonNode> entries = new ArrayList<>();
        JsonNode journey = definition.get("journey");
        JsonNode journeys = journey != null && journey.isObject() ? journey.get("journeys") : null;
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

    private static String textOrNull(JsonNode node) {
        return node != null && node.isString() ? node.stringValue() : null;
    }

    /** At most {@code n} code points of {@code text}, so a cut never splits a surrogate pair. */
    static String codePoints(String text, int n) {
        if (text.codePointCount(0, text.length()) <= n) {
            return text;
        }
        return text.substring(0, text.offsetByCodePoints(0, n));
    }
}
