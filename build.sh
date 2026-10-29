#!/usr/bin/env bash
# Package the module into dist/<id>-<version>.zip with correct POSIX modes.
# zip(1) is not required: modes are written explicitly so the result is
# identical on any host (Linux, macOS, WSL, CI).
set -euo pipefail

ROOT=$(cd "$(dirname "$0")" && pwd)
MOD="$ROOT/module"
DIST="$ROOT/dist"

[ -f "$MOD/module.prop" ] || { echo "error: module/module.prop not found" >&2; exit 1; }
ID=$(sed -n 's/^id=//p'          "$MOD/module.prop" | tail -1)
VER=$(sed -n 's/^version=//p'    "$MOD/module.prop" | tail -1)
[ -n "$ID" ] && [ -n "$VER" ] || { echo "error: id/version missing in module.prop" >&2; exit 1; }

OUT="$DIST/$ID-$VER.zip"
mkdir -p "$DIST"

# index.html references diag.js for development, and the packaged copy inlines
# it: the WebView loads the page from an internal path where <script src>
# resolution has been unreliable. The substitution happens on a staged copy, so
# the build never rewrites a tracked file (the old version inlined in place,
# which is why the repository carried a second, 445-line copy of diag.js).
STAGE=$(mktemp -d 2>/dev/null || echo "$DIST/.stage.$$")
trap 'rm -rf "$STAGE"' EXIT
cp -a "$MOD/." "$STAGE/"
python3 - "$STAGE/webroot/index.html" "$STAGE/webroot/diag.js" << 'PYINLINE'
import pathlib, sys
idx, src = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
s = idx.read_text()
tag = '<script src="diag.js"></script>'
if tag not in s:
    sys.exit("error: index.html is missing the diag.js script tag")
s = s.replace(tag, "<script>\n" + src.read_text() + "\n</script>", 1)
idx.write_text(s)
PYINLINE
# The packaged page must not reference an external script.
if grep -q '<script src=' "$STAGE/webroot/index.html"; then
  echo "error: staged index.html still references an external script" >&2; exit 1
fi

python3 - "$STAGE" "$OUT" << 'PY'
import stat, sys, zipfile, pathlib

src, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])

# Executables must keep 0755; data files must be 0644.
EXEC = {
    "post-fs-data.sh", "action.sh",
    "uninstall.sh", "customize.sh", "manager.sh", "diagnose.sh", "probe.sh",
    "capacity.sh", "collect.sh",
}
# Runtime artifacts never ship, and neither does the page's source copy: the
# packaged index.html already contains it.
SKIP = {"manager.log", "mount.log", "service.log", "diag.js"}

with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for p in sorted(src.rglob("*")):
        if p.is_dir() or p.name in SKIP:
            continue
        rel = p.relative_to(src).as_posix()
        mode = 0o755 if p.name in EXEC else 0o644
        zi = zipfile.ZipInfo(rel, date_time=(1980, 1, 1, 0, 0, 0))
        zi.compress_type = zipfile.ZIP_DEFLATED
        zi.external_attr = (stat.S_IFREG | mode) << 16
        zi.create_system = 3          # unix, so unzip honours the mode bits
        z.writestr(zi, p.read_bytes())
print(f"built {out}")
PY

echo "sha256: $(sha256sum "$OUT" | cut -d' ' -f1)"
