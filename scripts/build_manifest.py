"""Write app/asset-manifest.json: every file the service worker must cache for offline use."""
import hashlib
import json
import sys
from pathlib import Path

APP = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "app"
SKIP = {"asset-manifest.json", "sw.js"}

files = sorted(
    p.relative_to(APP).as_posix()
    for p in APP.rglob("*")
    if p.is_file() and p.name not in SKIP and not p.name.startswith(".")
)
# Content hashes, so the version only changes when a file really changes (not on git checkout),
# and a phone that saved the app offline downloads only the files that changed.
def file_hash(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()[:16]


hashes = {f"./{f}": file_hash(APP / f) for f in files}
hashes["./"] = hashes["./index.html"]
digest = hashlib.sha256()
for f in files:
    digest.update(f"{f}:{hashes['./' + f]}".encode())

manifest = {
    "version": digest.hexdigest()[:12],
    "files": ["./"] + [f"./{f}" for f in files],
    "hashes": hashes,
}
(APP / "asset-manifest.json").write_text(json.dumps(manifest, indent=1))
total = sum((APP / f).stat().st_size for f in files)
print(f"   {len(files)} files, {total / 1e6:.1f} MB, version {manifest['version']}")
