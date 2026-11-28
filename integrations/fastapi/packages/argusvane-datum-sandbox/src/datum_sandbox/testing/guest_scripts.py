"""The JavaScript the runtime contract runs as `run.js`: what the guest can see, reach and write under `/app`."""

import json
from typing import Final

APP_VIEW: Final = """\
var exists = function (path) { var f = std.open(path, 'r'); if (f) { f.close(); return true; } return false; };
print(JSON.stringify([exists('/app/program.js'), exists('/app/run.js')]));
print(JSON.stringify([exists('/etc/passwd'), exists('/app/../etc/passwd'), exists('/'),
  exists('/app/datum-pdf-program.js'), exists('/tmp')]));
print(JSON.stringify(std.getenviron()));
print(JSON.stringify(scriptArgs));
var listed = os.readdir('/app');
print(JSON.stringify(listed[0].filter(function (n) { return n !== '.' && n !== '..'; }).sort()));
print(std.loadFile('/app/program.js'));
"""
"""Print what `/app` holds: the two files, nothing outside, no environment, the arguments, the listing, the program."""

NO_WRITE: Final = """\
var r = [];
r.push(std.open('/app/big', 'w') === null);
r.push(std.open('/app/run.js', 'a') === null);
r.push(std.open('/app/run.js', 'r+') === null);
r.push(std.open('/app/run.js', 'w') === null);
r.push(os.mkdir('/app/d') < 0);
r.push(os.remove('/app/run.js') < 0);
r.push(os.rename('/app/run.js', '/app/moved.js') < 0);
r.push(typeof os.symlink !== 'function' || os.symlink('/app/run.js', '/app/link') < 0);
r.push(typeof os.utimes !== 'function' || os.utimes('/app/run.js', 0, 0) < 0);
var w = std.open('/app/run.js', 'r'); w.puts('overwritten'); w.flush(); w.close();
print(JSON.stringify(r));
var tried = 0, made = 0, long = 'a'.repeat(200000);
while (tried < 2000) { if (os.mkdir('/app/' + long + tried) === 0) { made++; } tried++; }
print(JSON.stringify([tried > 0, made]));
print(std.loadFile('/app/run.js').indexOf('var r = [];') === 0);
var wr = function (p) { var f = std.open(p, 'w'); if (f) { f.puts('x'); f.close(); return true; } return false; };
print(JSON.stringify([wr('/x'), wr('/tmp/x'), wr('/app/../x'), wr('/app/../stdin'), wr('../stdin'),
  os.mkdir('/d') === 0]));
print(std.open('/app/../stdin', 'r') === null);
"""
"""Try every way to create, change or remove something in `/app`, then a name bomb; print what succeeded."""


def reach_outside(host_path: str) -> str:
    """Return the script that tries every route to the host file at `host_path` (a module the guest could run)."""
    quoted = json.dumps(host_path)
    parent = json.dumps("/app/.." + host_path)
    dots = json.dumps("../../../../../../../.." + host_path)
    file_url = json.dumps("file://" + host_path)
    return f"""\
var opens = function (path) {{ var f = std.open(path, 'r'); if (f) {{ f.close(); return true; }} return false; }};
print(JSON.stringify([opens({quoted}), opens({parent}), opens({dots}), std.loadFile({quoted}) !== null,
  opens('../run.js')]));
var linked = typeof os.symlink === 'function' ? os.symlink({quoted}, '/app/link') : -1;
print(JSON.stringify([linked < 0, opens('/app/link'),
  typeof os.readlink === 'function' ? os.readlink('/app/run.js')[1] !== 0 : true]));
var tried = [{quoted}, {parent}, {dots}, {file_url}, '/etc/hosts', '../../etc/hosts'];
Promise.allSettled(tried.map(function (p) {{ return import(p); }})).then(function (r) {{
  print(JSON.stringify(r.map(function (x) {{ return x.status; }})));
  print(JSON.stringify(r.map(function (x) {{
    return x.status === 'rejected' && /SyntaxError/.test(String(x.reason));
  }})));
}});
"""
