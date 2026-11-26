package com.argusvane.datum.ui;

import java.io.IOException;
import java.io.InputStream;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * Which files of the assets directory belong to the builder alone (the stack-neutral decision behind
 * {@link BuilderAssetGate}).
 *
 * <p>The asset build writes {@code builder-files.json} ({@code {"files": [...]}}, paths relative to the assets
 * base) beside the bundles. The list is the primary source; two name rules back it up so a file missing from the
 * list (a stale list, a chunk added by a later build) still stays away from visitors: anything named
 * {@code datum-builder*}, the list file itself (it names the builder's chunks) and anything under {@code builder-fonts/}. Comparison is lower-cased, as the asset
 * service lower-cases its guard questions (an exploded classpath on a case-insensitive filesystem resolves a
 * different-case request to the same file).
 */
public final class BuilderFiles {

    /** Where the ui jar carries the list. */
    public static final String RESOURCE = "META-INF/datum/assets/builder-files.json";

    private static final Logger LOG = LoggerFactory.getLogger("datum.ui");

    private final Set<String> listed;

    public BuilderFiles(Set<String> listed) {
        Set<String> folded = new HashSet<>();
        listed.forEach(file -> folded.add(file.toLowerCase(Locale.ROOT)));
        this.listed = Set.copyOf(folded);
    }

    /** Reads the list from {@code loader}; an absent or unreadable list leaves only the name rules (WARN). */
    public static BuilderFiles load(ClassLoader loader, JsonMapper json) {
        Set<String> files = new HashSet<>();
        try (InputStream in = loader.getResourceAsStream(RESOURCE)) {
            if (in == null) {
                LOG.warn("{} is not on the classpath; the builder's files are recognised by name only.", RESOURCE);
            } else {
                JsonNode listed = json.readTree(in).get("files");
                if (listed != null && listed.isArray()) {
                    listed.forEach(file -> files.add(file.asString()));
                }
            }
        } catch (IOException | RuntimeException e) {
            LOG.warn("{} could not be read; the builder's files are recognised by name only.", RESOURCE, e);
        }
        return new BuilderFiles(files);
    }

    /** Whether {@code path} (relative to the assets base) is a builder file. */
    public boolean isBuilderFile(String path) {
        if (path == null) {
            return false;
        }
        String folded = path.toLowerCase(Locale.ROOT);
        return folded.equals("builder-files.json") || listed.contains(folded) || folded.startsWith("datum-builder") || folded.startsWith("builder-fonts/");
    }

    /** How many files the list names. */
    public int size() {
        return listed.size();
    }
}
