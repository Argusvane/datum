package com.argusvane.datum.timestamp.web;

import java.time.Instant;

/**
 * Published after the timestamp endpoint issued a token: for an audit trail, metrics or billing by client. It
 * carries what the server's log keeps and no more (never a document, which the server never sees). Not published when
 * counting a client's use failed (logged instead).
 *
 * <p>Delivery: synchronously on the request thread, with Spring's default multicaster, after the reply is
 * built and before it is sent; the serial is spent by then (in its own write, no transaction of the request). A listener
 * that throws is logged and the reply is sent all the same; it cannot veto.
 *
 * @param serial the token's serial number
 * @param genTime the token's genTime
 * @param imprintAlgorithm {@code sha256}, {@code sha384} or {@code sha512}
 * @param client the client that asked ({@code TsaClient#id()}), or {@code null} for an open request
 */
public record TimestampIssuedEvent(long serial, Instant genTime, String imprintAlgorithm, String client) {
}
