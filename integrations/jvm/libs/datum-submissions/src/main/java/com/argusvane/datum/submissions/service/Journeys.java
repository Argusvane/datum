package com.argusvane.datum.submissions.service;

import java.util.ArrayList;
import java.util.List;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * A definition's journeys as the submission service resolves them: the journeys a definition declares, one
 * by id, whether a document must name one, the default, and one page by id. A {@code journeys} member that is an
 * object is read by its values, as a list is.
 */
final class Journeys {

    private Journeys() {
    }

    /** The journeys a definition declares and can use: a string id and a page list, in declared order. */
    static List<ObjectNode> journeys(JsonNode definition) {
        List<ObjectNode> out = new ArrayList<>();
        for (JsonNode journey : declared(definition)) {
            if (journey.isObject() && journey.path("id").isString() && journey.path("pages").isArray()) {
                out.add((ObjectNode) journey);
            }
        }
        return out;
    }

    /** One journey by id, or null when the definition declares none by that id with a page list. */
    static ObjectNode journey(JsonNode definition, String id) {
        for (JsonNode journey : declared(definition)) {
            if (journey.isObject() && journey.path("id").isString() && journey.path("id").stringValue().equals(id)
                && journey.path("pages").isArray()) {
                return (ObjectNode) journey;
            }
        }
        return null;
    }

    /**
     * Whether a document must name the journey it was answered through: the form has journeys and does not
     * open as the whole form ({@code journey.opensAs} "form"). Leaving the journey out must not leave out its
     * exit page.
     */
    static boolean required(JsonNode definition) {
        JsonNode opensAs = definition.path("journey").path("opensAs");
        return !journeys(definition).isEmpty() && !(opensAs.isString() && "form".equals(opensAs.stringValue()));
    }

    /**
     * The journey a document that names none is judged by: the only one, else the one
     * {@code journey.defaultJourneyId} names; null when there are several and no usable default (the browser's
     * own "first journey" fallback is not a rule the server applies).
     */
    static ObjectNode defaultJourney(JsonNode definition) {
        List<ObjectNode> journeys = journeys(definition);
        if (journeys.size() == 1) {
            return journeys.get(0);
        }
        JsonNode named = definition.path("journey").path("defaultJourneyId");
        return named.isString() && !named.stringValue().isEmpty() ? journey(definition, named.stringValue()) : null;
    }

    /** One page of a journey by id, or null (no id names none; the receiver reads an id that is not a string as none). */
    static ObjectNode page(JsonNode journey, String pageId) {
        if (pageId == null) {
            return null;
        }
        JsonNode pages = journey.path("pages");
        if (!pages.isArray()) {
            return null;
        }
        for (JsonNode page : pages) {
            if (page.isObject() && page.path("id").isString() && page.path("id").stringValue().equals(pageId)) {
                return (ObjectNode) page;
            }
        }
        return null;
    }

    private static Iterable<JsonNode> declared(JsonNode definition) {
        JsonNode list = definition.path("journey").path("journeys");
        return list.isContainer() ? list.values() : List.of();
    }
}
