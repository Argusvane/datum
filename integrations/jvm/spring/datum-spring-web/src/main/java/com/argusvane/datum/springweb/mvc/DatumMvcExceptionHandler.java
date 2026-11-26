package com.argusvane.datum.springweb.mvc;

import com.argusvane.datum.web.error.ErrorMapper;
import com.argusvane.datum.web.error.ErrorResponse;
import com.argusvane.datum.web.json.DatumJsonMapper;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

/**
 * Answers every exception of a {@link DatumController} through {@link ErrorMapper}.
 *
 * <p>Limited to controllers carrying the marker annotation, so the application's own controllers and its own
 * {@code @ControllerAdvice} are never touched. The body is written as bytes with the Datum mapper and an
 * explicit content type, so the application's message converters and {@code Accept} negotiation cannot turn an
 * error into something else.
 */
@RestControllerAdvice(annotations = DatumController.class)
@Order(Ordered.HIGHEST_PRECEDENCE + 10)
public class DatumMvcExceptionHandler {

    private final ErrorMapper errors;
    private final DatumJsonMapper json;

    public DatumMvcExceptionHandler(ErrorMapper errors, DatumJsonMapper json) {
        this.errors = errors;
        this.json = json;
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<byte[]> handle(Exception failure) {
        return entity(errors.map(failure), json);
    }

    /** An {@link ErrorResponse} as a response entity (also for controllers that map an error themselves). */
    public static ResponseEntity<byte[]> entity(ErrorResponse response, DatumJsonMapper json) {
        ResponseEntity.BodyBuilder builder = ResponseEntity.status(response.status());
        response.headers().forEach(builder::header);
        return builder.contentType(MediaType.parseMediaType(response.contentType()))
            .body(response.bodyBytes(json.mapper()));
    }
}
