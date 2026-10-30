#!/usr/bin/env bash
# Test, then package the module into dist/<id>-<version>.zip.
#
# The build refuses to produce a zip that has not passed the suites: a module
# that installs but lies about the device is worse than no module. Pass
# --no-test only when you are iterating on packaging itself.
#
# zip(1) is not required: modes are written explicitly so the result is
# identical on any host (Linux, macOS, WSL, CI).
set -euo pipefail

ROOT=$(cd "$(dirname "$0")" && pwd)
MOD="$ROOT/module"
DIST="$ROOT/dist"
SKIP_TEST=0
[ "${1:-}" = "--no-test" ] && SKIP_TEST=1

die() { echo "error: $*" >&2; exit 1; }

# --- metadata ---------------------------------------------------------------
[ -f "$MOD/module.prop" ] || die "module/module.prop not found"
ID=$(sed -n 's/^id=//p'       "$MOD/module.prop" | tail -1)
VER=$(sed -n 's/^version=//p' "$MOD/module.prop" | tail -1)
[ -n "$ID" ] && [ -n "$VER" ] || die "id/version missing in module.prop"

case "$ID" in
  [A-Za-z]*) ;;
  *) die "module id must start with a letter" ;;
esac
for k in id name version versionCode author description; do
  grep -q "^$k=" "$MOD/module.prop" || die "missing $k in module.prop"
done

# --- repository invariants --------------------------------------------------
# The module is WebUI-only. These six were removed once and must not come back;
# a shell entry point on the device is exactly what this rewrite got rid of.
for f in manager.sh collect.sh probe.sh diagnose.sh capacity.sh action.sh; do
  [ ! -e "$MOD/$f" ] || die "module/$f must not exist (WebUI drives everything)"
done
if grep -n "MODDIR + '/" "$MOD"/webroot/index.html "$MOD"/webroot/diag.js | grep -q '\.sh'; then
  die "the page must not execute a module script"
fi

# --- shell syntax -----------------------------------------------------------
# dash is the closest portable stand-in for Android's busybox ash and is on
# every runner and dev box; busybox-static is not worth an apt round trip.
for f in "$MOD"/*.sh "$0"; do
  dash -n "$f" || die "syntax error in ${f#$ROOT/}"
done

# --- behaviour --------------------------------------------------------------
[ "$SKIP_TEST" = 1 ] || node "$ROOT/tests/run.js" || die "tests failed; nothing was packaged"

# --- stage and inline -------------------------------------------------------
# index.html references diag.js for development and the packaged copy inlines
# it: the WebView loads the page from an internal path where <script src>
# resolution has been unreliable. The substitution happens on a staged copy, so
# the build never rewrites a tracked file.
mkdir -p "$DIST"
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
cp -a "$MOD/." "$STAGE/"

python3 - "$STAGE" << 'PY'
import pathlib, sys
web = pathlib.Path(sys.argv[1]) / "webroot"
idx, src = web / "index.html", web / "diag.js"
tag = '<script src="diag.js"></script>'
# Explicit UTF-8: the page and the data layer are UTF-8, and a build that
# depends on the host's locale would silently produce mojibake on a machine
# whose LANG is C or a legacy codepage.
text = idx.read_text(encoding="utf-8")
if tag not in text:
    sys.exit("error: index.html is missing the diag.js script tag")
idx.write_text(text.replace(tag, "<script>\n" + src.read_text(encoding="utf-8") + "\n</script>", 1),
               encoding="utf-8")
PY

grep -q '<script src=' "$STAGE/webroot/index.html" &&
  die "staged index.html still references an external script"

# --- package ----------------------------------------------------------------
OUT="$DIST/$ID-$VER.zip"
python3 - "$STAGE" "$OUT" << 'PY'
import pathlib, stat, sys, zipfile

src, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])

# Only the three lifecycle hooks are shell. Everything that measures or changes
# state runs from the page, so there is no manager/collect/probe script to ship.
EXEC = {"post-fs-data.sh", "uninstall.sh", "customize.sh"}
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
PY

# --- verify the artifact, not the staging area ------------------------------
IN_ZIP=$(python3 - "$OUT" << 'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    names = z.namelist()
    page = z.read("webroot/index.html").decode("utf-8")
    bad = []
    if "webroot/diag.js" in names:
        bad.append("diag.js is packaged twice")
    if "<script src=" in page:
        bad.append("index.html still references an external script")
    need = ["parseScan", "parseLink", "analyse", "scoreChannels", "measure",
            "mergeHosts", "countHosts", "parseNet", "render", "parseEcho",
            "prefixToMask", "parseAddr", "parseRoutes", "deviceCode",
            "echoLookup", "shRaw", "b64bytes", "rssiBand", "parseCC"]
    for fn in need:
        if ("function " + fn) not in page and ("async function " + fn) not in page:
            bad.append("missing " + fn)
    print("%d files" % len(names))
    if bad:
        print("error: " + "; ".join(bad), file=sys.stderr)
        sys.exit(1)
PY
) || die "packaged page failed verification"

echo "built $OUT ($IN_ZIP)"
echo "sha256: $(sha256sum "$OUT" | cut -d' ' -f1)"