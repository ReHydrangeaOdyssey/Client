"""Local HTTPS static server. Run from Client: python tools/serve_https.py"""
import argparse
import functools
import http.server
import pathlib
import ssl
import sys
import urllib.parse

CLIENT_ROOT = pathlib.Path(__file__).resolve().parent.parent
DEFAULT_PORT = 8443

class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".wasm": "application/wasm", ".js": "text/javascript"}

    def allowed(self):
        path = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path)
        parts = pathlib.PurePosixPath(path).parts
        if any(part.startswith(".") or part == ".." for part in parts):
            return False
        target = pathlib.Path(self.translate_path(self.path)).resolve()
        root = pathlib.Path(self.directory).resolve()
        try:
            target.relative_to(root)
        except ValueError:
            return False
        return target.suffix.lower() not in {".key", ".crt", ".pem", ".pfx", ".p12"}

    def do_GET(self):
        if not self.allowed():
            self.send_error(404)
            return
        super().do_GET()

    def do_HEAD(self):
        if not self.allowed():
            self.send_error(404)
            return
        super().do_HEAD()

    def list_directory(self, path):
        self.send_error(404)
        return None

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Service-Worker-Allowed", "/")
        self.send_header("Content-Security-Policy",
                         "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; "
                         "style-src 'self'; img-src 'self' blob:; "
                         "connect-src 'self'; worker-src 'self'; object-src 'none'; "
                         "base-uri 'none'; frame-ancestors 'none'")
        super().end_headers()

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--directory", type=pathlib.Path, default=CLIENT_ROOT / "dist")
    parser.add_argument("--cert", type=pathlib.Path, default=CLIENT_ROOT / ".env/server.crt")
    parser.add_argument("--key", type=pathlib.Path, default=CLIENT_ROOT / ".env/server.key")
    args = parser.parse_args()
    root = args.directory.resolve()
    if not root.is_dir() or root == CLIENT_ROOT or root in CLIENT_ROOT.parents:
        parser.error("Select a built static directory, not the repository or its ancestors.")
    for secret in (args.cert.resolve(), args.key.resolve()):
        if secret == root or root in secret.parents:
            parser.error("Certificates and keys must be outside the served directory.")
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    try:
        # The TLS library reads the server pair; the local CA private key is never needed.
        context.load_cert_chain(str(args.cert), str(args.key))
        handler = functools.partial(Handler, directory=str(root))
        server = http.server.ThreadingHTTPServer((args.host, args.port), handler)
        server.socket = context.wrap_socket(server.socket, server_side=True)
    except (OSError, ssl.SSLError):
        print("HTTPS startup failed: verify server certificate/key, directory and port.",
              file=sys.stderr)
        return 1
    print(f"Local HTTPS: https://{args.host}:{args.port}/", file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0

if __name__ == "__main__":
    sys.exit(main())
