package com.argusvane.datum.sandbox.protocol;

import com.argusvane.datum.core.contracts.ErrorsBody;
import com.argusvane.datum.core.contracts.FieldError;
import com.argusvane.datum.core.contracts.ValidationError;
import java.util.ArrayList;
import java.util.List;
import org.jspecify.annotations.Nullable;
import tools.jackson.databind.JsonNode;

/**
 * How a service answer goes on the wire: {@code statusOf} and {@code errorsBody} of
 * {@code packages/submissions/src/http-mapping.ts}, with the same table, so every Datum server answers the
 * same refusal with the same status.
 */
public final class VerdictMapper {

    private VerdictMapper() {
    }

    /** The HTTP status a service refusal's code maps to; 500 for a code the table does not name. A failed run is a 503. */
    public static int statusOf(@Nullable String code) {
        if (code == null) {
            return 500;
        }
        return switch (code) {
            case "unknown_form", "unknown_record" -> 404;
            case "bad_document" -> 400;
            case "payload_too_large" -> 413;
            case "version_superseded", "submission.keyConflict" -> 409;
            case "not_extractable", "invalid_definition" -> 422;
            // A run that gave no verdict (RUN_FAILED_CODES in types.ts) is the server's failure, never a 422 about the answers.
            case "wasm.execution_error", "outcome_too_large", "definition.tooDeep" -> 503;
            case "pdf_unavailable", "keys_unavailable", "validator_unavailable", "server.unavailable" -> 503;
            default -> 500;
        };
    }

    /**
     * A 422's body from a rejected record's errors: codes and fields, never text, as every server sample
     * answers. {@code field} is the error's {@code componentId}, null when it has none.
     */
    public static ErrorsBody errorsBody(List<ValidationError> errors) {
        List<FieldError> body = new ArrayList<>();
        for (ValidationError error : errors) {
            body.add(new FieldError(error.componentId(), error.code()));
        }
        return new ErrorsBody(body);
    }

    /** {@link #errorsBody(List)} over an outcome's raw {@code errors} list. */
    public static ErrorsBody errorsBody(@Nullable JsonNode errors) {
        List<FieldError> body = new ArrayList<>();
        if (errors != null && errors.isArray()) {
            for (JsonNode error : errors.values()) {
                JsonNode componentId = error.get("componentId");
                JsonNode code = error.get("code");
                body.add(new FieldError(componentId != null && componentId.isString() ? componentId.stringValue() : null,
                    code != null && code.isString() ? code.stringValue() : null));
            }
        }
        return new ErrorsBody(body);
    }
}
