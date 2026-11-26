package com.argusvane.datum.webauthn;

/**
 * A valid signature's use could not be recorded: another request
 * claimed its digest first ({@code replay}), its passkey was revoked meanwhile ({@code revoked}), or its counter
 * moved past this signature's ({@code counter}). The caller does not store the submission.
 */
public class SignatureReplayException extends RuntimeException {

    private static final long serialVersionUID = 1L;

    private final String reason;

    public SignatureReplayException(String reason) {
        super("The passkey signature's use could not be recorded: " + reason + ".");
        this.reason = reason;
    }

    /** replay, revoked or counter (a {@link SubmissionSignatureVerifier#REASONS} code). */
    public String reason() {
        return reason;
    }
}
