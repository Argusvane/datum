package com.argusvane.datum.tck;

import static org.junit.platform.engine.discovery.DiscoverySelectors.selectClass;

import com.argusvane.datum.tck.run.AssetsRun;
import com.argusvane.datum.tck.run.BuilderRun;
import com.argusvane.datum.tck.run.FloodRun;
import com.argusvane.datum.tck.run.FormsRun;
import com.argusvane.datum.tck.run.HardeningRun;
import com.argusvane.datum.tck.run.HostContextRun;
import com.argusvane.datum.tck.run.PasskeysRun;
import com.argusvane.datum.tck.run.PdfRun;
import com.argusvane.datum.tck.run.RuntimeDownRun;
import com.argusvane.datum.tck.run.SubmissionsDryRunRun;
import com.argusvane.datum.tck.run.SubmissionsRun;
import com.argusvane.datum.tck.run.TsaRun;
import java.io.IOException;
import java.io.InputStream;
import java.io.PrintWriter;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.Set;
import org.junit.platform.launcher.Launcher;
import org.junit.platform.launcher.LauncherDiscoveryRequest;
import org.junit.platform.launcher.core.LauncherDiscoveryRequestBuilder;
import org.junit.platform.launcher.core.LauncherFactory;
import org.junit.platform.launcher.listeners.SummaryGeneratingListener;
import org.junit.platform.launcher.listeners.TestExecutionSummary;

/**
 * Runs the contracts against a deployed host: {@code java -cp <the kit and its dependencies> com.argusvane.datum.tck.HostTck
 * datum.tck.base-url=https://forms.example datum.tck.capabilities=submissions,forms,assets [more key=value ...]} or
 * {@code --config tck.properties}. Exit 0 when every selected contract passed and each asserted something, 1 when one
 * failed, 2 for a usage error (including a named capability whose every test was aborted by a missing key).
 *
 * <p>The keys ({@code datum.tck.} prefix): {@code base-url} (required); {@code capabilities} (comma separated, from
 * {@link Capability}; {@code flood} always runs last); {@code api-path}, {@code assets-path}, {@code tsa-path},
 * {@code webauthn-path}; {@code builder-enabled}, {@code pdf-signing}, {@code pdf-bindings}; {@code signing-form}, {@code build-form};
 * {@code header.<Name>} for every request, {@code person.header.<Name>} and {@code other-person.header.<Name>} for
 * the two signed-in people (a session cookie, a bearer token); {@code csrf=cookie:<cookie>:<header>} for a host that
 * guards its writes with Spring Security's cookie token (the token cookie any earlier reply set is sent back as the
 * header on every write, one token per person, as the Node kit's {@code --csrf}).
 */
public final class HostTck {

    /** The key prefix. */
    public static final String PREFIX = "datum.tck.";

    private static final Map<Capability, Class<?>> RUNS = new LinkedHashMap<>();

    static {
        RUNS.put(Capability.SUBMISSIONS, SubmissionsRun.class);
        RUNS.put(Capability.SUBMISSIONS_TEST, SubmissionsDryRunRun.class);
        RUNS.put(Capability.FORMS, FormsRun.class);
        RUNS.put(Capability.ASSETS, AssetsRun.class);
        // The order is the Node kit's (datum-host-check, packages/conformance-suite): the builder before pdf, tsa, passkeys.
        RUNS.put(Capability.BUILDER, BuilderRun.class);
        RUNS.put(Capability.PDF, PdfRun.class);
        RUNS.put(Capability.TSA, TsaRun.class);
        RUNS.put(Capability.PASSKEYS, PasskeysRun.class);
        RUNS.put(Capability.HARDENING, HardeningRun.class);
        RUNS.put(Capability.RUNTIME_DOWN, RuntimeDownRun.class);
        RUNS.put(Capability.HOST_CONTEXT, HostContextRun.class);
        // Last: it spends the address's request budget.
        RUNS.put(Capability.FLOOD, FloodRun.class);
    }

    private static volatile HostTarget current;

    private HostTck() {
    }

    /** The target the run classes test: the one {@link #run} was given, else the system properties. */
    public static HostTarget target() {
        HostTarget target = current;
        return target != null ? target : target(System.getProperties());
    }

    /** A target from {@code datum.tck.*} properties. */
    public static HostTarget target(Properties properties) {
        String baseUrl = properties.getProperty(PREFIX + "base-url");
        if (baseUrl == null || baseUrl.isBlank()) {
            throw new IllegalArgumentException(PREFIX + "base-url is required");
        }
        HostTarget.Builder builder = HostTarget.builder(baseUrl.strip());
        String value;
        if ((value = properties.getProperty(PREFIX + "api-path")) != null) {
            builder.apiPath(value);
        }
        if ((value = properties.getProperty(PREFIX + "assets-path")) != null) {
            builder.assetsPath(value);
        }
        if ((value = properties.getProperty(PREFIX + "tsa-path")) != null) {
            builder.tsaPath(value);
        }
        if ((value = properties.getProperty(PREFIX + "webauthn-path")) != null) {
            builder.webAuthnPath(value);
        }
        builder.builderEnabled(Boolean.parseBoolean(properties.getProperty(PREFIX + "builder-enabled", "false")));
        builder.pdfSigning(Boolean.parseBoolean(properties.getProperty(PREFIX + "pdf-signing", "false")));
        builder.pdfBindings(Boolean.parseBoolean(properties.getProperty(PREFIX + "pdf-bindings", "false")));
        builder.signingForm(properties.getProperty(PREFIX + "signing-form"));
        builder.buildForm(properties.getProperty(PREFIX + "build-form"));
        builder.capabilities(capabilities(properties.getProperty(PREFIX + "capabilities", "")));
        String csrf = properties.getProperty(PREFIX + "csrf");
        if (csrf != null && !csrf.isBlank()) {
            builder.csrf(HostTarget.Csrf.parse(csrf));
        }
        Map<String, String> person = new LinkedHashMap<>();
        Map<String, String> otherPerson = new LinkedHashMap<>();
        for (String name : properties.stringPropertyNames()) {
            if (name.startsWith(PREFIX + "header.")) {
                builder.header(name.substring((PREFIX + "header.").length()), properties.getProperty(name));
            } else if (name.startsWith(PREFIX + "person.header.")) {
                person.put(name.substring((PREFIX + "person.header.").length()), properties.getProperty(name));
            } else if (name.startsWith(PREFIX + "other-person.header.")) {
                otherPerson.put(name.substring((PREFIX + "other-person.header.").length()), properties.getProperty(name));
            }
        }
        builder.decorator((request, method, who) -> {
            Map<String, String> headers = switch (who) {
                case VISITOR -> Map.of();
                case PERSON -> person;
                case OTHER_PERSON -> otherPerson;
            };
            headers.forEach(request::header);
        });
        return builder.build();
    }

    private static Set<Capability> capabilities(String list) {
        Set<Capability> out = EnumSet.noneOf(Capability.class);
        for (String key : list.split(",")) {
            if (!key.isBlank()) {
                out.add(Capability.of(key));
            }
        }
        return out;
    }

    /**
     * What a run found, per capability in the order they ran. A capability "was exercised" when at least one of its
     * tests succeeded: a contract whose every test was aborted by an assumption (the builder contract without
     * {@code build-form}, the passkeys contract without {@code signing-form}) asserted nothing, and a gate that
     * passed on it would pass on a host that was never tested.
     */
    public record Outcome(Map<Capability, TestExecutionSummary> byCapability) {

        public Outcome {
            byCapability = java.util.Collections.unmodifiableMap(new LinkedHashMap<>(byCapability));
        }

        /** Failed tests over every capability. */
        public long failed() {
            return byCapability.values().stream().mapToLong(TestExecutionSummary::getTotalFailureCount).sum();
        }

        /** Successful tests over every capability. */
        public long succeeded() {
            return byCapability.values().stream().mapToLong(TestExecutionSummary::getTestsSucceededCount).sum();
        }

        /** The named capabilities none of whose tests succeeded (all aborted, or none found). */
        public List<Capability> unexercised() {
            List<Capability> out = new ArrayList<>();
            byCapability.forEach((capability, summary) -> {
                if (summary.getTestsSucceededCount() == 0) {
                    out.add(capability);
                }
            });
            return out;
        }

        /**
         * 0 when nothing failed and every named capability was exercised; 1 when a test failed; 2 when nothing
         * failed but a named capability asserted nothing (a usage error: a key the contract needs is missing).
         */
        public int exitCode() {
            if (failed() > 0) {
                return 1;
            }
            return byCapability.isEmpty() || !unexercised().isEmpty() ? 2 : 0;
        }
    }

    /**
     * Runs the contracts of the target's capabilities; the summaries go to {@code out}. Each capability is its own
     * launcher execution, in the {@link #RUNS} order, so the flood contract (which spends the address's request
     * budget) runs after every other one whatever class orderer the JUnit configuration names. The implicit
     * configuration (system properties, a {@code junit-platform.properties} on the classpath) is not read: a host's
     * CI setting such as a random class or method order cannot change what the kit asserts, and the methods are
     * ordered by {@code @Order} explicitly.
     */
    public static Outcome run(HostTarget target, PrintWriter out) {
        Map<Capability, TestExecutionSummary> summaries = new LinkedHashMap<>();
        current = target;
        try {
            Launcher launcher = LauncherFactory.create();
            RUNS.forEach((capability, run) -> {
                if (!target.capabilities().contains(capability)) {
                    return;
                }
                LauncherDiscoveryRequest request = LauncherDiscoveryRequestBuilder.request()
                    .selectors(selectClass(run))
                    .enableImplicitConfigurationParameters(false)
                    .configurationParameter("junit.jupiter.testmethod.order.default", "org.junit.jupiter.api.MethodOrderer$OrderAnnotation")
                    .build();
                SummaryGeneratingListener listener = new SummaryGeneratingListener();
                launcher.execute(request, listener);
                TestExecutionSummary summary = listener.getSummary();
                summaries.put(capability, summary);
                out.println("== " + capability.key() + ": " + summary.getTestsSucceededCount() + " succeeded, "
                    + summary.getTotalFailureCount() + " failed, " + summary.getTestsAbortedCount() + " aborted");
                summary.printFailuresTo(out, 25);
            });
            Outcome outcome = new Outcome(summaries);
            out.println("== total: " + outcome.succeeded() + " succeeded, " + outcome.failed() + " failed");
            for (Capability capability : outcome.unexercised()) {
                out.println("== " + capability.key() + " asserted nothing: every test was aborted (see the keys its contract needs)");
            }
            out.flush();
            return outcome;
        } finally {
            current = null;
        }
    }

    public static void main(String[] args) throws IOException {
        Properties properties = new Properties();
        properties.putAll(System.getProperties());
        for (int i = 0; i < args.length; i++) {
            String arg = args[i];
            if (arg.equals("--help") || arg.equals("-h")) {
                System.out.println("HostTck datum.tck.base-url=<url> datum.tck.capabilities=<list> [datum.tck.<key>=<value> ...] [--config <file>]");
                System.out.println("Capabilities: " + String.join(", ", RUNS.keySet().stream().map(Capability::key).toList()));
                return;
            } else if (arg.equals("--config") && i + 1 < args.length) {
                try (InputStream in = Files.newInputStream(Path.of(args[++i]))) {
                    properties.load(in);
                }
            } else if (arg.contains("=")) {
                properties.setProperty(arg.substring(0, arg.indexOf('=')), arg.substring(arg.indexOf('=') + 1));
            } else {
                System.err.println("HostTck: not a key=value or --config: " + arg);
                System.exit(2);
            }
        }
        HostTarget target;
        try {
            target = target(properties);
        } catch (IllegalArgumentException e) {
            System.err.println("HostTck: " + e.getMessage());
            System.exit(2);
            return;
        }
        if (target.capabilities().isEmpty()) {
            System.err.println("HostTck: name the host's capabilities with " + PREFIX + "capabilities");
            System.exit(2);
        }
        System.exit(run(target, new PrintWriter(System.out, true)).exitCode());
    }
}
