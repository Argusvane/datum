// Program.cs — the endpoint the page delivers to.
//   intake.csproj beside it: ASP.NET Core, and Wasmtime, the .NET embedding of wasmtime.
//   curl -LO https://github.com/quickjs-ng/quickjs/releases/download/v0.16.2/qjs-wasi.wasm
//   dotnet run
//
// The submission is re-validated in the very program the browser's sandbox runs
// (datum-sandbox-program.js, written beside the bundles), in a QuickJS of this process's own —
// QuickJS-ng's WebAssembly build, run by wasmtime: the same kernel over the same schema, the
// same rules, so the same verdict — codes and fields, never text — and the same sanitized
// values. Nothing is re-implemented here; nothing the page did is trusted either.
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
var sandbox = new Sandbox("datum-sandbox-program.js");

// What one run evaluates: the program, the page's rules registered into it, then the call — the
// context from stdin, the outcome to stdout. The program itself disables Date and Math.random.
var rules = File.ReadAllText("rules/intake-rules.js");
string[] validate = ["-I", "/app/datum-sandbox-program.js", "-e", "__datum_register(" + rules + "); print(__datum_run(std.in.readAsString()));"];

// What the rules read beside the values. The page injected a copy of its own; the server has the say.
string[] phoneCountries = ["CA", "US"];

// What the Country select shows, resolved here: the program never fetches a data source. An answer to a
// choice whose source is missing from the optionSnapshot below is refused (option.sourceUnavailable).
object[] countries = [new { value = "CA", label = "Canada" }, new { value = "US", label = "United States" }, new { value = "MX", label = "Mexico" }];

// The run log comes back with the outcome — the sandbox has no console — and goes to this
// process's logger: what the kernel did, step by step, and what the rules said, at logLevel.
var logLevel = "debug";  // "off", "error", "warn" (the kernel's default), "info" or "debug"
var levels = new Dictionary<string, LogLevel> { ["debug"] = LogLevel.Debug, ["info"] = LogLevel.Information, ["warn"] = LogLevel.Warning, ["error"] = LogLevel.Error };

var builder = WebApplication.CreateBuilder(args);
builder.Logging.AddFilter("datum", LogLevel.Debug);  // so the forwarded entries reach the console
var app = builder.Build();
var log = app.Services.GetRequiredService<ILoggerFactory>().CreateLogger("datum.sandbox");

app.MapPost("/api/submissions", (JsonNode body) =>
{
    var key = body["submissionKey"] is JsonValue keyValue && keyValue.TryGetValue<string>(out var text) ? text : null;  // one per attempt: the same key again is the same submission
    if (string.IsNullOrWhiteSpace(key))  // without it a retry could not be told from a new submission
    {
        return Results.Json(new { errors = new[] { new { code = "bad_document" } } }, statusCode: 400);
    }
    var submission = body["document"]!["submission"]!;
    var context = JsonSerializer.Serialize(new
    {
        formId = form["id"],
        form = form["root"],  // the schema: field constraints and sanitization come from it
        values = submission["values"],
        locale = (string?)submission["locale"] ?? "en",
        externalData = new { phoneCountries },
        optionSnapshot = new { countries },  // the lists a choice's data source holds, by source id
        journey = JourneyOf(submission),  // the path, worked out again from the values (see JourneyOf)
        logLevel
    });
    JsonNode outcome;
    try
    {
        outcome = JsonNode.Parse(sandbox.Run(validate, context, 0.25, 32 * 1024 * 1024))!;
    }
    catch (SandboxException failure)  // a limit cut the run off, or a program or rule module would not load: fail closed, as the browser does
    {
        log.LogError(failure, "sandbox failed for {Form}", (string?)form["id"]);
        return Results.Json(new { errors = new[] { new { code = "wasm.execution_error" } } }, statusCode: 503);
    }
    foreach (var entry in outcome["logs"]?.AsArray() ?? [])
    {
        log.Log(levels[(string)entry!["level"]!], "{Message} {Data}", (string?)entry["message"], entry["data"]?.ToJsonString() ?? "");
    }
    if (outcome["errors"]!.AsArray().Count > 0)
    {
        // 422 with the error contract, as the browser would have seen it; the page's messages word it.
        var errors = outcome["errors"]!.AsArray().Select(e => new { field = (string?)e!["componentId"], code = (string?)e["code"] });
        return Results.Json(new { errors }, statusCode: 422);
    }
    Store(key, outcome["values"]!);  // the sanitized values: what the form defines, nothing else
    return Results.Ok(new { ok = true });
});

app.Run();

static void Store(string key, JsonNode values)
{
    // wherever submissions go: one record per key: the same key with the same values is that record again; the same key with other values is refused (409 submission.keyConflict)
}

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
