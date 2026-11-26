package com.argusvane.datum.timestamp.spring;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.timestamp.TimestampQuery;
import com.argusvane.datum.timestamp.TsaLog;
import com.argusvane.datum.timestamp.web.TsaMvcTestApp;
import com.argusvane.datum.web.monitoring.DatumHealthContributors;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import org.bouncycastle.tsp.TimeStampResponse;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders;

/** The server over an H2 database with the shipped migration: serials are row ids, clients are rows. */
@SpringBootTest(classes = {TsaMvcTestApp.class, JdbcWebTest.Database.class}, properties = {
    "datum.tsa.enabled=true", "datum.tsa.access=clients", "datum.tsa.client-store=jdbc", "datum.tsa.signer.self-signed=true",
    "spring.main.web-application-type=servlet"})
@AutoConfigureMockMvc
class JdbcWebTest {

    @Configuration(proxyBeanMethods = false)
    static class Database {

        @Bean
        JdbcTemplate datumTestJdbc() {
            return Migrations.database("h2");
        }

        /** The stores take the DataSource (on Spring's JDBC). */
        @Bean
        javax.sql.DataSource datumTestDataSource(JdbcTemplate datumTestJdbc) {
            return datumTestJdbc.getDataSource();
        }
    }

    @Autowired
    MockMvc mvc;

    @Autowired
    JdbcTemplate jdbc;

    @Autowired
    JdbcTsaClientStore clients;

    @Autowired
    TsaLog log;

    @Autowired
    DatumHealthContributors health;

    private MockHttpServletResponse post(String key) throws Exception {
        var request = MockMvcRequestBuilders.request(HttpMethod.POST, "/tsa").contentType("application/timestamp-query")
            .content(TimestampQuery.forData("a document".getBytes(StandardCharsets.UTF_8)));
        if (key != null) {
            request.header("Authorization", "Bearer " + key);
        }
        return mvc.perform(request).andReturn().getResponse();
    }

    @Test
    void aClientOfTheDatabaseGetsTokensWhoseSerialIsTheLogRowAndRevocationStopsThem() throws Exception {
        assertThat(health.evaluate().get("datum-tsa").details()).containsEntry("serialAllocator", "jdbc");
        JdbcTsaClientStore.Issued acme = clients.add("Acme");

        assertThat(post(null).getStatus()).isEqualTo(401);
        MockHttpServletResponse granted = post(acme.key());
        assertThat(granted.getStatus()).isEqualTo(200);

        long serial = new TimeStampResponse(granted.getContentAsByteArray()).getTimeStampToken().getTimeStampInfo().getSerialNumber().longValueExact();
        Map<String, Object> row = jdbc.queryForMap("SELECT id, algorithm, channel, client, policy, fingerprint FROM datum_tsa_log");
        assertThat(((Number) row.get("id")).longValue()).isEqualTo(serial);
        assertThat(row.get("algorithm")).isEqualTo("sha256");
        assertThat(row.get("channel")).isEqualTo("http");
        assertThat(row.get("client")).isEqualTo(acme.client().id());
        assertThat(row.get("fingerprint").toString()).hasSize(64);
        assertThat(log.count()).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT uses FROM datum_tsa_client", Long.class)).isEqualTo(1);

        assertThat(clients.revoke(acme.client().id())).isTrue();
        assertThat(post(acme.key()).getStatus()).isEqualTo(401);
        assertThat(log.count()).as("a refused key takes no serial").isEqualTo(1);
    }
}
