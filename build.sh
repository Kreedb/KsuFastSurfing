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

python3 - "$MOD" "$OUT" << 'PY'
import stat, sys, zipfile, pathlib

src, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])

# Executables must keep 0755; data files must be 0644.
EXEC = {
    "post-fs-data.sh", "service.sh", "action.sh",
    "uninstall.sh", "customize.sh", "manager.sh", "diagnose.sh", "probe.sh", "wifidiag.sh",
}
# Runtime artifacts never ship.
SKIP = {"manager.log", "mount.log", "service.log"}

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
