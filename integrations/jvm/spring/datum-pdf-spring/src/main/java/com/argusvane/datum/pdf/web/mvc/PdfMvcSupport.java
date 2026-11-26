package com.argusvane.datum.pdf.web.mvc;

import com.argusvane.datum.pdf.api.PdfReply;
import com.argusvane.datum.submissions.spi.SubmissionRequest;
import com.argusvane.datum.submissions.web.mvc.SubmissionRequestResolver;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;

/** The servlet side of the shared endpoints: the request view in, the neutral reply out. */
final class PdfMvcSupport {

    private PdfMvcSupport() {
    }

    static SubmissionRequest view(HttpServletRequest request) {
        return SubmissionRequestResolver.view(request);
    }

    /**
     * The reply as bytes with its own content type, so the application's message converters and the request's
     * Accept header cannot turn a PDF into something else.
     */
    static ResponseEntity<byte[]> entity(PdfReply reply) {
        ResponseEntity.BodyBuilder builder = ResponseEntity.status(reply.status());
        reply.headers().forEach(builder::header);
        return builder.contentType(MediaType.parseMediaType(reply.contentType())).body(reply.body());
    }
}
