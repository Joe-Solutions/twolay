#!/usr/bin/env bash
# HTTPS cert so phones on the hotspot can use camera/mic and save the app for offline.
# Uses mkcert (trusted local CA). Install its root CA on each phone once.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/certs"
IP="${1:-$(ipconfig getifaddr en0 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')}"

if ! command -v mkcert >/dev/null; then
  echo "mkcert not found: brew install mkcert   (or see https://github.com/FiloSottile/mkcert)" >&2
  exit 1
fi
mkcert -install
mkcert -cert-file "$ROOT/certs/cert.pem" -key-file "$ROOT/certs/key.pem" "$IP" localhost 127.0.0.1
echo
echo "Cert for $IP written to certs/."
echo "Install this root CA on each phone, then trust it:"
echo "  $(mkcert -CAROOT)/rootCA.pem"
echo "  iPhone:  AirDrop the file -> Settings > Profile Downloaded > Install,"
echo "           then Settings > General > About > Certificate Trust Settings > enable."
echo "  Android: Settings > Security > Encryption & credentials > Install a certificate > CA certificate."
echo
echo "Serve:  python3 scripts/serve.py --lan --cert certs/cert.pem --key certs/key.pem"
