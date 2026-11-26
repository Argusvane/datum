package com.argusvane.datum.forms;

import com.argusvane.datum.core.canonical.CanonicalJson;
import java.io.IOException;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.TreeMap;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.databind.node.ObjectNode;

/**
 * Definitions read from resources ({@code datum.forms.locations}, for example
 * {@code classpath:/datum/forms/*.json}): the story-one repository, where the form was drawn in the builder
 * and committed beside the application.
 *
 * <p>Framework-free: the locations resolve through a {@link FormSources.Resolver} the host binding supplies (on
 * Spring, its own resource pattern resolver, for {@code classpath:} and {@code file:} alike; framework-
 * first), the key rule is {@link FormKeys} and a file is read by {@link FormSources#read}. The repository serves
 * the form by key only: a list of forms is the application's own query, not a Datum route.
 *
 * <p>A form's key is its file name without {@code .json}, unless the definition's {@code id} differs: then
 * the id, which is what a submission and the browser element name. Two resources that land on one key are a
 * configuration error and the repository refuses to start (a silent winner would serve the wrong schema).
 * Everything is read once, at construction, so a malformed file fails the start rather than the first
 * request; restart to pick up a changed file. {@link #save} always answers 501.
 */
public final class ResourceFormDefinitionRepository implements FormDefinitionRepository {

    private static final Logger LOG = LoggerFactory.getLogger(ResourceFormDefinitionRepository.class);

    private record Entry(ObjectNode definition, String sha256) {
    }

    private final Map<String, Entry> forms;

    /**
     * @param resolver resolves the location patterns ({@link FormSources#resolver} over the host's class path)
     * @param locations resource patterns; empty or unmatched patterns simply find nothing
     * @throws IllegalStateException on an unreadable or non-object file, or on two forms with one key
     */
    public ResourceFormDefinitionRepository(FormSources.Resolver resolver, List<String> locations) {
        Map<String, Entry> loaded = new TreeMap<>();
        Map<String, String> origin = new TreeMap<>();
        for (String location : locations) {
            List<FormSources.Source> found;
            try {
                found = resolver.resolve(location);
            } catch (IOException e) {
                // A pattern whose base directory does not exist (classpath:/datum/forms/*.json in an app with
                // no forms yet) is "nothing found", not a failure, but the operator is told.
                LOG.warn("The Datum form location \"{}\" could not be read ({}); no forms were loaded from it.", location, e.toString());
                continue;
            }
            if (found.isEmpty()) {
                LOG.warn("The Datum form location \"{}\" matched no resources; check datum.forms.locations.", location);
            }
            for (FormSources.Source source : found) {
                String name = source.fileName();
                String fromFile = name.endsWith(".json") ? name.substring(0, name.length() - ".json".length()) : name;
                String where = source.where();
                ObjectNode definition = read(source);
                String id = definition.path("id").isString() ? definition.path("id").stringValue() : "";
                String key = FormKeys.validate(id.isEmpty() ? fromFile : id, where);
                String earlier = origin.putIfAbsent(key, where);
                if (earlier != null) {
                    if (earlier.equals(where)) {
                        continue;
                    }
                    throw new IllegalStateException("Two form definitions have the key \"" + key + "\": " + earlier + " and " + where
                        + ". Rename one file or change its id.");
                }
                loaded.put(key, new Entry(definition, CanonicalJson.digest(definition)));
            }
        }
        this.forms = Collections.unmodifiableMap(loaded);
    }

    @Override
    public Optional<ObjectNode> find(String key) {
        Entry entry = key == null ? null : forms.get(key);
        return entry == null ? Optional.empty() : Optional.of(entry.definition().deepCopy());
    }

    @Override
    public CurrentDefinition current(String key) {
        Entry entry = key == null ? null : forms.get(key);
        if (entry == null) {
            throw new FormNotFoundException(String.valueOf(key));
        }
        return new CurrentDefinition(entry.definition().deepCopy(), entry.sha256());
    }

    @Override
    public SavedForm save(ObjectNode definition) {
        throw new FormStoreReadOnlyException();
    }

    @Override
    public SavedForm save(ObjectNode definition, String expectedSha256) {
        throw new FormStoreReadOnlyException();
    }

    /** The number of forms found, for the startup log. */
    public int size() {
        return forms.size();
    }

    private static ObjectNode read(FormSources.Source source) {
        byte[] bytes;
        try {
            bytes = source.bytes().read();
        } catch (IOException e) {
            throw new IllegalStateException("The form definition " + source.where() + " cannot be read as JSON: " + e.getMessage(), e);
        }
        return FormSources.read(source.where(), bytes);
    }
}
