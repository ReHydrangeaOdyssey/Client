"""Local HTTPS static server. Run from Client: python tools/serve_https.py"""
import argparse
import functools
import http.server
import ipaddress
import pathlib
import ssl
import sys
import urllib.parse

CLIENT_ROOT = pathlib.Path(__file__).resolve().parent.parent
DEFAULT_PORT = 8443
LOOPBACK_HOST = "127.0.0.1"
PRIVATE_NETWORKS = tuple(ipaddress.IPv4Network(network) for network in
                         ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))


def resolve_binding(mode, host=None, lan_network=None):
    if mode == "local":
        if host not in (None, LOOPBACK_HOST) or lan_network is not None:
            raise ValueError("Local mode only accepts 127.0.0.1 and no LAN network.")
        return LOOPBACK_HOST, ipaddress.IPv4Network("127.0.0.1/32")
    if mode != "lan" or host is None or lan_network is None:
        raise ValueError("LAN mode requires --host and --lan-network.")
    address = ipaddress.IPv4Address(host)
    network = ipaddress.IPv4Network(lan_network, strict=True)
    if not any(network.subnet_of(private) for private in PRIVATE_NETWORKS):
        raise ValueError("LAN network must be inside an RFC1918 private IPv4 range.")
    if address not in network or address in (network.network_address, network.broadcast_address):
        raise ValueError("--host must be a usable address in --lan-network.")
    return str(address), network


class LocalNetworkServer(http.server.ThreadingHTTPServer):
    def __init__(self, address, handler, allowed_network):
        self.allowed_network = allowed_network
        super().__init__(address, handler)

    def verify_request(self, request, client_address):
        return ipaddress.IPv4Address(client_address[0]) in self.allowed_network


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


def report_startup_error(stage, error, host, port):
    details = [type(error).__name__]
    for field in ("winerror", "errno", "reason"):
        value = getattr(error, field, None)
        if value is not None:
            details.append(f"{field}={value}")
    print(f"HTTPS startup failed during {stage}: " + ", ".join(details),
          file=sys.stderr)
    if stage == "socket bind":
        print(f"Cannot listen on {host}:{port}. Check existing listeners and "
              "Windows portproxy/reserved-port settings.", file=sys.stderr)
    else:
        print("Verify the server certificate/key files and their format/matching pair.",
              file=sys.stderr)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("local", "lan"), default="local",
                        help="local: development machine only; lan: selected private subnet")
    parser.add_argument("--host", help="Development machine IPv4 address; required in LAN mode")
    parser.add_argument("--lan-network", help="Allowed LAN subnet, for example 192.168.1.0/24")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--directory", type=pathlib.Path, default=CLIENT_ROOT / "dist")
    parser.add_argument("--cert", type=pathlib.Path,
                        help="Server certificate; local defaults to .env/dev-local/server.crt")
    parser.add_argument("--key", type=pathlib.Path,
                        help="Server key; local defaults to .env/dev-local/server.key")
    args = parser.parse_args()
    certificate_directory = CLIENT_ROOT / ".env"
    if args.mode == "local":
        certificate_directory /= "dev-local"
    args.cert = args.cert or certificate_directory / "server.crt"
    args.key = args.key or certificate_directory / "server.key"
    try:
        host, allowed_network = resolve_binding(args.mode, args.host, args.lan_network)
    except ValueError as error:
        parser.error(str(error))
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
    except OSError as error:
        report_startup_error("certificate/key loading", error, host, args.port)
        return 1
    handler = functools.partial(Handler, directory=str(root))
    try:
        server = LocalNetworkServer((host, args.port), handler, allowed_network)
    except OSError as error:
        report_startup_error("socket bind", error, host, args.port)
        return 1
    try:
        server.socket = context.wrap_socket(server.socket, server_side=True)
    except OSError as error:
        server.server_close()
        report_startup_error("TLS socket setup", error, host, args.port)
        return 1
    print(f"HTTPS ({args.mode}): https://{host}:{args.port}/", file=sys.stderr)
    print(f"Allowed client subnet: {allowed_network}", file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0

if __name__ == "__main__":
    sys.exit(main())
