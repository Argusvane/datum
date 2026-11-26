package com.argusvane.datum.ui.builder;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.core.contracts.DatumJson;
import com.argusvane.datum.sandbox.protocol.DefinitionDepth;
import java.nio.charset.StandardCharsets;
import java.util.List;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

/** The builder's own shape reading before the kernel: codes, order, sentences and caps (BLD-03, BLD-06, DEF-05, DEF-06). */
class DefinitionShapeTest {

    static JsonNode json(String text) {
        return DatumJson.mapper().readTree(text);
    }

    static List<String> codes(JsonNode definition) {
        return DefinitionShape.problemList(definition).stream().map(DefinitionShape.Finding::code).toList();
    }

    @Test
    void theSuiteFixtureIsSound() {
        assertThat(DefinitionShape.problemList(BuilderFixtures.base())).isEmpty();
    }

    @Test
    void notAnObjectIsNotARecord() {
        assertThat(codes(json("[]"))).containsExactly("definition.notRecord");
        assertThat(codes(json("\"x\""))).containsExactly("definition.notRecord");
    }

    @Test
    void identityProblemsComeFirstInTheirOrder() {
        assertThat(codes(json("{\"id\":\" \",\"version\":1,\"root\":{\"id\":\"root\",\"type\":\"form\"}}")))
            .containsExactly("definition.id.invalid", "definition.version.invalid", "definition.schemaVersion.invalid");
        assertThat(codes(json("{\"id\":\"a\",\"version\":\"" + "v".repeat(65) + "\",\"schemaVersion\":\"1\",\"root\":{\"id\":\"r\",\"type\":\"form\"}}")))
            .containsExactly("definition.version.tooLong");
        assertThat(codes(json("{\"id\":\"a\",\"version\":\"1\",\"schemaVersion\":\"1\"}"))).containsExactly("definition.root.missing");
        // Blank as Java reads it (String.isBlank: tab, vertical tab, line ends), not a no-break space.
        assertThat(codes(json("{\"id\":\" \\t\\u000b\",\"version\":\"\\u00a0\",\"schemaVersion\":\"1\",\"root\":{\"id\":\"r\",\"type\":\"form\"}}")))
            .containsExactly("definition.id.invalid");
    }

    @Test
    void componentsWithoutIdOrTypeAreNamedByWhereTheyAre() {
        List<DefinitionShape.Finding> found = DefinitionShape.problemList(json("{\"id\":\"a\",\"version\":\"1\",\"schemaVersion\":\"1\","
            + "\"root\":{\"id\":\"root\",\"type\":\"form\",\"children\":{\"content\":[{\"type\":\"text\"},{\"id\":\"b\",\"children\":{\"x\":[{\"id\":\"c\",\"type\":\"\"}]}}]}}}"));
        assertThat(found).extracting(DefinitionShape.Finding::code)
            .containsExactly("component.id.invalid", "component.type.invalid", "component.type.invalid");
        assertThat(found).extracting(DefinitionShape.Finding::where)
            .containsExactly("root > content > #0", "root > content > b", "root > content > b > x > c");
        assertThat(found.get(0).message()).isEqualTo("A component at root > content > #0 has no id.");
    }

    @Test
    void tooDeepIsFoundAndTheSizeCapsAreThenNotCounted() {
        ObjectNode definition = BuilderFixtures.base();
        ObjectNode node = (ObjectNode) definition.get("root");
        for (int level = 0; level < 33; level++) {
            ObjectNode child = node.putObject("children").putArray("content").addObject();
            child.put("id", "n" + level);
            child.put("type", "container");
            node = child;
        }
        List<DefinitionShape.Finding> found = DefinitionShape.problemList(definition);
        assertThat(found).extracting(DefinitionShape.Finding::code).containsExactly("definition.tooDeep");
        assertThat(found.get(0).limit()).isEqualTo(32);
        assertThat(found.get(0).message()).startsWith("Components nest more than 32 levels deep (at root > content > n0");
        assertThat(found.get(0).where()).as("the same location as datum-core's guard").isEqualTo(DefinitionDepth.tooDeep(definition).orElseThrow());
    }

    // ------------------------------------------------------------------ cost

    /**
     * The body: one component with a {@code idLength}-character id holding {@code children} empty
     * objects (no id, no type), inside the suite's identity.
     */
    static byte[] hostileBody(int idLength, int children) {
        StringBuilder out = new StringBuilder(idLength + children * 3 + 200);
        out.append("{\"id\":\"").append(BuilderFixtures.KEY).append("\",\"version\":\"1\",\"schemaVersion\":\"1\",")
            .append("\"root\":{\"id\":\"root\",\"type\":\"form\",\"children\":{\"content\":[{\"id\":\"")
            .append("a".repeat(idLength)).append("\",\"type\":\"group\",\"children\":{\"content\":[");
        for (int i = 0; i < children; i++) {
            out.append(i == 0 ? "{}" : ",{}");
        }
        out.append("]}}]}}}");
        return out.toString().getBytes(StandardCharsets.UTF_8);
    }

    /** A definition whose one group holds {@code children} sound components, the group's id and slot name as given. */
    static ObjectNode wide(String groupId, String slot, int children) {
        ObjectNode definition = BuilderFixtures.base();
        ObjectNode group = BuilderFixtures.content(definition).addObject().put("id", groupId).put("type", "group");
        ArrayNode list = group.putObject("children").putArray(slot);
        for (int i = 0; i < children; i++) {
            list.addObject().put("id", "c" + i).put("type", "text");
        }
        return definition;
    }

    @Test
    void aHostileBodyIsReadInLinearTimeWithABoundedList() {
        JsonNode definition = DatumJson.mapper().readTree(hostileBody(500_000, 160_000));
        long started = System.nanoTime();
        List<DefinitionShape.Finding> found = DefinitionShape.problemList(definition);
        assertThat(System.nanoTime() - started).isLessThan(5_000_000_000L);
        assertThat(found).hasSizeLessThanOrEqualTo(DefinitionShape.MAX_PROBLEMS + 3);
        assertThat(found).extracting(DefinitionShape.Finding::code)
            .contains("component.id.invalid", "component.type.invalid", "definition.problemsTruncated", "definition.tooManyComponents");
        assertThat(found.get(0).where()).isEqualTo("root > content > " + "a".repeat(DefinitionShape.LABEL_MAX) + " > content > #0");
        assertThat(found).allSatisfy(finding -> assertThat(finding.message().length()).isLessThan(1000));
    }

    @Test
    void eachListStopsAtTheKernelsProblemCap() {
        ObjectNode definition = BuilderFixtures.base();
        for (int i = 0; i < 300; i++) {
            BuilderFixtures.content(definition).addObject().put("type", "text");
        }
        List<DefinitionShape.Finding> found = DefinitionShape.problemList(definition);
        assertThat(found).hasSize(DefinitionShape.MAX_PROBLEMS + 1);
        DefinitionShape.Finding last = found.get(DefinitionShape.MAX_PROBLEMS);
        assertThat(last.code()).isEqualTo("definition.problemsTruncated");
        assertThat(last.limit()).isEqualTo(DefinitionShape.MAX_PROBLEMS);
        assertThat(last.message()).isEqualTo("More problems were found than are listed.");
    }

    /** The host has no {@code definition.names.tooLong} rule: long names are no finding. */
    @Test
    void longIdsOrSlotNamesOverManyComponentsAreNotAFindingAndCostNothing() {
        long started = System.nanoTime();
        for (ObjectNode definition : List.of(wide("g".repeat(2000), "content", 9_000), wide("g", "s".repeat(2000), 9_000))) {
            assertThat(DefinitionShape.problemList(definition)).isEmpty();
            assertThat(DefinitionDepth.tooDeep(definition)).isEmpty();
        }
        assertThat(System.nanoTime() - started).isLessThan(5_000_000_000L);
    }

    @Test
    void optionCapsAreTheKernels() {
        ObjectNode definition = BuilderFixtures.base();
        ObjectNode select = BuilderFixtures.content(definition).addObject();
        select.put("id", "many");
        select.put("type", "select");
        ArrayNode options = select.putObject("configuration").putArray("options");
        for (int i = 0; i <= DefinitionShape.MAX_OPTIONS_PER_COMPONENT; i++) {
            options.addObject().put("value", "v" + i).put("label", "L");
        }
        List<DefinitionShape.Finding> found = DefinitionShape.problemList(definition);
        assertThat(found).extracting(DefinitionShape.Finding::code).containsExactly("option.tooMany");
        assertThat(found.get(0).where()).isEqualTo("root > content > many");
        assertThat(found.get(0).message()).isEqualTo("The component at root > content > many has more than 2000 inline options: put long lists in a data source.");
    }

    @Test
    void aPdfLayoutIdMustBeAnAddress() {
        ObjectNode definition = BuilderFixtures.base();
        definition.putObject("pdf").putArray("layouts").addObject().put("id", "a b");
        assertThat(codes(definition)).containsExactly("pdf.layout.invalid");
    }

    @Test
    void aKernelCodeWithoutASentenceOfItsOwnReadsAsTheKernelsMessageAndWhere() {
        assertThat(DefinitionShape.describe("component.id.duplicate", "root > content > a", null, "Another component already has this id."))
            .isEqualTo("Another component already has this id. (at root > content > a)");
        assertThat(DefinitionShape.describe("future.code", "", null, null)).isEqualTo("future.code");
    }

    @Test
    void typesSkipJourneyReferencesAndUnknownTypesAreTheRest() {
        ObjectNode definition = BuilderFixtures.base();
        ObjectNode page = (ObjectNode) definition.get("journey").get("journeys").get(0).get("pages").get(0);
        ((ArrayNode) page.get("components")).addObject().put("type", "journey-field");
        ((ArrayNode) page.get("components")).addObject().put("id", "own").put("type", "own-type");
        assertThat(DefinitionShape.types(definition)).contains("own-type", "group", "form").doesNotContain("journey-field");
        assertThat(DefinitionShape.unknownTypes(definition, BuilderApiTest.TYPES)).containsExactly("group", "own-type");
    }

    @Test
    void nonFiniteNumbersAreFound() {
        assertThat(DefinitionShape.hasNonFiniteNumber(json("{\"a\":[1,{\"b\":1e999}]}"))).isTrue();
        assertThat(DefinitionShape.hasNonFiniteNumber(json("{\"a\":-1e999}"))).isTrue();
        assertThat(DefinitionShape.hasNonFiniteNumber(json("{\"a\":1" + "0".repeat(400) + "}"))).as("an integer past the double range").isTrue();
        assertThat(DefinitionShape.hasNonFiniteNumber(BuilderFixtures.base())).isFalse();
    }
}
