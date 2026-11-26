/**
 * The Datum host test kit (integrations/jvm/README.md "Libraries and bindings"): the wire
 * contract of every Datum endpoint as JUnit 5 test interfaces over a {@link com.argusvane.datum.tck.HostTarget}
 * (a base URL and what the host was configured with). A host binding's tests implement the interfaces of the
 * capabilities it serves; {@link com.argusvane.datum.tck.HostTck} runs the same interfaces against a
 * deployed application. The kit speaks HTTP only and depends on no Datum library, so a binding is judged by its answers.
 */
package com.argusvane.datum.tck;
