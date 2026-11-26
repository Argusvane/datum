package com.argusvane.datum.forms.web.mvc;

import com.argusvane.datum.forms.web.FormsApi;
import com.argusvane.datum.forms.web.FormsReply;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;

/** The servlet side of the shared handlers: the neutral reply out. */
final class FormsMvcSupport {

    private FormsMvcSupport() {
    }

    static ResponseEntity<byte[]> entity(FormsReply reply) {
        ResponseEntity.BodyBuilder builder = ResponseEntity.status(reply.status());
        reply.headers().forEach(builder::header);
        if (reply.body() == null) {
            return builder.build();
        }
        return builder.contentType(MediaType.parseMediaType(FormsApi.contentType())).body(reply.body());
    }
}
