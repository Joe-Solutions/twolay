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
digest = hashlib.sha256()
for f in files:
    st = (APP / f).stat()
    digest.update(f"{f}:{st.st_size}:{int(st.st_mtime)}".encode())

manifest = {"version": digest.hexdigest()[:12], "files": ["./"] + [f"./{f}" for f in files]}
(APP / "asset-manifest.json").write_text(json.dumps(manifest, indent=1))
total = sum((APP / f).stat().st_size for f in files)
print(f"   {len(files)} files, {total / 1e6:.1f} MB, version {manifest['version']}")
