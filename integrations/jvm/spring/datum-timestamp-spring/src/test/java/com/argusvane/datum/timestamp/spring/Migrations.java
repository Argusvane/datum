package com.argusvane.datum.timestamp.spring;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

/** An in-memory H2 database with the shipped migration applied the way Flyway would: statement by statement. */
final class Migrations {

    private Migrations() {
    }

    /** @param dialect {@code h2}, {@code postgresql} or {@code mysql}: H2 is put in that mode for the last two. */
    static JdbcTemplate database(String dialect) {
        String mode = switch (dialect) {
            case "postgresql" -> ";MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DEFAULT_NULL_ORDERING=HIGH";
            case "mysql" -> ";MODE=MySQL;DATABASE_TO_LOWER=TRUE";
            default -> "";
        };
        JdbcTemplate jdbc = new JdbcTemplate(new DriverManagerDataSource("jdbc:h2:mem:" + UUID.randomUUID() + ";DB_CLOSE_DELAY=-1" + mode, "sa", ""));
        apply(jdbc, dialect);
        return jdbc;
    }

    static void apply(JdbcTemplate jdbc, String dialect) {
        String script;
        try (var in = Migrations.class.getClassLoader().getResourceAsStream("META-INF/datum/db/migration/" + dialect + "/V300__datum_timestamp.sql")) {
            script = new String(in.readAllBytes(), StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
        for (String statement : script.split(";")) {
            String sql = statement.lines().filter(line -> !line.strip().startsWith("--")).reduce("", (a, b) -> a + "\n" + b).strip();
            if (!sql.isEmpty()) {
                jdbc.execute(sql);
            }
        }
    }
}
