package com.argusvane.datum.sandbox.protocol;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import com.argusvane.datum.core.DefinitionTooDeepException;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

/** The component depth guard, and the raw JSON depth. */
class DefinitionDepthTest {

    private static final JsonNodeFactory F = JsonNodeFactory.instance;

    private static ObjectNode component(String id, String type) {
        ObjectNode node = F.objectNode();
        node.put("id", id);
        node.put("type", type);
        node.set("configuration", F.objectNode());
        return node;
    }

    private static ObjectNode withChild(ObjectNode parent, JsonNode child) {
        ObjectNode children = F.objectNode();
        children.set("content", F.arrayNode().add(child));
        parent.set("children", children);
        return parent;
    }

    /** A definition in groups nested {@code levels} deep, the root's level included. */
    static ObjectNode nested(int levels) {
        ObjectNode node = component("leaf", "text");
        for (int i = levels - 2; i >= 1; i--) {
            node = withChild(component("g" + i, "group"), node);
        }
        ObjectNode definition = F.objectNode();
        definition.put("id", "f");
        definition.put("version", "1");
        definition.put("schemaVersion", "1");
        definition.set("root", withChild(component("root", "form"), node));
        return definition;
    }

    @Test
    void aDefinitionMayNest32ComponentLevels() {
        assertThat(DefinitionDepth.tooDeep(nested(32))).isEmpty();
        DefinitionDepth.assertShallow(nested(32));

        String where = DefinitionDepth.tooDeep(nested(33)).orElseThrow();
        assertThat(where).startsWith("root > content > g1 > content > g2").endsWith("> leaf");
        assertThatThrownBy(() -> DefinitionDepth.assertShallow(nested(33)))
            .isInstanceOfSatisfying(DefinitionTooDeepException.class, e -> {
                assertThat(e.code()).isEqualTo("definition.tooDeep");
                // A caller's definition (a save, an inspect): the caller's 422; the submission service makes a registered
                // form's refusal its 503 (DefinitionTooDeepException.registered).
                assertThat(e.httpStatus()).isEqualTo(422);
                assertThat(DefinitionTooDeepException.registered(e).httpStatus()).isEqualTo(503);
                assertThat(DefinitionTooDeepException.registered(e).code()).isEqualTo("definition.tooDeep");
                assertThat(e.limit()).isEqualTo(32);
                assertThat(e.getMessage()).isEqualTo("The definition nests components too deeply (at " + where + ").");
            });
        // The JSON decode depth (256, three brackets a level) is not a bound on its own: it lets 83 levels in,
        // and the program traps from about 81.
        assertThat(DefinitionDepth.tooDeep(nested(70))).isPresent();
    }

    /** The nodes a journey page owns are measured too, each from its own level 1. */
    @Test
    void ownNodesAreMeasured() {
        ObjectNode definition = nested(3);
        definition.set("journey", journeyOwning(32));
        String where = DefinitionDepth.tooDeep(definition).orElseThrow();
        assertThat(where).startsWith("o32 > content > o31 > ").endsWith("o1 > content > leaf");
        // 31 owned levels and the leaf make 32: sound.
        definition.set("journey", journeyOwning(31));
        assertThat(DefinitionDepth.tooDeep(definition)).isEmpty();
        // journeys that are not a list are not read, as the kernel's walk does not read them (its structure check
        // refuses that shape on its own).
        ObjectNode asObject = F.objectNode();
        asObject.set("j", journeyOwning(32).get("journeys").get(0));
        ObjectNode journey = F.objectNode();
        journey.set("journeys", asObject);
        definition.set("journey", journey);
        assertThat(DefinitionDepth.tooDeep(definition)).isEmpty();
    }

    private static ObjectNode journeyOwning(int levels) {
        ObjectNode own = F.objectNode();
        own.put("id", "leaf");
        own.put("type", "text");
        for (int i = 1; i <= levels; i++) {
            ObjectNode wrap = F.objectNode();
            wrap.put("id", "o" + i);
            wrap.put("type", "columns");
            withChild(wrap, own);
            own = wrap;
        }
        ObjectNode page = F.objectNode();
        page.put("id", "p");
        page.set("components", F.arrayNode().add("a-form-id").add(own));
        ObjectNode one = F.objectNode();
        one.put("id", "j");
        one.set("pages", F.arrayNode().add(page));
        ObjectNode journey = F.objectNode();
        journey.set("journeys", F.arrayNode().add(one));
        return journey;
    }

    /** Children without ids are labelled by index; slots that are not lists and non-objects are skipped. */
    @Test
    void labelsAndSkippedShapes() {
        ObjectNode node = F.objectNode();
        for (int i = 0; i < 33; i++) {
            ObjectNode wrap = F.objectNode();
            ObjectNode children = F.objectNode();
            children.set("items", F.arrayNode().add("not a component").add(node));
            children.set("odd", F.objectNode());
            wrap.set("children", children);
            node = wrap;
        }
        ObjectNode definition = F.objectNode();
        definition.set("root", node);
        assertThat(DefinitionDepth.tooDeep(definition).orElseThrow()).startsWith("root > items > #1 > items > #1");
        assertThat(DefinitionDepth.tooDeep(F.objectNode())).isEmpty();
        assertThat(DefinitionDepth.tooDeep(F.arrayNode())).isEmpty();
    }

    /**
     * The location is built for the reported node only (not for every sibling): 20,000 siblings with 5,000-character ids
     * (about 100 MB of body) walk in well under a second, and a long id or slot name is cut as the kernel cuts it.
     */
    @Test
    void longNamesCostNothingAndAreCut() {
        String longId = "x".repeat(5000);
        // A chain of 29 long-id components, then 20,000 long-id siblings at level 30: a location built per child would
        // hold 29 ids (about 145 KB) for each of them. Allocation is counted, not time, so a slow runner cannot fail
        // a linear walk and a constant-factor regression cannot hide under a wall-clock bound.
        ObjectNode root = component("root", "form");
        ObjectNode tail = root;
        for (int level = 2; level <= 29; level++) {
            ObjectNode next = component(longId, "group");
            ObjectNode slot = F.objectNode();
            slot.set("content", F.arrayNode().add(next));
            tail.set("children", slot);
            tail = next;
        }
        ArrayNode many = F.arrayNode();
        for (int i = 0; i < 20_000; i++) {
            many.add(component(longId, "text"));
        }
        ObjectNode children = F.objectNode();
        children.set("content", many);
        tail.set("children", children);
        ObjectNode definition = F.objectNode();
        definition.set("root", root);
        com.sun.management.ThreadMXBean threads = (com.sun.management.ThreadMXBean) java.lang.management.ManagementFactory.getThreadMXBean();
        assumeTrue(threads.isThreadAllocatedMemorySupported(), "This JVM does not count thread allocation.");
        long thread = Thread.currentThread().getId();
        long before = threads.getThreadAllocatedBytes(thread);
        assertThat(DefinitionDepth.tooDeep(definition)).isEmpty();
        long allocated = threads.getThreadAllocatedBytes(thread) - before;
        // Frames and deque slots only: well under 20 MB; the per-child location would be about 3 GB.
        assertThat(allocated).as("bytes allocated by the walk").isLessThan(20L * 1024 * 1024);

        ObjectNode deep = nested(33);
        ObjectNode g = (ObjectNode) deep.get("root").get("children").get("content").get(0);
        g.put("id", longId);
        ObjectNode slots = (ObjectNode) g.get("children");
        slots.set("s".repeat(40), slots.get("content"));
        slots.remove("content");
        String where = DefinitionDepth.tooDeep(deep).orElseThrow();
        assertThat(where).startsWith("root > content > #0 > ? > g2").doesNotContain(longId);
    }

    /** The raw depth: the innermost value counts, so depth 256 holds at most 255 containers (BLD-06 refuses 257). */
    @Test
    void rawDepthCountsTheInnermostValue() {
        assertThat(DefinitionDepth.jsonDepth(F.numberNode(1))).isEqualTo(1);
        assertThat(DefinitionDepth.jsonDepth(F.arrayNode())).isEqualTo(2);
        assertThat(DefinitionDepth.jsonDepth(F.arrayNode().add(1))).isEqualTo(2);
        assertThat(DefinitionDepth.jsonDepth(F.arrayNode().add(F.arrayNode()))).isEqualTo(3);
        assertThat(DefinitionDepth.jsonDepth(arrays(255))).isEqualTo(256);
        DefinitionDepth.assertRawDepth(arrays(255), "definition");
        assertThatThrownBy(() -> DefinitionDepth.assertRawDepth(arrays(256), "definition"))
            .isInstanceOfSatisfying(DefinitionTooDeepException.class, e -> assertThat(e.limit()).isEqualTo(256));
        ObjectNode definition = nested(3);
        ((ObjectNode) definition.get("root").get("configuration")).set("deep", arrays(254));
        assertThatThrownBy(() -> DefinitionDepth.assertShallow(definition)).isInstanceOf(DefinitionTooDeepException.class);
    }

    private static ArrayNode arrays(int count) {
        ArrayNode inner = F.arrayNode();
        for (int i = 1; i < count; i++) {
            inner = F.arrayNode().add(inner);
        }
        return inner;
    }
}
