#!/bin/sh
# Builds release archives in dist/:
#   web-sdr-radio-sync-<version>.zip        whole project (extension + Hamlib helper), for GitHub releases
#   web-sdr-radio-sync-<version>-store.zip  extension only, without the manifest "key", for the Chrome Web Store
set -eu
cd "$(dirname "$0")"
exec python3 -I - <<'PY'
import json, os, zipfile

EXT = ["manifest.json", "background.js", "panel.html", "panel.css", "panel.js",
       "pick-port.html", "pick-port.js", "content", "rigs", "icons"]
EXTRA = ["native", "README.md", "LICENSE"]

manifest = json.load(open("manifest.json"))
name = f"web-sdr-radio-sync-{manifest['version']}"
os.makedirs("dist", exist_ok=True)

def files(paths):
    for p in paths:
        if os.path.isfile(p):
            yield p
        elif os.path.isdir(p):
            for root, dirs, fs in os.walk(p):
                dirs[:] = sorted(d for d in dirs if d != "__pycache__")
                for f in sorted(fs):
                    if not f.endswith(".pyc"):
                        yield os.path.join(root, f)

def add(z, path, arcname, data=None):
    info = zipfile.ZipInfo(arcname, date_time=(2026, 1, 1, 0, 0, 0))
    mode = os.stat(path).st_mode if data is None else 0o644
    info.external_attr = ((mode & 0o777) | 0o100000) << 16
    info.compress_type = zipfile.ZIP_DEFLATED
    z.writestr(info, open(path, "rb").read() if data is None else data)

full = f"dist/{name}.zip"
with zipfile.ZipFile(full, "w") as z:
    for f in files(EXT + EXTRA):
        add(z, f, f"{name}/{f}")

store = f"dist/{name}-store.zip"
store_manifest = dict(manifest)
store_manifest.pop("key", None)
with zipfile.ZipFile(store, "w") as z:
    for f in files(EXT):
        if f == "manifest.json":
            add(z, f, f, (json.dumps(store_manifest, indent=2, ensure_ascii=False) + "\n").encode())
        else:
            add(z, f, f)

for p in (full, store):
    print(f"{p}  ({os.path.getsize(p) // 1024} KB)")
PY
