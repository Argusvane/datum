package com.argusvane.datum.submissions.web.mvc;

import com.argusvane.datum.springweb.mvc.MvcRequestViews;
import com.argusvane.datum.submissions.spi.SubmissionRequest;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.core.MethodParameter;
import org.springframework.web.bind.support.WebDataBinderFactory;
import org.springframework.web.context.request.NativeWebRequest;
import org.springframework.web.method.support.HandlerMethodArgumentResolver;
import org.springframework.web.method.support.ModelAndViewContainer;

/**
 * The one place a servlet request becomes a {@link SubmissionRequest}: the submissions and PDF
 * controllers call {@link #view}, and an application controller that hands work to {@code PdfApi} or the receiver in
 * process can take a {@code SubmissionRequest} parameter, resolved here once the submissions binding registers it.
 */
public final class SubmissionRequestResolver implements HandlerMethodArgumentResolver {

    @Override
    public boolean supportsParameter(MethodParameter parameter) {
        return SubmissionRequest.class.equals(parameter.getParameterType());
    }

    @Override
    public Object resolveArgument(MethodParameter parameter, ModelAndViewContainer mavContainer, NativeWebRequest webRequest,
                                  WebDataBinderFactory binderFactory) {
        return view(webRequest.getNativeRequest(HttpServletRequest.class));
    }

    /** The request view of a servlet request: content type, headers, remote address, principal. */
    public static SubmissionRequest view(HttpServletRequest request) {
        return new SubmissionRequest(request.getContentType(), MvcRequestViews.headers(request), MvcRequestViews.remoteAddress(request),
            MvcRequestViews.principal(request));
    }
}
