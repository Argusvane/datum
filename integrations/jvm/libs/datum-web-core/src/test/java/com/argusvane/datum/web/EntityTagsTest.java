package com.argusvane.datum.web;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

/** The one reader of entity-tag headers (RFC 9110 section 8.8.3): lists, weak tags, bare tags, the star. */
class EntityTagsTest {

    private static final String HASH = "0123abcd";

    @Test
    void theHashIsQuoted() {
        assertThat(EntityTags.of(HASH)).isEqualTo("\"0123abcd\"");
    }

    @Test
    void aHeaderIsAListOfOpaqueValues() {
        assertThat(EntityTags.parse("\"a\", W/\"b\" ,c,  \"d,e\"")).containsExactly("a", "b", "c", "d,e");
        assertThat(EntityTags.parse("*")).containsExactly("*");
        assertThat(EntityTags.parse(null)).isEmpty();
        assertThat(EntityTags.parse("  ")).isEmpty();
        assertThat(EntityTags.parse("\"\"")).as("an empty tag names nothing").isEmpty();
    }

    @Test
    void ifNoneMatchMatchesAnyListedTagWeakOrBareOrTheStar() {
        assertThat(EntityTags.matchesAny("\"x\", \"" + HASH + "\"", HASH)).isTrue();
        assertThat(EntityTags.matchesAny("W/\"" + HASH + "\"", HASH)).isTrue();
        assertThat(EntityTags.matchesAny(HASH, HASH)).isTrue();
        assertThat(EntityTags.matchesAny("*", HASH)).isTrue();
        assertThat(EntityTags.matchesAny("\"x\", \"y\"", HASH)).isFalse();
        assertThat(EntityTags.matchesAny(null, HASH)).isFalse();
    }

    @Test
    void ifMatchHoldsWithNoHeaderTheStarOrAnyTagThatIsTheCurrentOne() {
        assertThat(EntityTags.preconditionHolds(null, HASH)).isTrue();
        assertThat(EntityTags.preconditionHolds("", HASH)).isTrue();
        assertThat(EntityTags.preconditionHolds("*", HASH)).isTrue();
        assertThat(EntityTags.preconditionHolds("\"" + HASH + "\"", HASH)).isTrue();
        assertThat(EntityTags.preconditionHolds("W/\"" + HASH + "\"", HASH)).isTrue();
        assertThat(EntityTags.preconditionHolds("  " + HASH + "  ", HASH)).isTrue();
        assertThat(EntityTags.preconditionHolds("\"stale\", \"" + HASH + "\"", HASH)).as("a list naming the current tag").isTrue();
        assertThat(EntityTags.preconditionHolds("\"stale\"", HASH)).isFalse();
        assertThat(EntityTags.preconditionHolds("\"stale\", \"other\"", HASH)).isFalse();
    }

    @Test
    void aQuotedStarIsAnOrdinaryTagNotTheWildcard() {
        assertThat(EntityTags.matchesAny("\"*\"", HASH)).isFalse();
        assertThat(EntityTags.preconditionHolds("\"*\"", HASH)).isFalse();
        assertThat(EntityTags.matchesAny("\"*\"", "*")).isTrue();
    }
}
