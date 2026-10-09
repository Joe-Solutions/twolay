"""Serve app/ locally.

  python3 scripts/serve.py                     # http://localhost:8000  (laptop demo, two windows)
  python3 scripts/serve.py --lan --cert c.pem --key k.pem   # https://<laptop-ip>:8443 to install on phones

Camera, mic and offline caching need a secure context: localhost, or HTTPS with a cert the phone trusts
(e.g. `mkcert`). Once a phone has tapped "I-save ang buong app para offline", this server is no longer needed.
"""
import argparse
import socket
import ssl
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

APP = Path(__file__).resolve().parent.parent / "app"


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".wasm": "application/wasm",
        ".webmanifest": "application/manifest+json",
        ".task": "application/octet-stream",
        ".onnx": "application/octet-stream",
        ".json": "application/json",
        ".wav": "audio/wav",
    }

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Service-Worker-Allowed", "/")
        super().end_headers()

    def log_message(self, fmt, *args):
        print(f"[{self.client_address[0]}] {fmt % args}")


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))  # no packet is sent; just picks the LAN interface
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lan", action="store_true", help="listen on all interfaces (phones on the hotspot)")
    ap.add_argument("--port", type=int)
    ap.add_argument("--cert")
    ap.add_argument("--key")
    ap.add_argument("--dir", help="serve this folder instead of app/ (tests)")
    a = ap.parse_args()

    host = "0.0.0.0" if a.lan else "127.0.0.1"
    tls = bool(a.cert and a.key)
    port = a.port or (8443 if tls else 8000)
    httpd = ThreadingHTTPServer((host, port), partial(Handler, directory=a.dir or str(APP)))
    if tls:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(a.cert, a.key)
        httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
    scheme = "https" if tls else "http"
    print(f"Twolay: {scheme}://localhost:{port}/")
    if a.lan:
        print(f"Twolay on hotspot: {scheme}://{lan_ip()}:{port}/")
        if not tls:
            print("  note: phones need HTTPS for camera/mic. Pass --cert/--key (see README).")
    print(f"Demo: open {scheme}://localhost:{port}/ and tap 'Demo mode'")
    httpd.serve_forever()


if __name__ == "__main__":
    main()
