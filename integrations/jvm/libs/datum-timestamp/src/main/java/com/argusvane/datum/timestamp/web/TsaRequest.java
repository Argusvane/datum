package com.argusvane.datum.timestamp.web;

import java.util.Collection;
import java.util.List;

/**
 * What the timestamp handler needs of a request, stack-neutral: the servlet and the reactive adapters fill it,
 * {@link TsaEndpoint} decides.
 *
 * @param contentType the Content-Type header, or {@code null}
 * @param authorization the Authorization header, or {@code null}
 * @param cookieNames the names of the cookies the request carries
 * @param remote the client address (the flood limits' identifier; the endpoint counts an IPv6 client by its /64)
 * @param declaredLength the Content-Length, or -1 when not declared
 */
public record TsaRequest(String contentType, String authorization, Collection<String> cookieNames, String remote, long declaredLength) {

    public TsaRequest {
        cookieNames = cookieNames == null ? List.of() : List.copyOf(cookieNames);
        remote = remote == null ? "" : remote;
    }
}
