package com.argusvane.datum.examples.builderjpa;

import jakarta.persistence.Column;
import jakarta.persistence.Embeddable;
import jakarta.persistence.EmbeddedId;
import jakarta.persistence.Entity;
import jakarta.persistence.Lob;
import jakarta.persistence.Table;
import java.io.Serializable;
import java.time.Instant;
import java.util.Objects;

/**
 * Every version a form has had, by its hash (as the shared SQL's {@code datum_definition_snapshot} keeps it): a
 * submission names
 * the version it was answered against, and that version must resolve after the form has moved on.
 */
@Entity
@Table(name = "example_form_snapshot")
public class SnapshotEntity {

    /** The form key and the definition hash. A class rather than a record: JPA builds ids through a no-argument constructor. */
    @Embeddable
    public static class Id implements Serializable {

        private static final long serialVersionUID = 1L;

        @Column(name = "form_key", length = 128)
        private String formKey;

        @Column(name = "sha256", length = 64)
        private String sha256;

        protected Id() {
        }

        public Id(String formKey, String sha256) {
            this.formKey = formKey;
            this.sha256 = sha256;
        }

        public String formKey() {
            return formKey;
        }

        public String sha256() {
            return sha256;
        }

        @Override
        public boolean equals(Object other) {
            return other instanceof Id id && Objects.equals(formKey, id.formKey) && Objects.equals(sha256, id.sha256);
        }

        @Override
        public int hashCode() {
            return Objects.hash(formKey, sha256);
        }
    }

    @EmbeddedId
    private Id id;

    @Lob
    @Column(name = "definition_json", nullable = false)
    private String json;

    @Column(name = "recorded_at", nullable = false)
    private Instant recordedAt;

    protected SnapshotEntity() {
    }

    public SnapshotEntity(Id id, String json, Instant recordedAt) {
        this.id = id;
        this.json = json;
        this.recordedAt = recordedAt;
    }

    public Id getId() {
        return id;
    }

    public String getJson() {
        return json;
    }
}
