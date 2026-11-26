package com.argusvane.datum.examples.builderjpa;

import com.argusvane.datum.core.contracts.DatumJson;
import com.argusvane.datum.forms.CurrentDefinition;
import com.argusvane.datum.forms.DefinitionService;
import com.argusvane.datum.forms.FormDefinitionRepository;
import com.argusvane.datum.forms.FormNotFoundException;
import com.argusvane.datum.forms.FormOutdatedException;
import com.argusvane.datum.forms.SavedForm;
import java.time.Clock;
import java.util.Optional;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.orm.ObjectOptimisticLockingFailureException;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionOperations;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * The forms of this application, in the database: what {@code datum-forms} reads (the definition endpoint, the
 * submissions receiver, the form list) and what the builder's save writes. Being a bean of this type replaces the
 * read-only resource repository; nothing else is configured.
 *
 * <p>The packages have checked a definition before {@link #save} is called (the kernel's verdict, the If-Match
 * hash under the form's lock); this class stores it, and refuses it across instances when the hash it builds on is
 * no longer the stored one ({@link #save(ObjectNode, String)}). The hash it keeps is {@link DefinitionService#hash}, so
 * {@link #current} answers the same ETag the packages compute.
 */
public class JpaFormDefinitionRepository implements FormDefinitionRepository {

    private final FormEntities forms;
    private final Clock clock;
    private final TransactionOperations transactions;

    /**
     * @param transactions Spring Boot's {@code TransactionTemplate} bean (a {@code TransactionOperations}), so
     *     {@code spring.transaction.*} applies; the conditional save needs a programmatic boundary because the optimistic
     *     lock fails at commit, after a method-level {@code @Transactional} would already have returned
     */
    public JpaFormDefinitionRepository(FormEntities forms, Clock clock, TransactionOperations transactions) {
        this.forms = forms;
        this.clock = clock;
        this.transactions = transactions;
    }

    @Override
    @Transactional(readOnly = true)
    public Optional<ObjectNode> find(String key) {
        return forms.findById(key).map(JpaFormDefinitionRepository::definitionOf);
    }

    @Override
    @Transactional(readOnly = true)
    public CurrentDefinition current(String key) {
        FormEntity form = forms.findById(key).orElseThrow(() -> new FormNotFoundException(key));
        return new CurrentDefinition(definitionOf(form), form.getSha256());
    }

    @Override
    @Transactional
    public SavedForm save(ObjectNode definition) {
        return write(definition, null, false);
    }

    /**
     * The conditional save: the stored hash must still be {@code expectedSha256} (null: the form must not exist),
     * else {@link FormOutdatedException}. The row's {@code @Version} makes the check hold across instances: a
     * concurrent writer that got in between the read and the commit fails the commit, answered the same way.
     */
    @Override
    public SavedForm save(ObjectNode definition, String expectedSha256) {
        try {
            return transactions.execute(status -> write(definition, expectedSha256, true));
        } catch (ObjectOptimisticLockingFailureException | DataIntegrityViolationException raced) {
            throw new FormOutdatedException(forms.findById(definition.get("id").asString()).map(FormEntity::getSha256).orElse(""));
        }
    }

    private SavedForm write(ObjectNode definition, String expectedSha256, boolean conditional) {
        String key = definition.get("id").asString();
        String sha256 = DefinitionService.hash(definition);
        FormEntity existing = forms.findById(key).orElse(null);
        if (conditional && (existing == null ? expectedSha256 != null : !existing.getSha256().equals(expectedSha256))) {
            throw new FormOutdatedException(existing == null ? "" : existing.getSha256());
        }
        FormEntity form = existing != null ? existing : new FormEntity(key);
        form.update(DatumJson.mapper().writeValueAsString(definition), sha256, titleOf(definition), clock.instant());
        forms.save(form);
        return new SavedForm(key, sha256);
    }

    private static ObjectNode definitionOf(FormEntity form) {
        return (ObjectNode) DatumJson.mapper().readTree(form.getJson());
    }

    /** The root's title or label, a plain string or a LocalizedText's default. */
    static String titleOf(JsonNode definition) {
        JsonNode configuration = definition.path("root").path("configuration");
        JsonNode title = configuration.has("title") ? configuration.get("title") : configuration.path("label");
        String text = title.isString() ? title.asString() : title.path("default").isString() ? title.path("default").asString() : null;
        return text == null ? null : text.length() > 255 ? text.substring(0, 255) : text;
    }
}
