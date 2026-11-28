// Program.cs — the endpoint the page delivers to: the submission validated, then rendered as a PDF.
//   intake.csproj beside it: ASP.NET Core, and Wasmtime, the .NET embedding of wasmtime.
//   curl -LO https://github.com/quickjs-ng/quickjs/releases/download/v0.16.2/qjs-wasi.wasm
//   dotnet run
//
// Two programs from beside the bundles, each run in a QuickJS of this process's own — QuickJS-ng's
// WebAssembly build, under wasmtime. datum-sandbox-program.js re-validates the envelope (see
// Validate on the server), and datum-pdf-program.js is the PDF kernel behind the browser's PDF
// button: the form's PDF layout laid out over the answers, the fonts embedded, the bytes written.
// The same program on any host, so the server's PDF is the browser's, byte for byte.
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

// Validation first, so the PDF prints the sanitized values: what the form defines, nothing else.
// Rules of the page's own register into this program too (see Validate on the server).
string[] validate = ["-I", "/app/datum-sandbox-program.js", "-e", "print(__datum_run(std.in.readAsString()));"];

// The PDF program, under the document profile: a PDF takes seconds and real memory. __datum_pdf
// answers with a promise; qjs runs the pending jobs once the script has run (the program's only
// timers are microtasks), so the answer is printed before it exits.
string[] render = ["-I", "/app/datum-pdf-program.js", "-e", "__datum_pdf(std.in.readAsString()).then((json) => print(json));"];

// The fonts to embed, read from beside the bundles: the program has no file system. DejaVu Sans
// covers Latin, Greek, Cyrillic, Arabic and Hebrew; with no fonts, the standard 14 stand in.
static object Font(string id, string family, int weight, string file) =>
    new { id, family, weight, style = "normal", data = Convert.ToBase64String(File.ReadAllBytes(Path.Combine("fonts", file))) };

object[] fonts = [Font("dejavu-sans", "sans-serif", 400, "DejaVuSans.ttf"), Font("dejavu-sans-bold", "sans-serif", 700, "DejaVuSans-Bold.ttf")];

// What the Country select shows, resolved here: the program never fetches a data source.
object[] countries = [new { value = "CA", label = "Canada" }, new { value = "US", label = "United States" }, new { value = "MX", label = "Mexico" }];

string? pdfLocale = null;  // null renders in the submission's language; "en" or "fr-CA" picks one
var compact = false;  // object streams and a compressed cross-reference: smaller, slower to write

// Which of the form's PDF layouts prints. A form designed in the builder's PDF mode may
// carry several under the form's "pdf" block — an applicant copy, an internal summary, a government
// template to fill — each with an id. Name one here, e.g. "applicant-copy", and the request asks
// for it by id ("layoutId" below), whatever the answers. null leaves the choice to the form: the
// first layout, in its list's order, whose "when" holds on these validated values — the layout the
// person's own download printed — else its "defaultLayoutId", the one marked default in the
// builder, else the first layout declared; a form with no layouts at all gets one derived from its
// tree, as this sample does. The response names the layout that printed ("layoutId"). An
// id the form lacks derives one too, with a "layout.notFound" warning in the response. A template
// layout whose PDF this server keeps needs its bytes in the request, and the answers may choose
// another template than the default: ask the "build" op first and send its "layoutId" back with
// that layout's bytes. One submission, several PDFs: render once per id. A request may instead
// carry a whole layout object under "layout" — one kept outside the form — which then prints
// whatever the form declares, and whatever the answers.
string? layoutId = null;

var app = WebApplication.CreateBuilder(args).Build();

app.MapPost("/api/submissions/pdf", (JsonNode envelope, HttpContext http) =>
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
    var request = new Dictionary<string, object?>
    {
        ["abi"] = "1.0.0",
        ["op"] = "document",
        ["form"] = form["root"],
        ["pdf"] = form["pdf"],  // the form's PDF layouts, as designed in the builder's PDF mode
        ["values"] = outcome["values"],
        ["locale"] = pdfLocale ?? locale,
        ["optionSnapshot"] = new { country = countries },
        ["fonts"] = fonts,
        ["options"] = new { compact },
        // The only time and identity the program ever sees: the same request gives the same bytes.
        ["env"] = new { createdAt = DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss'.000Z'"), documentId = Guid.NewGuid().ToString() }
    };
    if (layoutId != null)  // a specific layout by id, whatever the answers; left out, the answers choose (see layoutId)
    {
        request["layoutId"] = layoutId;
    }
    var response = Render(request);
    if (!(bool)response["ok"]!)  // {"code": "font" | "layout" | "template" | "internal", "message": ...}
    {
        return Results.Json(new { error = response["error"] }, statusCode: 500);
    }
    http.Response.Headers["X-Page-Count"] = ((int)response["pageCount"]!).ToString();
    return Results.File(Convert.FromBase64String((string)response["bytes"]!), "application/pdf", "customer-intake.pdf");
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
