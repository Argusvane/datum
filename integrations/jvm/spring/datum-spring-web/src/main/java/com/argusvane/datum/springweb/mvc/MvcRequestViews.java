package com.argusvane.datum.springweb.mvc;

import jakarta.servlet.http.HttpServletRequest;
import java.security.Principal;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The one rule per web stack for what a Datum request view carries from a servlet request:
 * the headers as a map in the order sent, the remote address as the container reports it (behind a proxy that is the
 * address Spring's forwarded-header handling left, never a header Datum reads itself), and the authenticated principal.
 * Each capability's request record (submissions', passkeys') is built from these, so the PDF, submissions and passkey
 * endpoints cannot disagree about who the caller is.
 */
public final class MvcRequestViews {

    private MvcRequestViews() {
    }

    /** Every request header with all its values, in the order the container lists them. */
    public static Map<String, List<String>> headers(HttpServletRequest request) {
        Map<String, List<String>> headers = new LinkedHashMap<>();
        for (String name : Collections.list(request.getHeaderNames())) {
            headers.put(name, new ArrayList<>(Collections.list(request.getHeaders(name))));
        }
        return headers;
    }

    /** The client address as the servlet container reports it, or null. */
    public static String remoteAddress(HttpServletRequest request) {
        return request.getRemoteAddr();
    }

    /** The authenticated principal, or null when anonymous. */
    public static Principal principal(HttpServletRequest request) {
        return request.getUserPrincipal();
    }
}
