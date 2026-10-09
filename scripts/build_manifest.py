"""Write app/asset-manifest.json: every file the service worker must cache for offline use."""
import hashlib
import json
from pathlib import Path

APP = Path(__file__).resolve().parent.parent / "app"
SKIP = {"asset-manifest.json", "sw.js"}

files = sorted(
    p.relative_to(APP).as_posix()
    for p in APP.rglob("*")
    if p.is_file() and p.name not in SKIP and not p.name.startswith(".")
)
# Content hash, so the version only changes when a file really changes (not on git checkout).
digest = hashlib.sha256()
for f in files:
    digest.update(f.encode())
    with open(APP / f, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)

manifest = {"version": digest.hexdigest()[:12], "files": ["./"] + [f"./{f}" for f in files]}
(APP / "asset-manifest.json").write_text(json.dumps(manifest, indent=1))
total = sum((APP / f).stat().st_size for f in files)
print(f"   {len(files)} files, {total / 1e6:.1f} MB, version {manifest['version']}")
