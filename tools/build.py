"""Build the offline WASM shell. Scene inputs must be real editor outputs."""
import argparse
import hashlib
import json
import pathlib
import re
import shutil
import subprocess
import sys
import urllib.parse

ROOT = pathlib.Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
SCENE_NAME = re.compile(r"[a-z][a-z0-9_]*", re.ASCII)

def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result

def scenes(source, entry, *, write=True):
    if not source.is_dir():
        raise ValueError("Scene source directory does not exist: " + str(source))
    entries = []
    ids = set()
    target = DIST / "assets" / "scene"
    pending = []
    mismatches = []
    for path in sorted(source.glob("*.json")):
        name = path.stem
        if name == "scene_index" or not SCENE_NAME.fullmatch(name):
            raise ValueError("invalid scene filename")
        raw = path.read_bytes()
        if len(raw) > 8_000_000:
            raise ValueError("scene exceeds byte limit")
        data = json.loads(raw, object_pairs_hook=unique_object)
        if type(data.get("version")) is not int or data["version"] != 2 or data.get("scene") != name:
            mismatches.append(f"{path.name} (expected version=2, scene={name})")
            continue
        # SceneID = big-endian integer of SHA-256(UTF-8(name))[0:6].
        scene_id = int.from_bytes(hashlib.sha256(name.encode("utf-8")).digest()[:6], "big")
        if scene_id == 0 or scene_id in ids:
            raise ValueError("zero or colliding SceneID")
        ids.add(scene_id)
        entries.append({"scene_id": scene_id, "scene_name": name})
        pending.append((path.name, raw))
    if mismatches:
        raise ValueError("scene name/version mismatch: " + "; ".join(mismatches))
    if not entry or entry not in {item["scene_name"] for item in entries}:
        raise ValueError("--entry must identify a supplied Scene")
    if write:
        target.mkdir(parents=True, exist_ok=True)
        for name, raw in pending:
            (target / name).write_bytes(raw)
    return entries, entry

def write_json(name, value):
    (DIST / name).parent.mkdir(parents=True, exist_ok=True)
    (DIST / name).write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":")),
                             encoding="utf-8")

def runtime_configuration(entry, path):
    result = {"entry_scene": entry}
    if path is None:
        return result
    settings = json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=unique_object)
    origins = ("client_origin", "public_api_origin")
    limits = ("api_timeout_ms", "api_max_response_bytes", "api_max_frame_bytes")
    if not isinstance(settings, dict) or set(settings) != set(origins + limits):
        raise ValueError("API configuration requires exactly the two origins and three limits")
    for key in origins:
        value = settings[key]
        if not isinstance(value, str):
            raise ValueError(key + " must be an HTTPS origin")
        parsed = urllib.parse.urlsplit(value)
        if (parsed.scheme != "https" or not parsed.hostname or parsed.username is not None
                or parsed.password is not None or parsed.path not in ("", "/")
                or parsed.query or parsed.fragment):
            raise ValueError(key + " must be an HTTPS origin")
        # Accessing port validates malformed or out-of-range port numbers.
        parsed.port
    for key in limits:
        if type(settings[key]) is not int or not 0 < settings[key] <= 9007199254740991:
            raise ValueError(key + " must be a positive JavaScript-safe integer")
    result.update(settings)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scenes", type=pathlib.Path, default=ROOT / "assets" / "scene",
                        help="Scene source directory (default: Client/assets/scene)")
    parser.add_argument("--entry", default="title", help="Initial Scene name (default: title)")
    parser.add_argument("--api-config", type=pathlib.Path,
                        help="Deployment API origins and request/stream budgets (optional)")
    args = parser.parse_args()
    try:
        configuration = runtime_configuration(args.entry, args.api_config)
        scenes(args.scenes, args.entry, write=False)
        subprocess.run(["cargo", "build", "--offline", "--locked", "--release",
                        "--target", "wasm32-unknown-unknown"], cwd=ROOT, check=True)
        DIST.mkdir(exist_ok=True)
        # Old output is not implicitly removed; only current build files enter the manifest.
        for path in (ROOT / "web").iterdir():
            if path.is_file():
                shutil.copyfile(path, DIST / path.name)
        subprocess.run(["wasm-bindgen", "--target", "web", "--no-typescript",
                        "--out-dir", str(DIST / "pkg"),
                        str(ROOT / "target/wasm32-unknown-unknown/release/reorsg_client.wasm")],
                       cwd=ROOT, check=True)
        entries, entry = scenes(args.scenes, args.entry)
        write_json("assets/scene/scene_index.json", {"scenes": entries})
        write_json("runtime_config.json", configuration)
        files = [path for path in (ROOT / "web").iterdir() if path.is_file()]
        paths = [path.name for path in files]
        paths += ["pkg/reorsg_client.js", "pkg/reorsg_client_bg.wasm",
                  "assets/scene/scene_index.json", "runtime_config.json"]
        paths += ["assets/scene/" + item["scene_name"] + ".json" for item in entries]
        manifest = [{"path": path, "size_bytes": (DIST / path).stat().st_size, "sha256": hashlib.sha256((DIST / path).read_bytes()).hexdigest()}
                    for path in sorted(paths)]
        version = hashlib.sha256(json.dumps(manifest, separators=(",", ":")).encode()).hexdigest()
        write_json("distribution.json", {"version": version, "files": manifest})
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"Build failed: {error}", file=sys.stderr)
        return 1
    print("Built dist. Start: python tools/serve_https.py", file=sys.stderr)
    return 0

if __name__ == "__main__":
    sys.exit(main())
