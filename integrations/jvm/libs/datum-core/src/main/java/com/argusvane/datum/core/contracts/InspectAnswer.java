package com.argusvane.datum.core.contracts;

import tools.jackson.core.JsonParser;
import tools.jackson.databind.DeserializationContext;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ValueDeserializer;
import tools.jackson.databind.annotation.JsonDeserialize;

/**
 * The inspect entry point's answer (DefinitionInspectResponse): one of the three ops' answers, or an
 * {@link InspectFailure}. Chosen by the deserializer from {@code ok} and {@code op}.
 */
@JsonDeserialize(using = InspectAnswer.Reader.class)
public sealed interface InspectAnswer permits InspectPublicAnswer, InspectCheckAnswer, InspectInventoryAnswer,
    InspectFailure {

    /** Whether the program answered the op. */
    boolean ok();

    /** Picks the record by {@code ok} and {@code op}. */
    final class Reader extends ValueDeserializer<InspectAnswer> {
        @Override
        public InspectAnswer deserialize(JsonParser p, DeserializationContext ctxt) {
            JsonNode node = ctxt.readTree(p);
            if (!node.path("ok").asBoolean(false)) {
                return ctxt.readTreeAsValue(node, InspectFailure.class);
            }
            return switch (node.path("op").asString("")) {
                case "public" -> ctxt.readTreeAsValue(node, InspectPublicAnswer.class);
                case "check" -> ctxt.readTreeAsValue(node, InspectCheckAnswer.class);
                case "inspect" -> ctxt.readTreeAsValue(node, InspectInventoryAnswer.class);
                default -> (InspectAnswer) ctxt.handleUnexpectedToken(InspectAnswer.class, p);
            };
        }
    }
}
