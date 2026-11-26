package com.argusvane.datum.timestamp.web;

import com.argusvane.datum.timestamp.TimestampQuery;
import com.argusvane.datum.web.monitoring.DatumHealthContributors;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import org.bouncycastle.tsp.TSPException;
import org.bouncycastle.tsp.TimeStampResponse;
import org.springframework.beans.factory.annotation.Autowired;

/**
 * The expectations of the timestamp endpoints, the same on both stacks. A subclass supplies the application
 * (MockMvc or a random-port Netty server) and the properties; this class holds a transport-neutral {@code send}.
 */
public abstract class TsaContract {

    protected static final String QUERY = "application/timestamp-query";
    protected static final String KEY_ONE = "dtsa_test-client-key-one";
    protected static final String HASH_ONE = "c2931b824fd8a71cdfbdb5a24c62eaed4b9d2dde904e70cc4f1a29378bdb9102";
    protected static final String KEY_TWO = "dtsa_test-client-key-two";
    protected static final String HASH_TWO = "a8a39bf8877a0b30461bbeeff9ba6aaee34de0700852894ce07d75c889c5c365";

    @Autowired
    protected EventLog events;

    @Autowired
    protected DatumHealthContributors health;

    /** Any method; headers as name, value pairs. */
    protected abstract Reply send(String method, String path, byte[] body, String... headers);

    /** The path the server answers at. */
    protected String path() {
        return "/tsa";
    }

    protected final Reply get(String path, String... headers) {
        return send("GET", path, null, headers);
    }

    /** POSTs a fresh TimeStampReq as application/timestamp-query. */
    protected final Reply stamp(String... headers) {
        return post(TimestampQuery.forData("a document the server never sees".getBytes(StandardCharsets.UTF_8)), headers);
    }

    protected final Reply post(byte[] body, String... headers) {
        String[] all = new String[headers.length + 2];
        all[0] = "Content-Type";
        all[1] = QUERY;
        System.arraycopy(headers, 0, all, 2, headers.length);
        return send("POST", path(), body, all);
    }

    protected static TimeStampResponse parse(Reply reply) {
        try {
            return new TimeStampResponse(reply.body());
        } catch (TSPException | IOException e) {
            throw new AssertionError("not a TimeStampResp: " + e.getMessage(), e);
        }
    }

    /** Basic credentials with any user name and the key as password. */
    protected static String basic(String key) {
        return "Basic " + java.util.Base64.getEncoder().encodeToString(("anyone:" + key).getBytes(StandardCharsets.UTF_8));
    }

    /** BC's mask for a PKIFailureInfo bit index (bit 0 is the most significant bit of the first octet). */
    protected static int bcMask(int bit) {
        return (0x80 >> (bit % 8)) << (8 * (bit / 8));
    }
}
