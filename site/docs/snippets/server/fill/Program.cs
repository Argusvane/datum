// Program.cs — the endpoint the page delivers to: the submission validated, then written into an existing PDF form.
//   intake.csproj beside it: ASP.NET Core, and Wasmtime, the .NET embedding of wasmtime.
//   curl -LO https://github.com/quickjs-ng/quickjs/releases/download/v0.16.2/qjs-wasi.wasm
//   dotnet run
//
// The PDF is one this server already has (templates/customer-intake.pdf): an AcroForm whose fields the
// form's template layout maps to the answers. datum-sandbox-program.js re-validates the envelope
// (see Validate on the server) and datum-pdf-program.js fills the PDF — the kernel behind the
// browser's PDF button, in a QuickJS of this process's own: QuickJS-ng's WebAssembly build, under
// wasmtime. Nothing about PDFs is written here.
using System.Text.Json;
using System.Text.Json.Nodes;
using Wasmtime;

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

// The template layout, as the builder's PDF mode authored it: the PDF's fields and
// what fills each — a component's answer, an option's label through template text, a literal.
var layout = form["pdf"]!["layouts"]!.AsArray().First(layout => (string?)layout!["id"] == "intake-template")!;

// The PDF itself, from this server's disk. The layout's template source names it (a storage this
// server resolves, not bytes in the definition), and the bytes ride with each request, base64.
var template = Convert.ToBase64String(File.ReadAllBytes("templates/customer-intake.pdf"));

// Validation first, so the PDF is filled with the sanitized values: what the form defines, nothing else.
string[] validate = ["-I", "/app/datum-sandbox-program.js", "-e", "print(__datum_run(std.in.readAsString()));"];

// The PDF program, under the document profile; __datum_pdf's promise settles before qjs exits.
string[] render = ["-I", "/app/datum-pdf-program.js", "-e", "__datum_pdf(std.in.readAsString()).then((json) => print(json));"];

// The fonts the kernel draws the filled fields with when the standard 14 cannot show an answer.
static object Font(string id, string family, int weight, string file) =>
    new { id, family, weight, style = "normal", data = Convert.ToBase64String(File.ReadAllBytes(Path.Combine("fonts", file))) };

object[] fonts = [Font("dejavu-sans", "sans-serif", 400, "DejaVuSans.ttf"), Font("dejavu-sans-bold", "sans-serif", 700, "DejaVuSans-Bold.ttf")];

// What the Country select shows, resolved here: the layout's "{{country}}" writes the option's label.
object[] countries = [new { value = "CA", label = "Canada" }, new { value = "US", label = "United States" }, new { value = "MX", label = "Mexico" }];

// What becomes of the filled fields. "editable" leaves them fields a reader may still change;
// "readonly" locks each one the fill touched; "flatten" burns the values into the page and drops
// the fields — an archive copy. The layout's own options are set here, per server.
var fields = "editable";

var app = WebApplication.CreateBuilder(args).Build();
var log = app.Services.GetRequiredService<ILoggerFactory>().CreateLogger("datum.fill");

app.MapPost("/api/submissions/fill", (JsonNode envelope, HttpContext http) =>
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
    // The template layout, inline, with this server's fill options: this server's choice, so no
    // layout's "when" is tried, and the bytes below are that layout's.
    var filled = layout.DeepClone();
    filled["options"] = new JsonObject { ["flatten"] = fields == "flatten", ["readOnly"] = fields == "readonly", ["appearances"] = "regenerate" };
    var response = Render(new Dictionary<string, object?>
    {
        ["abi"] = "4.0.0",
        ["op"] = "document",
        ["form"] = form["root"],
        ["layout"] = filled,
        // The PDF to fill: the bytes the layout's source names, resolved by this server.
        ["template"] = new { data = template },
        ["values"] = outcome["values"],
        ["locale"] = locale,  // the language template texts resolve in: the country's name, here
        ["optionSnapshot"] = new { country = countries },
        ["fonts"] = fonts,
        // The only time and identity the program ever sees: the same request gives the same bytes.
        ["env"] = new { createdAt = DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss'.000Z'"), documentId = Guid.NewGuid().ToString() }
    });
    if (!(bool)response["ok"]!)  // {"code": "template" | "font" | "internal", "message": ...}
    {
        return Results.Json(new { error = response["error"] }, statusCode: 500);
    }
    // The fill report, one entry per mapped field: filled; cleared (no answer, or one a rule hid);
    // missing (the PDF has no field of that name); unsupported (a kind the kernel cannot fill).
    foreach (var field in response["fields"]!.AsArray())
    {
        log.LogInformation("{Status} {Field} ({Kind})", (string?)field!["status"], (string?)field["pdfField"], (string?)field["kind"] ?? "-");
    }
    http.Response.Headers["X-Page-Count"] = ((int)response["pageCount"]!).ToString();
    return Results.File(Convert.FromBase64String((string)response["bytes"]!), "application/pdf", "customer-intake-filled.pdf");
});

app.Run();

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
