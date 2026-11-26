# Spring Boot

The Spring Boot starters add Datum's server side to your own application:

- The form definition, served by id.
- Submissions, validated by the same program the page runs.
- The form and builder assets.
- PDF render, fill, sign and verify.
- An RFC 3161 timestamp server.
- Passkey-signed submissions.

Every route is off until you switch it on, and who may call it is your Spring Security configuration, not a Datum policy. The Spring Boot starters are tested on Linux. The [server hosts](/server-hosts) page compares the hosts.

## First run

This section takes the form from [Getting started](/getting-started) to a Spring Boot application that receives its submission. Follow it from top to bottom. It needs nothing from the rest of the page.

You need:

- JDK 17 or newer, and a Spring Boot 4 application: this one uses Spring MVC, and WebFlux works as well.
- Node 22, npm and git, to build the browser files. The artifacts are not on Maven Central yet, so the build installs them from a clone of the repository into your local Maven repository. The build downloads the sandbox runtime once.

1. **Build the browser files.** Run the commands of [Files you host](/files#getting-the-files) in a clone of the repository. The Maven build in the next step reads `packages/datum/dist` and needs `node` on the path.

2. **Install the host,** from the root of the clone:

   ```sh
   cd integrations/jvm
   ./mvnw -B -Pdev-native -pl spring/datum-spring-boot-starter-submissions -am clean install -DskipTests -DskipITs
   ```

   This takes about three minutes. Nearly all of it is compiling the sandbox runtime, and `-Pdev-native` compiles it for this machine's platform only: without it the build compiles six platforms and takes 12 to 16 minutes, and a jar built with it runs native here and slowly elsewhere, so keep it for local use. `-DskipTests` alone still runs the integration tests, so `-DskipITs` goes with it. `-pl` and `-am` build the submissions starter and what it needs. The artifacts land in `~/.m2` at version `0.1.0-SNAPSHOT`.

3. **Make a folder for the application** beside the clone, named `intake` here, and put this `pom.xml` in it. The BOM sets the version of every Datum artifact, and the starter adds the submissions route. The starters bring no web stack, so the pom adds one itself:

   ```xml
   <project xmlns="http://maven.apache.org/POM/4.0.0">
     <modelVersion>4.0.0</modelVersion>
     <parent>
       <groupId>org.springframework.boot</groupId>
       <artifactId>spring-boot-starter-parent</artifactId>
       <version>4.2.0</version>
     </parent>
     <groupId>example</groupId>
     <artifactId>intake</artifactId>
     <version>1.0.0</version>

     <dependencyManagement>
       <dependencies>
         <dependency>
           <groupId>com.argusvane</groupId>
           <artifactId>datum-bom</artifactId>
           <version>0.1.0-SNAPSHOT</version>
           <type>pom</type>
           <scope>import</scope>
         </dependency>
       </dependencies>
     </dependencyManagement>

     <dependencies>
       <dependency>
         <groupId>com.argusvane</groupId>
         <artifactId>datum-spring-boot-starter-submissions</artifactId>
       </dependency>
       <dependency>
         <groupId>org.springframework.boot</groupId>
         <artifactId>spring-boot-starter-webmvc</artifactId>
       </dependency>
     </dependencies>

     <build>
       <plugins>
         <plugin>
           <groupId>org.springframework.boot</groupId>
           <artifactId>spring-boot-maven-plugin</artifactId>
         </plugin>
       </plugins>
     </build>
   </project>
   ```

4. **Put the form where the host reads it.** Save the form the page uses (`forms/contact.json` in Getting started, id `contact`, version `1.0.0`) as `src/main/resources/datum/forms/contact.json`. That is the default of `datum.forms.locations`, `classpath:/datum/forms/*.json`. The file's `id` is its key.

5. **Write the application,** `src/main/java/example/Application.java`:

   ```java
   package example;

   import com.argusvane.datum.submissions.spi.SubmissionHandler;
   import com.argusvane.datum.submissions.spi.SubmissionReceipt;
   import java.util.UUID;
   import org.springframework.boot.SpringApplication;
   import org.springframework.boot.autoconfigure.SpringBootApplication;
   import org.springframework.context.annotation.Bean;

   @SpringBootApplication
   public class Application {

       public static void main(String[] args) { SpringApplication.run(Application.class, args); }

       @Bean SubmissionHandler handler() {
           return accepted -> {
               System.out.println("received " + accepted.formKey() + " " + accepted.values());
               return new SubmissionReceipt(UUID.randomUUID().toString(),
                   accepted.digest().substring(0, 8).toUpperCase(), null);
           };
       }
   }
   ```

   The handler is the one thing the starter leaves to you: it stores the accepted submission and answers its receipt, and the `reference` is what the form's confirmation shows. Here it prints the answers. A real handler stores them once under a unique key on `accepted.formKey()` and `accepted.submissionKey()`, because a retried attempt may reach it twice. Without a handler bean the default logs the form and a digest, stores nothing and warns at start.

6. **Switch the route on,** in `src/main/resources/application.yml`. Every route is off until its switch is on, and the submissions switch is all this story needs. The port is 8081 because the static server of Getting started holds 8080:

   ```yaml
   server:
     port: 8081
   datum:
     web:
       api:
         endpoints:
           submissions: true
   ```

7. **Build and run,** in the `intake` folder:

   ```sh
   ../datum/integrations/jvm/mvnw -q package
   java --enable-native-access=ALL-UNNAMED -jar target/intake-1.0.0.jar
   ```

   The flag is for JDK 24 and newer, where the JVM prints `WARNING: A restricted method ... has been called` at the sandbox's first native call unless native access is enabled; the application runs either way. On JDK 17 to 23 the flag changes nothing. An executable jar can carry `Enable-Native-Access: ALL-UNNAMED` in its manifest instead, which Spring Boot's repackaging keeps.

   The start takes a few seconds. Among three WARN lines that say the throttle, the form snapshots and the receipts are kept in this process's memory, the log holds these lines, trimmed here:

   ```
   INFO  datum.web : Datum routes enabled (1):
     POST /api/submissions (datum.web.api.endpoints.submissions)
   INFO  c.a.d.sandbox.runtime.DatumSandbox : Datum runtime UP: engine endive 1.2.0 (panama), sandbox ABI 4.1.0 ...
   INFO  example.Application : Started Application in 5.9 seconds
   ```

   With the switch off the log says `no Datum route is enabled`, and a post to the route answers the framework's 404.

8. **Send a submission.** In a second terminal, post the body a page sends: the envelope as `document`, and the key of the submit attempt.

   ```sh
   curl -s -X POST localhost:8081/api/submissions -H 'content-type: application/json' -d '{
     "document": {
       "versionContext": { "form": { "id": "contact", "version": "1.0.0" } },
       "submission": { "locale": "en", "values": {
         "fullName": "Ada Lovelace", "email": "ada@example.com", "topic": "question", "message": "Hello" } }
     },
     "submissionKey": "first-run-1"
   }'
   ```

   The reply is 200, and the server prints `received contact {...}`:

   ```json
   {"id":"1bbf7a18-7cec-416d-ab24-4f97ccb4a4fc","reference":"81396661","status":"accepted","digest":"813966615705ced43fc2ab4c6d752fd703fbf171f7af0157651bab2a321f56b6","handled":false}
   ```

   Send the same command again and `handled` is `true`: the same key gets the first receipt, and the handler is not called again. A body with no `submissionKey` is a 400 `bad_document`.

9. **Send answers the form refuses.** Change `fullName` to `""` and the key to `first-run-2`. The sandbox judges the answers against the form's own copy and the reply is 422, which a page puts on the field with `setErrors`:

   ```json
   {"errors":[{"field":"fullName","code":"required"}]}
   ```

10. **Open the page through the application.** The page from [Send it to a server](/getting-started#send-it-to-a-server) posts this body to this route: both are this host's defaults. A browser lets a page read a reply only from its own origin, so serve the site folder of Getting started from the application. Add it to `application.yml`, then build and run again:

    ```yaml
    spring:
      web:
        resources:
          static-locations: file:../my-site/
    ```

    Open `localhost:8081` in a browser, fill the form in and press Send. The form shows "Your form was submitted" with the reference the handler answered, and the server prints the answers.

Two things to keep in mind from here:

- The `id` and `version` in the page's form must be the ones the host holds, so the page and the host read the same file.
- A page that stays on another origin needs CORS configured in your application: the host adds no CORS headers.

## Starters

Add the starter a story needs the way the first run adds the submissions one, with the BOM importing the versions.

| Starter | Use it for |
|---|---|
| `datum-spring-boot-starter-submissions` | The form is on your page and the server validates what it submits |
| `datum-spring-boot-starter-ui` | The same, and the server also serves the form and builder assets and the page glue |
| `datum-spring-boot-starter-pdf` | PDF render, fill, sign and verify |
| `datum-spring-boot-starter-timestamp` | An RFC 3161 timestamp server, standalone |
| `datum-spring-boot-starter-webauthn` | Passkey ceremonies and signed-submission verification |

## Switching routes on

A starter on the class path maps nothing. Each route group has a property, and a route that is off answers the framework's own 404.
```yaml
datum:
  web:
    api:
      endpoints:
        submissions: true
        validate: true
        definition: true
```

The log lists what is on at start, under the logger `datum.web`.

Paths sit under `datum.web.api.path` (default `/api`), except these:

- The assets: `datum.web.assets.path`, default `/datum/assets`.
- The timestamp server: `datum.tsa.path`, default `/tsa`.
- The passkey routes: `datum.webauthn.path`, default `/api/webauthn`.

| Property | Maps |
|---|---|
| `datum.web.api.endpoints.submissions` | `POST /submissions` |
| `datum.web.api.endpoints.validate` | `POST /submissions/validate` |
| `datum.web.api.endpoints.definition` | `GET /forms/{key}/definition`, `GET /forms/{key}/translations` |
| `datum.web.api.endpoints.data-sources` | `GET /data-sources/{id}` |
| `datum.web.api.endpoints.test` | `POST /submissions/test`, the dry run |
| `datum.web.api.endpoints.inspect` | `POST /inspect` |
| `datum.web.api.endpoints.pdf`, `.fill`, `.sign`, `.verify` | `POST /pdf`, `/pdf/fill`, `/pdf/sign`, `/pdf/verify` |
| `datum.web.api.endpoints.certificate` | `GET /server/certificate` |
| `datum.web.assets.enabled` | The bundles and `datum-host.js` under `/datum/assets` |
| `datum.builder.enabled` | `POST /forms`, `PUT /forms/{key}`, `PUT /forms/{key}/translations`, and the builder files |
| `datum.tsa.enabled` | `POST /tsa`, `GET /tsa/certificate`, `GET /tsa/certificates` |
| `datum.webauthn.enabled` | `/api/webauthn/*`, with `datum.webauthn.rp-id`, `rp-name` and `origins` |

### The check route

`POST /submissions/validate` checks a journey or one page of it.

- **Body.** `{ document, scope, pageId? }`. `scope` is required and is `journey` or `page`, and `pageId` goes with `page` only. Anything else is a 400.
- **Verdict.** A 200 `{ accepted, errors, notes? }`. `errors` holds only what blocks, and warnings and info go in `notes`, which is left out when empty.

A run that fails is not a verdict, so it is never a 422. Both routes answer it with a 503 and the run's code:

- `wasm.execution_error`
- `outcome_too_large`
- `definition.tooDeep`, when the form itself nests too deep

The other 503s are `server.busy`, `server.unavailable` and `validator_unavailable`. Only `server.busy` carries `Retry-After`, because retrying the others does not help. The PDF routes and `POST /inspect` answer a failed run the same way. A 422 always means the answers were judged and refused. The full shapes are on [the wire](/wire).

### Error bodies

An error body is `{ errors: [ { field?, code, message? } ] }`. `field` is there only when the error names a component, so a form-level error carries none. `message` is the sandbox's own wording for a finding, sent as it came, on a check's 200 and on a submission's 422. A message that a hook gave belongs to the finding that hook raised, and it never replaces the sandbox's.

### Common properties

Every property, with its default and bounds, is on [Spring Boot properties](/spring-boot-properties). The ones met most often:

- `datum.forms.locations`, default `classpath:/datum/forms/*.json`.
- `datum.web.api.max-body-size`, default `1MB`.
- `datum.web.api.problem-details`, for RFC 9457 errors.
- `datum.runtime.validation.time-limit`, default `5s`, and `memory`, default `32MB`.
- `datum.host.time-zone`.
- `datum.web.throttle.limit`, default `60` per `1m` for one key, and `datum.web.throttle.address-limit`, default `600`, for one address before the body is read.

A value that cannot work stops the start and names the property. `datum.enabled=false` removes the beans and the runtime too.

## Beans you bind

Each of these is optional and replaces its default. The routes, bodies and codes they take part in are on [the wire](/wire).

| Bean | What it does |
|---|---|
| `SubmissionHandler` | Stores the accepted submission and returns the receipt |
| `FormDefinitionRepository` | Where forms live; the default is read-only over `datum.forms.locations` |
| `DefinitionSnapshotStore`, `TranslationCatalogStore`, `DataSourceProvider` | The versions a submission is judged against, by hash; the host's translation catalogue for a form; option lists a form loads |
| `SubmissionThrottle`, `SubmissionIdempotencyStore` | One limit across instances; answering a retried attempt with its first receipt |
| `PdfSigner`, `PdfFonts`, `PdfTemplateSource` | The PDF seal key, fonts and template bytes |
| `Timestamper`, `PdfTrustPolicy` | Where the PDF seal gets its timestamps; which anchors, revocation checking and validation time decide that a signer is `trusted` |
| `TsaKeyMaterial`, `TsaSerialAllocator`, `TsaClientStore` | The timestamp server's signing key, its serial numbers and the clients allowed to ask |
| `PasskeyRepository`, `PasskeyUseStore`, `PasskeySubjectResolver`, `PasskeyThrottle` | Stored passkeys, the replay guard, who a request is, and the limit on challenges and registrations |
| `ErrorTranslator` | Turns an exception Datum does not know into an answer; asked in bean order before the built-in mapping |
| `HostContextProvider` | The values the form's `host.` names read, worked out from the request; see [the host context](#the-host-context) |
| `DatumStartupCheck` | A note the host says once at start |
| `SandboxDecorator`, `PdfKernelDecorator` | Wrap the sandbox or the PDF program the runtime built, for instrumentation |

The stores of the timestamp server and passkeys refuse to start in memory unless `datum.tsa.allow-memory-stores` or `datum.webauthn.allow-memory-stores` acknowledges one instance. [Server hosts](/server-hosts#running-more-than-one-instance) lists everything that has to be shared when there is more than one.

With a `DataSource` and `spring-jdbc` the stores are SQL.

- **Scripts.** H2, PostgreSQL and MySQL scripts ship under `META-INF/datum/db/migration/{vendor}` and work with Flyway or Liquibase.
- **Schema.** `datum.jdbc.initialize-schema` is `embedded` by default, which makes the tables only in an in-memory database. Set `never` in production.
- **Several data sources.** Mark the one Datum uses `@DatumDataSource`.
- **Signing keys.** They come from a Spring Boot SSL bundle named in `datum.pdf.signing.ssl-bundle` or `datum.tsa.signer.ssl-bundle`.

## Hooks, in order

Every capability runs a request through the same kinds of hook. `*Customizer` beans run before the engine or the store is asked and may adjust a draft or refuse. `*Validator` beans run after the engine answered and may add errors or warnings. One handler does the effect, and Spring events follow it and never veto.

A submission goes through these in order:

1. `SubmissionPreCheck` (anti-spam, quotas, per-form access).
2. `HostOptionsCustomizer`, `SandboxRulesProvider` and `SandboxContextContributor`.
3. Your `HostContextProvider`.
4. The sandbox.
5. `SubmissionSignatureCheck`.
6. `SubmissionValidator`.
7. Your handler.

Customizers each see what the one before left, and the first refusal stops the rest. Validators all run, so every error is reported at once. Beans with equal `@Order` keep no promised order, so declare `@Order` where position matters.

Each capability has its own hooks, all of the same two kinds:

| Capability | Customizers (before) | Validators (after) |
|---|---|---|
| Submissions | `SubmissionPreCheck`, `HostOptionsCustomizer`, `SandboxRulesProvider`, `SandboxContextContributor`, `SubmissionSignatureCheck` | `SubmissionValidator` |
| Forms | `DefinitionCustomizer`, on the public copy on its way to a filler | none |
| Builder | `BuilderSaveCustomizer`, before the kernel checks a save | `BuilderSaveValidator`, after |
| PDF | `PdfRequestCustomizer`, which adjusts `env`, options, `hostContext`, attachments and fonts | `PdfResultValidator`, which judges the PDF before it leaves and, when the server seals, before the seal |
| Timestamp server | `TimestampRequestCustomizer`: refuse a client, choose a policy among the accepted ones, state another accuracy | none |
| Passkeys | `RegistrationCustomizer`, at the challenge and at the registration; `SignatureCheckCustomizer`, which can only tighten a form's signature check | `RegistrationValidator`, after the ceremony verified a passkey and before it is stored |

A pre-check refuses by returning `PreCheckDecision.Reject` with a code and a message, answered 403 unless it says otherwise. Any other hook refuses with a `HookRefusedException`: `forbidden` answers 403, `conflict` 409 and `invalid` 422, with an `errors` body of field, code and message.

### Events

Listen to an event with `@EventListener`; a failing listener is logged and never changes the answer. The events are:

- `SubmissionValidatedEvent`, `SubmissionRejectedEvent`, `SubmissionThrottledEvent`, `SubmissionRedeliveredEvent`, `JourneyCheckedEvent`, `SubmissionSignatureVerifiedEvent`
- `FormDefinitionSavedEvent`
- `PdfRenderedEvent`, `PdfVerifiedEvent`
- `TimestampIssuedEvent`, `TimestampRefusedEvent`
- `PasskeyRegisteredEvent`, `PasskeyRevokedEvent`
- `SandboxReadyEvent`, `SandboxRunInterruptedEvent`

## The host context

A rule can read a fact about the visit, such as `host.role = "admin"`. The page's own `hostContext` is only for display: a client can set it to anything, and a submission does not carry it. The server works the values out itself. Declare one `HostContextProvider` bean that reads the request, for example the signed-in person:

```java
@Bean
HostContextProvider hostContext() {
    return request -> {
        if (!(request.submission().principal() instanceof Authentication auth)) {
            return Optional.empty();
        }
        boolean admin = auth.getAuthorities().stream().anyMatch(a -> a.getAuthority().equals("ROLE_ADMIN"));
        return Optional.of(Map.of("role", admin ? "admin" : "user"));
    };
}
```

It is asked once for each submission, journey check, dry run and PDF. `request.submission()` also has the headers and the client address, and `request.formKey()` says which form it is. Nothing in the request body is ever read for it.

What the provider returns decides how `host.` rules are judged:

- **Empty.** There is no context. Rules that read `host.` are left unjudged, as before: a field shown only to some people is not required.
- **A map, even an empty one.** It is a context: every such rule is judged, and a name it does not hold has no value.
- **A throw, or something that is not plain JSON data within 64 levels.** The request is refused with 503 `server.unavailable`, nothing runs and the cause is logged.

A retry of a submission already accepted keeps its first answer. Two `HostContextProvider` beans stop the application at start.

## Securing the routes

With `spring-boot-starter-security` on the class path, `DatumRequestMatchers` (servlet) and `DatumExchangeMatchers` (WebFlux) give your filter chain one matcher per capability: `formsRead()`, `builderReads()`, `builderWrites()`, `dataSources()`, `submissions()`, `validate()`, `dryRun()`, `inspect()`, `pdf()`, `pdfVerify()`, `passkeys()`, `tsa()`, `assets()` and `all()`.

```java
@Bean
SecurityFilterChain chain(HttpSecurity http, DatumRequestMatchers datum, DatumSecurityResponses responses) throws Exception {
    return http
        .authorizeHttpRequests(requests -> requests
            .requestMatchers(datum.builderWrites(), datum.builderReads(), datum.dryRun(), datum.inspect()).hasRole("EDITOR")
            .requestMatchers(datum.formsRead(), datum.submissions(), datum.validate(), datum.assets()).permitAll()
            .anyRequest().authenticated())
        .httpBasic(Customizer.withDefaults())
        .exceptionHandling(exceptions -> exceptions
            .defaultAuthenticationEntryPointFor(responses.authenticationEntryPoint("Basic realm=\"forms\""), datum.all())
            .defaultAccessDeniedHandlerFor(responses.accessDeniedHandler(), datum.all()))
        .build();
}
```

`DatumSecurityResponses` (`DatumServerSecurityResponses` on WebFlux) answers a refusal on Datum's routes as JSON, 403 `access.denied` or 401 `unauthorized`.

- **One form for one person.** Where the form is in the body of a request, a matcher cannot see it, so refuse it in a `SubmissionPreCheck`, which receives the form key and the principal.
- **No security chain.** Every route that is on is open, and the start logs a warning when the builder writes, the passkey routes or the timestamp server would be.

Behind a proxy set `server.request.header.forwarded.strategy` so the throttle sees the client address. `responses.recipes()` has the cookie CSRF setup the page glue reads.

## The builder write endpoints

`datum.builder.enabled=true` on the UI starter serves the builder and three write routes: `POST /api/forms`, `PUT /api/forms/{key}` and `PUT /api/forms/{key}/translations`, plus the author's copy of a form at `GET /api/forms/{key}/definition?public=false`.

- **Checks.** The sandbox kernel checks a save before it is stored, and a save made against an out-of-date version is refused with 409 `form.outdated`. The request and reply bodies, headers and codes are on [the wire](/wire#builder).
- **Security.** Secure `builderWrites()` and `builderReads()`, because the author's copy of a form includes its server-secret rules.
- **Repository.** The default repository is read-only, so supply a `FormDefinitionRepository` that can save, or a save answers 501 `forms.readOnly`.
- **Size.** Limit the size of a definition with `datum.builder.max-definition-size`.

## Serving the form from the host

`datum.web.assets.enabled` serves `host.json`, the page glue `datum-host.js` and the bundles under the build id. [Server hosts](/server-hosts#the-page-glue) shows the page code and lists every `DatumHost` method.

## Drafts

The starters do not serve draft routes. A `server:` draft store calls four routes you write yourself; they are described on [Drafts](/drafts).

## Sealing PDFs

The server seals the PDFs it issues with its own key. The key comes from a Spring Boot SSL bundle.

```yaml
spring:
  ssl:
    bundle:
      jks:
        pdf-seal:
          keystore: { location: file:/etc/datum/seal.p12, password: "${SEAL_PASSWORD}", type: PKCS12 }
          key: { alias: seal, password: "${SEAL_PASSWORD}" }
datum:
  pdf:
    signing:
      ssl-bundle: pdf-seal
    seal:
      enabled: true
      timestamp: true
```

| Property | Does |
|---|---|
| `datum.pdf.signing.ssl-bundle` | The bundle holding the seal key and its chain. `seal.enabled` without a key is a start-up warning. |
| `datum.pdf.seal.enabled`, `.layouts`, `.certify`, `.reason`, `.location`, `.visible` | Turn the seal on, limit it to some layouts, and set what the signature says. |
| `datum.pdf.seal.timestamp` | Ask for a timestamp token over each seal. It needs a [timestamp source](/timestamps#on-a-built-host); without one the start warns. |
| `datum.pdf.signing.trust-anchors`, `.retired-certificates` | Anchors the verify route builds a chain to, and the certificates the seal key replaced. |
| `datum.pdf.seal.posted-answers` | Seal the PDFs of posted, unstored answers with the real key. Off, a throwaway test certificate seals them. |

Where the seal gets its timestamps, a server you name or the host's own, is on [Timestamp server](/timestamps). Every property is on [Spring Boot properties](/spring-boot-properties#pdf).

## Requiring a passkey signature

With the passkey starter and `datum.webauthn.enabled=true`, a form can require the person to sign with a passkey. Set the site's `rp-id` and `origins`, a `datum.webauthn.secret` of at least 32 bytes, and then per form:

```yaml
datum:
  webauthn:
    enabled: true
    rp-id: example.org
    origins: [https://forms.example.org]
    forms:
      intake:
        mode: required
```

`mode` is `off`, `optional` or `required`; `unavailable` says whether a browser that cannot sign is `refuse`d or `accept`ed unsigned. The other per-form keys (`scope`, `placement`, `user-verification`, `statement`, `verify`) and the site settings are on [Spring Boot properties](/spring-boot-properties#passkeys). The routes are on [the wire](/wire#passkeys), and the whole of it, page and server, is on [Signing a form with a passkey](/passkey-signing).

## Observability

Expose what you need, for example `management.endpoints.web.exposure.include=health,info,datum`.

- **Health.** The `datum` health component has one member per check, with `runtime` the one a readiness group should use.
- **Actuator.** `/actuator/datum` reports the runtime and the settings it runs with and, on `POST`, rechecks it without a restart.
- **Meters.** They include `datum.runs`, `datum.submissions` and `datum.throttled`.
- **Observations.** With an `ObservationRegistry` Datum reports `datum.submission`, `datum.sandbox.run`, `datum.pdf.run`, `datum.pdf` and `datum.tsa.issue`, and no answer, byte or digest is ever a tag.
- **OpenAPI.** With springdoc every enabled route is documented, one group per capability, such as `datum-forms`, `datum-submissions` and `datum-pdf`.

## Testing

Add `datum-spring-boot-starter-test` in test scope. `@AutoConfigureDatum` gives a test context with a fake runtime in place of the sandbox, and fixture forms with `testForms = true`. `DatumMockMvc` and `DatumWebTestClient` are the request helpers.

To check a running deployment against the wire contract, run `datum-host-check` from the [conformance suite](/conformance), which needs no JDK. The same checks ship as JUnit contracts in the `datum-host-tck` module, which reads the same `datum.tck.*` settings.

```sh
datum-host-check --endpoint https://forms.example --capabilities submissions,submissions-test,forms,assets
```

Every property is on [Spring Boot properties](/spring-boot-properties), and every route on [The wire](/wire).
