package com.argusvane.datum.examples.builderjpa;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Lob;
import jakarta.persistence.Table;
import jakarta.persistence.Version;
import java.time.Instant;

/**
 * One form: its key, the definition as JSON text, and the definition's hash. The hash is the canonical SHA-256 the
 * packages name every version by (the ETag a builder sends back as If-Match); it is computed once on save so a read
 * of the current version costs no hashing.
 */
@Entity
@Table(name = "example_form")
public class FormEntity {

    @Id
    @Column(name = "form_key", length = 128)
    private String key;

    @Lob
    @Column(name = "definition_json", nullable = false)
    private String json;

    @Column(name = "sha256", length = 64, nullable = false)
    private String sha256;

    @Column(name = "title", length = 255)
    private String title;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    /** JPA's optimistic lock: two transactions that both loaded one row cannot both write it. */
    @Version
    private long revision;

    protected FormEntity() {
    }

    public FormEntity(String key) {
        this.key = key;
    }

    public String getKey() {
        return key;
    }

    public String getJson() {
        return json;
    }

    public String getSha256() {
        return sha256;
    }

    public String getTitle() {
        return title;
    }

    public Instant getUpdatedAt() {
        return updatedAt;
    }

    void update(String json, String sha256, String title, Instant updatedAt) {
        this.json = json;
        this.sha256 = sha256;
        this.title = title;
        this.updatedAt = updatedAt;
    }
}
