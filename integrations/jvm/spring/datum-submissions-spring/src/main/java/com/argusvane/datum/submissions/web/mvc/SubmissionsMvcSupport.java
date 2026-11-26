package com.argusvane.datum.submissions.web.mvc;

import com.argusvane.datum.submissions.spi.SubmissionRequest;
import com.argusvane.datum.submissions.web.SubmissionsApi;
import com.argusvane.datum.submissions.web.SubmissionsReply;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;

/** The servlet side of the shared endpoints: the request view in, the neutral reply out. */
final class SubmissionsMvcSupport {

    private SubmissionsMvcSupport() {
    }

    static SubmissionRequest view(HttpServletRequest request) {
        return SubmissionRequestResolver.view(request);
    }

    static ResponseEntity<byte[]> entity(SubmissionsReply reply) {
        ResponseEntity.BodyBuilder builder = ResponseEntity.status(reply.status());
        reply.headers().forEach(builder::header);
        return builder.contentType(MediaType.parseMediaType(SubmissionsApi.contentType())).body(reply.body());
    }
}
