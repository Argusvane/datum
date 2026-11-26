package com.argusvane.datum.core.assets;

import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * Finds every {@code META-INF/datum/manifest.json} on a class loader and refuses when the first-party jars
 * disagree on {@code buildId}.
 *
 * <p>Each asset-carrying module ships an identical manifest (one build id over all of them), so a classpath
 * that holds two ids is a mix of two Datum versions. The first manifest found speaks for the rest.
 */
public final class AssetManifestLoader {

    /** The manifest's location inside every Datum jar. */
    public static final String RESOURCE = "META-INF/datum/manifest.json";

    private static final JsonMapper MAPPER = JsonMapper.builder().build();

    private AssetManifestLoader() {
    }

    /** Loads from the thread context class loader, or this class's own when there is none. */
    public static AssetManifest load() {
        ClassLoader loader = Thread.currentThread().getContextClassLoader();
        return load(loader != null ? loader : AssetManifestLoader.class.getClassLoader());
    }

    /**
     * Reads every manifest {@code loader} can see.
     *
     * @return the agreed manifest, or {@link AssetManifest#absent()} when no jar ships one
     * @throws AssetManifestException when two manifests carry different build ids, or one cannot be read
     */
    public static AssetManifest load(ClassLoader loader) {
        List<URL> urls = new ArrayList<>();
        try {
            loader.getResources(RESOURCE).asIterator().forEachRemaining(urls::add);
        } catch (IOException e) {
            throw new AssetManifestException("The Datum asset manifests could not be listed.", e);
        }
        return merge(urls);
    }

    /** Reads the given manifests and checks them against each other; see {@link #load(ClassLoader)}. */
    public static AssetManifest merge(List<URL> urls) {
        Map<String, byte[]> read = new LinkedHashMap<>();
        for (URL url : urls) {
            try (InputStream in = url.openStream()) {
                read.put(url.toString(), in.readAllBytes());
            } catch (IOException | RuntimeException e) {
                throw new AssetManifestException("The Datum asset manifest " + url + " could not be read.", e);
            }
        }
        return verifyAgreement(read);
    }

    /**
     * Parses manifests already read (name, for messages, to bytes) and checks that they agree on {@code buildId}:
     * the one check a host makes over every asset jar, at start (Spring) or, in a Quarkus binding, at build (its
     * processors would parse no JSON themselves). {@link AssetManifest#verifyAgreement} is the same call.
     *
     * @return the first manifest, which speaks for the rest, or {@link AssetManifest#absent()} for none
     * @throws AssetManifestException when one has no buildId or is not JSON, or two carry different build ids
     */
    public static AssetManifest verifyAgreement(Map<String, byte[]> manifests) {
        Map<String, AssetManifest> read = new LinkedHashMap<>();
        for (Map.Entry<String, byte[]> manifest : manifests.entrySet()) {
            String name = manifest.getKey();
            try {
                JsonNode tree = MAPPER.readTree(manifest.getValue());
                JsonNode id = tree == null ? null : tree.get("buildId");
                if (tree == null || !tree.isObject() || id == null || !id.isString() || id.stringValue().isEmpty()) {
                    throw new AssetManifestException("The Datum asset manifest " + name + " has no buildId.", null);
                }
                read.put(name, MAPPER.treeToValue(tree, AssetManifest.class));
            } catch (RuntimeException e) {
                throw new AssetManifestException("The Datum asset manifest " + name + " could not be read.", e);
            }
        }
        AssetManifest first = null;
        String firstName = null;
        for (Map.Entry<String, AssetManifest> entry : read.entrySet()) {
            if (first == null) {
                first = entry.getValue();
                firstName = entry.getKey();
            } else if (!first.buildId().equals(entry.getValue().buildId())) {
                throw new AssetManifestException("Datum jars disagree on their assets: " + firstName + " is build "
                    + first.buildId() + " but " + entry.getKey() + " is build " + entry.getValue().buildId()
                    + ". Use one Datum version across the application.");
            }
        }
        return first == null ? AssetManifest.absent() : first;
    }
}
