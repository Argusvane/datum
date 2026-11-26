# TSA server example

An RFC 3161 timestamp server and nothing else: Spring Boot with Spring MVC, an in-memory H2 database for the
serial numbers and a self-signed development certificate. The application class has no code of its own;
`datum-spring-boot-starter-timestamp` and `src/main/resources/application.yml` do the work.

## Before you build

The jars carry browser assets, programs and notices that the build generates from `packages/datum/dist`, so on a fresh clone
build those first. From the repository root, with Node 22 on the `PATH` (the Maven build runs `node`) and JDK 17 or newer:

```sh
npm run setup -- engine packages/quickjs-wasm-host packages/pdf-kernel packages/datum
npm run datum:build
```

The first Maven build also compiles the pinned QuickJS runtime for six native targets, which takes 12 to 16 minutes. Add
`-Pdev-native` to the `./mvnw` command below to compile the host's target only, for a local run. A source build is version
`0.1.0-SNAPSHOT`, the version in the jar name below.

Then, from `integrations/jvm`:

```
./mvnw -q -B -pl examples/tsa-server -am package
java -jar examples/tsa-server/target/datum-example-tsa-server-0.1.0-SNAPSHOT-exec.jar
```

It answers on <http://localhost:8080/tsa> (`POST`), with the certificate at `/tsa/certificate` (add `?format=der`
for the certificate alone) and every certificate it has signed with at `/tsa/certificates`. The server is open
(`datum.tsa.access: open`), so no key is needed. Turn it to `clients` and list the SHA-256 of each client key
under `datum.tsa.clients` to ask for one: a client sends its key as a bearer token or as the password of HTTP
Basic authentication.

## Stamp a file and verify it with openssl

```
echo "a document the server never sees" > file.txt

# 1. a request that carries only the file's SHA-256 digest (and asks for the certificate)
openssl ts -query -data file.txt -sha256 -cert -out file.tsq

# 2. the server's answer
curl -s -H 'Content-Type: application/timestamp-query' --data-binary @file.tsq \
  http://localhost:8080/tsa -o file.tsr

# 3. the certificate the token is signed with, as a trust anchor
curl -s http://localhost:8080/tsa/certificates -o tsa.pem

# 4. check the token against the request (this prints "Verification: OK")
openssl ts -verify -data file.txt -in file.tsr -CAfile tsa.pem

# read it
openssl ts -reply -in file.tsr -text
```

The certificate is made when the server starts and signs only until it stops, so keep `tsa.pem` with the
token you want to verify later. For a certificate that outlives the process, point
`datum.tsa.signer.ssl-bundle` at a Spring Boot SSL bundle (`spring.ssl.bundle.jks.<name>.keystore.location`, `.password`,
`key.alias`) holding a PKCS#12 file instead of setting
`self-signed`, and add the certificates the server used before to `datum.tsa.retired-certificates`.

## What is in memory

The H2 database is created at each start and the module's migration runs in it (`datum.jdbc.initialize-schema`, `embedded` by default), so serial numbers
start again with each run. The serials come from the `datum_tsa_log` table (health `datum-tsa` reports `serials: jdbc`); without a
`DataSource` and that migration the in-memory allocator is refused at start unless `datum.tsa.allow-memory-stores=true`
acknowledges a single instance. A server whose tokens are kept needs a database that lasts: replace the
`spring.datasource.url`, set `datum.jdbc.initialize-schema: never` and run the migration for your database with Flyway or Liquibase.

## Behind a proxy, with Spring Security, and the retired list

- The failed-key lockout (ten wrong keys per address per hour) and the open per-address flood limit count the
  address the servlet container sees. Behind a reverse proxy that is the proxy's address unless
  `server.request.header.forwarded.strategy` is set (`web-server` or `framework`), so set it, and let only your proxy reach the app.
- An application with Spring Security must permit the path (`/tsa/**`) and exempt it from CSRF: the server
  takes no session, and a client sends a `POST` with a key, not a form token. A request that carries a session
  cookie is refused with 403 on purpose. By default any cookie is refused (`datum.tsa.session-cookies` is `*`); set a
  list of names to refuse only those, and `server.servlet.session.cookie.name` is added to such a list when it is set.
- `/tsa/certificates` lists retired certificates under a plain `# Retired` comment (this host has no start date for a
  PEM file), so verifiers should read the certificates, not the comment.
- `datum.tsa.max-request-size` must be between 1 byte and 1 MB (default 16 KB); anything else stops the start.
- The flood counts are kept in memory per process, in separate tables for failed keys, clients and open
  addresses, so traffic from many addresses cannot reset the failed-key lockout. A cluster needs its own `TsaFlood` bean.
