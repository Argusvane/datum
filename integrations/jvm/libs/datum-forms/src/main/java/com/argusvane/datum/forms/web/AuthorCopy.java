package com.argusvane.datum.forms.web;

/**
 * Whether the definition route serves the author's copy ({@code GET {api}/forms/{key}/definition?public=false}), the
 * stored definition with its server-secret rules.
 *
 * <p>That copy is the builder's read: a host serves it only while the builder is on, so an application that serves the
 * form to fillers and never authors on this host has no request that answers with a server-secret rule, whatever its
 * security chain admits. Off, the request answers as a route the host does not serve: 404 with no body, before any
 * repository is asked, so the answer says nothing about which forms exist. The application's security
 * ({@code DatumRequestMatchers.builderReads()}) still decides who may read it when it is on.
 *
 * <p>On Spring the builder's auto-configuration declares the {@link #SERVED} bean while {@code datum.builder.enabled}
 * is on, and the forms facade reads it; an application that builds its own {@link FormsApi} passes the value itself.
 */
public enum AuthorCopy {

    /** The author's copy is served (the builder is on). */
    SERVED,

    /** The author's copy is not served: {@code public=false} is a 404. */
    WITHHELD;

    /** Whether {@code public=false} is answered with the stored definition. */
    public boolean served() {
        return this == SERVED;
    }
}
