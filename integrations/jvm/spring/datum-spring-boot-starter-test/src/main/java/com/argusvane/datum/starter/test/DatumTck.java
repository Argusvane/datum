package com.argusvane.datum.starter.test;

import com.argusvane.datum.tck.HostTarget;
import com.argusvane.datum.tck.TckFixtures;

/**
 * The host test kit (datum-host-tck) against a Spring Boot application started on a port by
 * {@code @SpringBootTest(webEnvironment = RANDOM_PORT)}: a test class implements the kit's contract interfaces
 * ({@code SubmissionsContract}, {@code AssetsContract}, ...), carries
 * and answers {@code target()} with one of these (the kit's {@code HostContract} orders the methods). The same contracts
 * hold every JVM host binding to one wire contract.
 */
public final class DatumTck {

    /**
     * The kit's fixture form as a forms location ({@code datum.forms.locations}): the security suite's endpoint
     * fixture the kit carries in its jar, which the submissions, forms and PDF contracts post to.
     */
    public static final String FIXTURE_FORM_LOCATION = "classpath:/META-INF/datum-tck/fixture-form.json";

    /**
     * The fixture form under a second key ({@code datum-security-suite-b}) as a forms location: the second form route of the
     * per-route binding contract ({@code PdfContract}), installed beside {@link #FIXTURE_FORM_LOCATION}.
     */
    public static final String FIXTURE_FORM_B_LOCATION = "classpath:/META-INF/datum-tck/fixture-form-b.json";

    /**
     * The kit's PDF theme ({@code TckFixtures.PDF_THEME_ID}) as a {@code datum.bindings.pdf-themes.datum-host-check-pdf}
     * value: the PDF theme of the binding {@link #FIXTURE_FORM_B_LOCATION}'s form is routed to in the per-route contract.
     */
    public static final String FIXTURE_PDF_THEME_LOCATION = "classpath:/" + TckFixtures.PDF_THEME;

    /**
     * The kit's host context fixture ({@code datum-host-context}, {@code TckFixtures.HOST_CONTEXT_FORM}) as a forms location,
     * for the {@code HostContextContract}: installed beside the application's own forms in a test deployment that also wires
     * the contract's TEST-ONLY host context provider.
     */
    public static final String HOST_CONTEXT_FORM_LOCATION = "classpath:/" + TckFixtures.HOST_CONTEXT_FORM_RESOURCE;

    /**
     * The kit's stale sandbox program (ABI 0.9.0) as a {@code datum.runtime.programs.sandbox} override: with
     * {@code datum.runtime.fail-fast=false} the application starts, refuses it at the ABI probe ({@code abi_mismatch})
     * and answers every submission 503, which the kit's {@code RuntimeDownContract} checks.
     */
    public static final String STALE_PROGRAM_LOCATION = "classpath:/" + TckFixtures.STALE_PROGRAM;

    private DatumTck() {
    }

    /** The application on {@code http://localhost:<port>} with every default path. */
    public static HostTarget local(int port) {
        return HostTarget.local(port);
    }

    /** As {@link #local(int)}, for further settings ({@code .builderEnabled(true)}, a request decorator). */
    public static HostTarget.Builder localBuilder(int port) {
        return HostTarget.builder("http://localhost:" + port);
    }
}
