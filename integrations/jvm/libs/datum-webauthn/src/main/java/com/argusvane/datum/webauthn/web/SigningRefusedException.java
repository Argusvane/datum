package com.argusvane.datum.webauthn.web;

import com.argusvane.datum.core.DatumException;
import com.argusvane.datum.web.error.ErrorDetails;
import com.argusvane.datum.web.error.ErrorItem;
import java.util.List;

/**
 * A passkey endpoint's own refusal, with the endpoint catalog's code and words ({@code signing.off} 404,
 * {@code signing.not_set_up} 503, {@code signing.sign_in}, {@code signing.context} and {@code signing.register_off}
 * 403, {@code passkey.notFound} 404, {@code passkey.revoked} 409, {@code passkey.check} and {@code passkey.counter}
 * 422). It carries its message as an error item, so the error mapper keeps the words of a 503 too (the mapper
 * words a 5xx {@code DatumException} by its own table only).
 */
public class SigningRefusedException extends DatumException implements ErrorDetails {

    private static final long serialVersionUID = 1L;

    public SigningRefusedException(String code, int status, String message) {
        super(code, status, message);
    }

    @Override
    public List<ErrorItem> errorItems() {
        return List.of(ErrorItem.of(code(), getMessage()));
    }
}
