package com.argusvane.datum.springweb.support;

import com.argusvane.datum.core.DefinitionTooDeepException;
import com.argusvane.datum.core.ProgramUnavailableException;
import com.argusvane.datum.core.RequestTooLargeException;
import com.argusvane.datum.sandbox.protocol.SandboxException.Reason;
import com.argusvane.datum.sandbox.protocol.SandboxException;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

/** One exception per kind name, shared by both stacks' test routes. */
public final class Failures {

    private Failures() {
    }

    public static RuntimeException of(String kind) {
        return switch (kind) {
            case "tooLarge" -> new RequestTooLargeException(10, "The request body is larger than 10 bytes.");
            case "unavailable" -> new ProgramUnavailableException("internal runtime detail: /app/secret");
            case "tooDeep" -> new DefinitionTooDeepException(32, "The definition nests deeper than 32 levels.");
            case "busy" -> new SandboxException(Reason.BUSY, "all slots taken");
            case "interrupted" -> new SandboxException(Reason.INTERRUPTED, "cancelled");
            case "budget" -> new SandboxException(Reason.BUDGET, "ran too long", "SECRET GUEST STDERR");
            case "outcomeTooLarge" -> new SandboxException(Reason.OUTCOME_TOO_LARGE, "outcome");
            case "tooCostly" -> SandboxException.checkTooCostly(new SandboxException(Reason.BUDGET, "ran too long", "SECRET"));
            case "rejected" -> new RejectedException();
            case "notFound" -> new ResponseStatusException(HttpStatus.NOT_FOUND);
            case "unknown" -> new IllegalStateException("secret detail the client must not see");
            default -> new IllegalArgumentException(kind);
        };
    }
}
