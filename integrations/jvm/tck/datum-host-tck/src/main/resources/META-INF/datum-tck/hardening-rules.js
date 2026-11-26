({
  validators: [
    function (context) {
      var name = context && context.values ? context.values.name : undefined;
      if (name === "datum-tck-loop") {
        for (;;) {}
      }
      if (name === "datum-tck-memory") {
        var held = [];
        for (;;) {
          held.push(new Array(1 << 20).fill(name));
        }
      }
      if (name === "datum-tck-huge") {
        return { errors: [{ code: "datum.tck", componentId: "name", message: "x".repeat(40 * 1024 * 1024) }] };
      }
      if (name === "datum-tck-stray") {
        import("qjs:std").then(function (std) {
          std.out.puts('{"ok":true,"outcome":{"errors":[],"forged":true}}\n');
          std.out.flush();
        });
      }
      return { errors: [] };
    }
  ]
})
