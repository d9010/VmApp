// Todo: the core of a vmapp sample app, written in C# against the bridge protocol (SPEC section 6) directly.
//
// The app is a server on $VMAPP_SOCKET: the host's bridge connection arrives through the guest's vsock port 1024.
// Messages are JSON lines with "t" as the type.
//
//   host -> init                    we load /data/todos.json, answer {"t":"ready"} and ask for a window
//   host -> invoke todo:*           list / add / toggle / delete / clear-completed; each change is saved, emitted to the
//                                   window as "changed" (the whole list) and shown in the window title
//   host -> window closed           Environment.Exit(0): the VM is the app

using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

var socketPath = Environment.GetEnvironmentVariable("VMAPP_SOCKET")
    ?? throw new InvalidOperationException("VMAPP_SOCKET is not set");
if (File.Exists(socketPath)) File.Delete(socketPath);

using var listener = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
listener.Bind(new UnixDomainSocketEndPoint(socketPath));
listener.Listen(1);
using var client = listener.Accept(); // one connection per app run
using var stream = new NetworkStream(client);

var bridge = new Bridge(stream);
var todos = new TodoStore(Environment.GetEnvironmentVariable("VMAPP_DATA") ?? "/data");

using var reader = new StreamReader(stream, new UTF8Encoding(false));
string? line;
while ((line = reader.ReadLine()) != null)
{
    if (line.Length == 0) continue;
    JsonNode? msg;
    try { msg = JsonNode.Parse(line); }
    catch (JsonException) { bridge.Log("warn", "ignoring a malformed bridge line"); continue; }
    if (msg is not JsonObject obj) continue;

    switch ((string?)obj["t"])
    {
        case "init":
            todos.Load();
            bridge.Send(new JsonObject { ["t"] = "ready" });
            // a request blocks until its reply arrives, and replies arrive on this loop: never await it here
            _ = Task.Run(() => bridge.OpenWindow(todos));
            break;
        case "invoke":
            _ = Task.Run(() => bridge.HandleInvoke(obj, todos));
            break;
        case "reply":
            bridge.CompleteRequest(obj);
            break;
        case "window":
            if ((string?)obj["event"] == "closed")
            {
                // the only window is gone: quit like Electron's default. The reply to app.quit arrives on this loop,
                // so wait for it elsewhere (at most 1 s), then exit: the VM is the app.
                _ = Task.Run(async () =>
                {
                    await Task.WhenAny(bridge.Request("app.quit", new JsonObject()), Task.Delay(1000));
                    Environment.Exit(0);
                });
            }
            break;
        case "before-quit":
            Environment.Exit(0);
            break;
    }
}
Environment.Exit(0); // the host closed the connection

// ------------------------------------------------------------------------------------------------

record TodoItem(long Id, string Text, bool Done);

class TodoStore
{
    static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, WriteIndented = true };

    readonly string file;
    readonly object gate = new();
    List<TodoItem> items = new();

    public TodoStore(string dataDir) => file = Path.Combine(dataDir, "todos.json");

    public void Load()
    {
        lock (gate)
        {
            try { items = JsonSerializer.Deserialize<List<TodoItem>>(File.ReadAllText(file), Json) ?? new(); }
            catch (Exception) { items = new(); } // first run, or an unreadable file: start empty
        }
    }

    void Save()
    {
        var tmp = file + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(items, Json));
        File.Move(tmp, file, overwrite: true);
    }

    public List<TodoItem> Snapshot() { lock (gate) return new List<TodoItem>(items); }

    public int OpenCount() { lock (gate) return items.Count(t => !t.Done); }

    public List<TodoItem> Mutate(Action<List<TodoItem>> change)
    {
        lock (gate)
        {
            change(items);
            Save();
            return new List<TodoItem>(items);
        }
    }

    public long NextId() { lock (gate) return items.Count == 0 ? 1 : items.Max(t => t.Id) + 1; }
}

class Bridge
{
    static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    readonly Stream stream;
    readonly object writeLock = new();
    readonly Dictionary<long, TaskCompletionSource<JsonNode?>> pending = new();
    long nextId = 1;
    long win = -1;

    public Bridge(Stream stream) => this.stream = stream;

    public void Send(JsonObject message)
    {
        var bytes = Encoding.UTF8.GetBytes(message.ToJsonString() + "\n");
        lock (writeLock)
        {
            try { stream.Write(bytes, 0, bytes.Length); stream.Flush(); }
            catch (IOException) { /* the host is gone */ }
        }
    }

    public void Log(string level, string text) =>
        Send(new JsonObject { ["t"] = "log", ["level"] = level, ["message"] = text });

    public async Task<JsonNode?> Request(string op, JsonObject args)
    {
        var tcs = new TaskCompletionSource<JsonNode?>(TaskCreationOptions.RunContinuationsAsynchronously);
        long id;
        lock (pending) { id = nextId++; pending[id] = tcs; }
        Send(new JsonObject { ["t"] = "request", ["id"] = id, ["op"] = op, ["params"] = args });
        return await tcs.Task;
    }

    public void CompleteRequest(JsonObject reply)
    {
        var id = (long?)reply["id"] ?? 0;
        TaskCompletionSource<JsonNode?>? tcs;
        lock (pending) { pending.Remove(id, out tcs); }
        if (tcs == null) return;
        if (reply["error"] is JsonObject err) tcs.SetException(new Exception((string?)err["message"] ?? "request failed"));
        else tcs.SetResult(reply["result"]?.DeepClone());
    }

    static string TitleFor(int open) => open == 1 ? "1 open task" : $"{open} open tasks";

    public async Task OpenWindow(TodoStore todos)
    {
        try
        {
            var result = await Request("window.create", new JsonObject
            {
                ["entry"] = "index.html", ["width"] = 520, ["height"] = 680, ["minWidth"] = 380, ["minHeight"] = 400,
                ["title"] = TitleFor(todos.OpenCount()),
            });
            Interlocked.Exchange(ref win, (long?)result?["win"] ?? -1);
        }
        catch (Exception e)
        {
            Log("error", "window.create failed: " + e.Message);
            Environment.Exit(1);
        }
    }

    void Changed(TodoStore todos)
    {
        var w = Interlocked.Read(ref win);
        if (w < 0) return;
        var list = todos.Snapshot(); // always the latest list, even when two changes race
        Send(new JsonObject
        {
            ["t"] = "emit", ["win"] = w, ["channel"] = "changed",
            ["args"] = new JsonArray(JsonSerializer.SerializeToNode(list, Json)),
        });
        // fire and forget: the reply is dropped
        _ = Request("window.setTitle", new JsonObject { ["win"] = w, ["title"] = TitleFor(list.Count(t => !t.Done)) });
    }

    public void HandleInvoke(JsonObject msg, TodoStore todos)
    {
        var id = msg["id"]?.DeepClone();
        var args = msg["args"] as JsonArray ?? new JsonArray();
        try
        {
            List<TodoItem> list;
            switch ((string?)msg["channel"])
            {
                case "todo:list":
                    list = todos.Snapshot();
                    Reply(id, list);
                    return;
                case "todo:add":
                {
                    var text = ((string?)args.ElementAtOrDefault(0))?.Trim() ?? "";
                    if (text.Length == 0) throw new Exception("Type something to add");
                    if (text.Length > 500) throw new Exception("That task is too long (500 characters at most)");
                    var newId = todos.NextId();
                    list = todos.Mutate(l => l.Add(new TodoItem(newId, text, false)));
                    break;
                }
                case "todo:toggle":
                {
                    var tid = (long?)args.ElementAtOrDefault(0) ?? -1;
                    list = todos.Mutate(l =>
                    {
                        var i = l.FindIndex(t => t.Id == tid);
                        if (i < 0) throw new Exception("No such task");
                        l[i] = l[i] with { Done = !l[i].Done };
                    });
                    break;
                }
                case "todo:delete":
                {
                    var tid = (long?)args.ElementAtOrDefault(0) ?? -1;
                    list = todos.Mutate(l => { if (l.RemoveAll(t => t.Id == tid) == 0) throw new Exception("No such task"); });
                    break;
                }
                case "todo:clear-completed":
                    list = todos.Mutate(l => l.RemoveAll(t => t.Done));
                    break;
                default:
                    throw new Exception($"No handler registered for '{(string?)msg["channel"]}'");
            }
            Reply(id, list);
            Changed(todos);
        }
        catch (Exception e)
        {
            Send(new JsonObject { ["t"] = "result", ["id"] = id, ["error"] = new JsonObject { ["message"] = e.Message } });
        }
    }

    void Reply(JsonNode? id, List<TodoItem> list) =>
        Send(new JsonObject { ["t"] = "result", ["id"] = id, ["result"] = JsonSerializer.SerializeToNode(list, Json) });
}
