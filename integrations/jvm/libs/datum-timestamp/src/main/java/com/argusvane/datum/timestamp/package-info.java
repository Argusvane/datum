/**
 * Datum timestamp: an RFC 3161 Time-Stamp Authority, server and client, with no Spring and no Datum runtime.
 *
 * <p>An RFC 3161 timestamp server: {@link com.argusvane.datum.timestamp.TimestampQuery}
 * reads requests and writes them, {@link com.argusvane.datum.timestamp.TimestampAuthority} issues tokens
 * (Bouncy Castle's {@code tsp} package, certificates carried as given) or refuses with a
 * {@link com.argusvane.datum.timestamp.TimestampRefusal}, {@link com.argusvane.datum.timestamp.TimestampToken}
 * reads and checks tokens, {@link com.argusvane.datum.timestamp.TimestampClient} asks a named server.
 * SPIs: {@link com.argusvane.datum.timestamp.TsaKeyMaterial},
 * {@link com.argusvane.datum.timestamp.TsaSerialAllocator}, {@link com.argusvane.datum.timestamp.TsaLog},
 * {@link com.argusvane.datum.timestamp.TsaClientStore}. The endpoints, stores and auto-configuration live
 * in the {@code web} and {@code spring} sub-packages.
 */
package com.argusvane.datum.timestamp;
