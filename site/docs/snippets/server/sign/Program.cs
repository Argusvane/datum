// Program.cs — the endpoint the page delivers to: the submission validated, rendered as a PDF, and signed.
//   intake.csproj beside it: ASP.NET Core, and Wasmtime, the .NET embedding of wasmtime.
//   curl -LO https://github.com/quickjs-ng/quickjs/releases/download/v0.16.2/qjs-wasi.wasm
//   dotnet run
//
//   the signing key, a self-signed certificate to try with (production uses the organisation's):
//   mkdir -p keys
//   openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 3650 -subj "/CN=Intake service/O=Datum" \
//       -keyout keys/signer.key.pem -out keys/signer.cert.pem
// The PDF is signed the way ISO 32000 and PAdES ask — a signature field, /ByteRange, a CMS
// SignedData — by datum-pdf-program.js, the kernel behind the browser's PDF button, in a QuickJS of
// this process's own. The kernel never sees the key: it prepares the bytes to sign, this process
// signs them with System.Security.Cryptography, the kernel embeds the value. Any viewer validates
// the result; the verify endpoint below is how this server tells its own sealed records apart.
using System.Text.Json;
using System.Text.Json.Nodes;
using Wasmtime;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

var form = JsonNode.Parse(File.ReadAllText("forms/customer-intake.json"))!;

// The journey the answers were given through, from this server's own copy of the form: the
// envelope names it (submission.journey.id) and nothing more. Handed to the sandbox, it has the
// kernel work the path out again from the values, as the browser did: an answer on a page the
// path skipped is judged hidden, and a form field one of the journey's own fields fills or works
// out counts as asked on that page. None named, or one the form does not have: null, and the
// answers are judged as the whole form, which asks for every required field.
JsonNode? JourneyOf(JsonNode submission) =>
    form["journey"]?["journeys"]?.AsArray().FirstOrDefault(journey => (string?)journey!["id"] == (string?)submission["journey"]?["id"]);

// The engine: qjs-wasi.wasm, QuickJS-ng's own WebAssembly build from its release page, compiled
// once, now, and shared (the Sandbox class below). Every request runs it afresh in a store of its
// own, so requests need no lock.
var sandbox = new Sandbox("datum-sandbox-program.js", "datum-pdf-program.js");

// Validation first, so the PDF prints the sanitized values: what the form defines, nothing else.
string[] validate = ["-I", "/app/datum-sandbox-program.js", "-e", "print(__datum_run(std.in.readAsString()));"];

// The PDF program, under the document profile; __datum_pdf's promise settles before qjs exits.
// Signing needs a program that lists "signature" in its capabilities.
string[] render = ["-I", "/app/datum-pdf-program.js", "-e", "__datum_pdf(std.in.readAsString()).then((json) => print(json));"];

// The fonts to embed: the signature's appearance is drawn with the first of them.
static object Font(string id, string family, int weight, string file) =>
    new { id, family, weight, style = "normal", data = Convert.ToBase64String(File.ReadAllBytes(Path.Combine("fonts", file))) };

object[] fonts = [Font("dejavu-sans", "sans-serif", 400, "DejaVuSans.ttf"), Font("dejavu-sans-bold", "sans-serif", 700, "DejaVuSans-Bold.ttf")];

// What the Country select shows, resolved here: the program never fetches a data source.
object[] countries = [new { value = "CA", label = "Canada" }, new { value = "US", label = "United States" }, new { value = "MX", label = "Mexico" }];

// The server's key and certificate chain. The key stays in this process; the chain rides with the
// request (DER, base64, the signer's certificate first) and ends up in the PDF for any viewer to check.
var signer = X509Certificate2.CreateFromPemFile("keys/signer.cert.pem", "keys/signer.key.pem");
var chain = new X509Certificate2Collection();
chain.ImportFromPemFile("keys/signer.cert.pem");
string[] certificates = [.. chain.Select(certificate => Convert.ToBase64String(certificate.RawData))];

// The layout says how the record is sealed — which signature block, certified or not, the reason —
// and the request may override any of it. Null keeps the layout's say (certify, no changes).
object? certify = null;

// A timestamp authority (RFC 3161), for a signature that proves when it was made by a third party's
// clock (PAdES-B-T). Empty: none. With a URL, the kernel builds the request, this process posts it,
// and the token goes into the signature; give the layout "timestamp": true so the placeholder has room.
var tsaUrl = "";

var app = WebApplication.CreateBuilder(args).Build();

app.MapPost("/api/submissions/sign", async (JsonNode envelope, HttpContext http) =>
{
    var submission = envelope["submission"]!;
    var locale = (string?)submission["locale"] ?? "en";
    // The journey, if the answers came through one: the path is worked out again from the values (see JourneyOf).
    var context = JsonSerializer.Serialize(new { formId = form["id"], form = form["root"], values = submission["values"], locale, journey = JourneyOf(submission), optionSnapshot = new { countries } });
    var outcome = JsonNode.Parse(sandbox.Run(validate, context, 0.25, 32 * 1024 * 1024))!;
    if (outcome["errors"]!.AsArray().Count > 0)  // 422 with codes and fields, never text; the page's messages word them
    {
        var errors = outcome["errors"]!.AsArray().Select(e => new { field = (string?)e!["componentId"], code = (string?)e["code"] });
        return Results.Json(new { errors }, statusCode: 422);
    }
    // The record, rendered and prepared for signing in one call: the layout's signature settings
    // plus these certificates. The answer's "bytes" carry the placeholder; "signing" says what to sign.
    var signature = new Dictionary<string, object?> { ["certificates"] = certificates };
    if (certify is not null)
    {
        signature["certify"] = certify;
    }
    var prepared = Render(new Dictionary<string, object?>
    {
        ["abi"] = "4.0.0",
        ["op"] = "document",
        ["form"] = form["root"],
        ["pdf"] = form["pdf"],  // the sealed layout, as designed in the builder's PDF mode
        ["values"] = outcome["values"],
        ["locale"] = locale,
        ["optionSnapshot"] = new { country = countries },
        ["fonts"] = fonts,
        ["signature"] = signature,
        // The only time and identity the program ever sees; the signature's /M is this instant.
        ["env"] = new { createdAt = DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss'.000Z'"), documentId = Guid.NewGuid().ToString() }
    });
    if (!(bool)prepared["ok"]!)  // {"code": "signature" | "font" | "layout" | "internal", "message": ...}
    {
        return Results.Json(new { error = prepared["error"] }, statusCode: 500);
    }
    var handoff = prepared["signing"]!;
    var value = SignBytes(Convert.FromBase64String((string)handoff["toBeSigned"]!));
    var signing = new Dictionary<string, object?>
    {
        ["certificates"] = certificates,
        ["value"] = Convert.ToBase64String(value),
        ["toBeSignedDigest"] = (string)handoff["toBeSignedDigest"]!
    };
    if (tsaUrl != "")
    {
        signing["timestamp"] = new { token = await Timestamp(value) };
    }
    var completed = Render(new Dictionary<string, object?> { ["abi"] = "4.0.0", ["op"] = "complete", ["pdf"] = new { data = (string)prepared["bytes"]! }, ["signing"] = signing });
    if (!(bool)completed["ok"]!)
    {
        return Results.Json(new { error = completed["error"] }, statusCode: 500);
    }
    http.Response.Headers["X-Page-Count"] = ((int)prepared["pageCount"]!).ToString();
    http.Response.Headers["X-Signed-By"] = signer.SubjectName.Name;
    http.Response.Headers["X-Signature-Field"] = (string)completed["field"]!;
    http.Response.Headers["X-Timestamped"] = ((bool)completed["timestamped"]!).ToString().ToLowerInvariant();
    return Results.File(Convert.FromBase64String((string)completed["bytes"]!), "application/pdf", "customer-intake-signed.pdf");
});

// A signed PDF back for a verdict: which signatures it carries, whether each still matches the
// bytes, whether the value checks out under the signer's key, and whether the signer is this server.
app.MapPost("/api/submissions/verify", async (HttpRequest request) =>
{
    using var body = new MemoryStream();
    await request.Body.CopyToAsync(body);
    var report = Render(new Dictionary<string, object?> { ["abi"] = "4.0.0", ["op"] = "verify", ["pdf"] = new { data = Convert.ToBase64String(body.ToArray()) } });
    if (!(bool)report["ok"]!)
    {
        return Results.Json(new { error = report["error"] }, statusCode: 400);
    }
    var verdicts = report["signatures"]!.AsArray().Select(sig =>
    {
        var signer = sig!["signer"];
        var valid = signer is not null && VerifyBytes(Convert.FromBase64String((string)signer["publicKey"]!), Convert.FromBase64String((string)sig["toBeVerified"]!), Convert.FromBase64String((string)sig["signature"]!));
        return new
        {
            field = (string)sig["field"]!,
            signer = signer is null ? null : (string?)signer["subject"],
            signingTime = (string?)sig["signingTime"],
            digestMatches = (bool)sig["digestMatches"]!,  // the file still hashes to what was signed
            certificateMatches = (bool)sig["certificateMatches"]!,  // the signed attributes name this certificate
            signatureValid = valid,  // the value checks out under the signer's public key
            coversDocument = (bool)sig["coversDocument"]!,  // nothing was appended after this signature
            trusted = signer is not null && (string?)signer["certificate"] == certificates[0],  // the signer is this server
            certification = sig["certification"],
            timestamp = sig["timestamp"]
        };
    });
    // The files the signature sealed, by digest: what a record's JSON must hash to.
    return Results.Json(new { signatures = verdicts, attachments = report["attachments"] });
});

app.Run();

// The one cryptographic step this server keeps for itself: the DER attributes the kernel prepared,
// signed with the key. An HSM or a cloud KMS signs the same bytes (or "toBeSignedDigest", their SHA-256).
byte[] SignBytes(byte[] data)
{
    using var ecdsa = signer.GetECDsaPrivateKey();
    if (ecdsa is not null)
    {
        return ecdsa.SignData(data, HashAlgorithmName.SHA256, DSASignatureFormat.Rfc3279DerSequence);
    }
    using var rsa = signer.GetRSAPrivateKey()!;
    return rsa.SignData(data, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
}

bool VerifyBytes(byte[] spki, byte[] data, byte[] value)
{
    try
    {
        using var rsa = RSA.Create();
        rsa.ImportSubjectPublicKeyInfo(spki, out _);
        return rsa.VerifyData(data, value, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
    }
    catch (CryptographicException)
    {
        using var ecdsa = ECDsa.Create();
        ecdsa.ImportSubjectPublicKeyInfo(spki, out _);
        return ecdsa.VerifyData(data, value, HashAlgorithmName.SHA256, DSASignatureFormat.Rfc3279DerSequence);
    }
}

async Task<string> Timestamp(byte[] value)
{
    var tsq = Render(new Dictionary<string, object?> { ["abi"] = "4.0.0", ["op"] = "timestampRequest", ["signature"] = Convert.ToBase64String(value) });
    using var client = new HttpClient();
    var content = new ByteArrayContent(Convert.FromBase64String((string)tsq["request"]!));
    content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("application/timestamp-query");
    var response = await client.PostAsync(tsaUrl, content);
    response.EnsureSuccessStatusCode();
    return Convert.ToBase64String(await response.Content.ReadAsByteArrayAsync());
}

JsonNode Render(Dictionary<string, object?> request) =>
    JsonNode.Parse(sandbox.Run(render, JsonSerializer.Serialize(request), 15, 256 * 1024 * 1024))!;

/// <summary>A run that ended without an outcome: a limit cut it off, or a program or rule module would not load.</summary>
class SandboxException(string message) : Exception(message);

/// <summary>The engine, compiled once as the process starts, and one run of it per request.</summary>
class Sandbox
{
    readonly Engine engine = new(new Config().WithEpochInterruption(true));  // the time budget: a run past its deadline traps
    readonly Module qjs;
    readonly Linker linker;

    // The clock every budget is kept by, one for all the runs at once: a tick every 50 ms; a run's
    // deadline is its budget in ticks, plus one for the tick already under way when it started. The
    // epoch it advances is the engine's, shared by every store on it, so no run may bump it for
    // itself: a timer of the run's own, fired when its budget was spent, would advance the epoch under
    // every other run in flight too, and cut short one that had set its deadline a tick earlier — a
    // wrong verdict for a submission that was never judged. One clock, and no run can touch another.
    static readonly TimeSpan Tick = TimeSpan.FromSeconds(0.05);
    readonly Timer clock;

    // The file is checked before it is compiled: only the release this server names may run.
    const string QjsSha256 = "d2939e98c808e8b9f4164cd0d7b0398cbc0121ddf52862bcd92157d923e461cc";  // v0.16.2

    // What a run can reach: one directory holding the programs it is given, and nothing else — not
    // this directory, not the disk. Made as the server starts, removed as it stops.
    readonly string app;

    public Sandbox(params string[] programs)
    {
        var wasm = File.ReadAllBytes("qjs-wasi.wasm");
        if (Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(wasm)).ToLowerInvariant() != QjsSha256)
        {
            throw new InvalidOperationException("qjs-wasi.wasm is not the release this server names");
        }
        qjs = Module.FromBytes(engine, "qjs", wasm);
        app = Directory.CreateTempSubdirectory("datum-").FullName;
        foreach (var program in programs)
        {
            File.Copy(program, Path.Combine(app, program));
        }
        AppDomain.CurrentDomain.ProcessExit += (_, _) => Directory.Delete(app, recursive: true);
        linker = new Linker(engine);
        linker.DefineWasi();
        clock = new Timer(_ => engine.IncrementEpoch(), null, Tick, Tick);
    }

    public string Run(string[] argv, string request, double seconds, long memory)
    {
        // One run: the programs' directory mounted read-only as /app, the request on stdin, the
        // answer on stdout — all the run can reach; wasmtime hands it nothing else. The limits are
        // wasmtime's, at the browser's profile: the budget in seconds, the memory in bytes. Runaway
        // recursion exhausts the instance's own stack and traps, which ends the run too. WASI's
        // standard streams are files here: the request goes in as one, the answer comes back as one.
        var stdin = Path.GetTempFileName();
        var stdout = Path.GetTempFileName();
        var stderr = Path.GetTempFileName();
        try
        {
            File.WriteAllText(stdin, request);
            string[] args = ["qjs", "--std", .. argv];  // --std: the std module, which reads stdin
            using var store = new Store(engine);
            store.SetLimits(memorySize: memory);
            store.SetEpochDeadline((ulong)Math.Ceiling(seconds / Tick.TotalSeconds) + 1);
            store.SetWasiConfiguration(new WasiConfiguration()
                .WithArgs(args)
                .WithPreopenedDirectory(app, "/app", WasiDirectoryPermissions.Read, WasiFilePermissions.Read)
                .WithStandardInput(stdin)
                .WithStandardOutput(stdout)
                .WithStandardError(stderr));
            try
            {
                linker.Instantiate(store, qjs).GetFunction("_start")!.Invoke();
            }
            catch (WasmtimeException exit) when (exit.ExitCode is int code)  // a throw: qjs printed it to stderr and exited 1
            {
                if (code != 0)
                {
                    throw new SandboxException(File.ReadAllText(stderr).Trim());
                }
            }
            catch (TrapException trap)  // Interrupt: the budget; StackOverflow: the recursion
            {
                throw new SandboxException(trap.Type.ToString());
            }
            return File.ReadAllText(stdout).TrimEnd('\n');
        }
        finally
        {
            File.Delete(stdin);
            File.Delete(stdout);
            File.Delete(stderr);
        }
    }
}
