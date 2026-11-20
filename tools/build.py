"""Build the offline WASM shell. Scene inputs must be real editor outputs."""
import argparse
import hashlib
import json
import pathlib
import re
import shutil
import subprocess
import sys

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

def scenes(source, entry):
    if source is None:
        if entry:
            raise ValueError("--entry requires --scenes")
        return [], None
    entries = []
    ids = set()
    target = DIST / "assets" / "scene"
    target.mkdir(parents=True, exist_ok=True)
    for path in sorted(source.glob("*.json")):
        name = path.stem
        if name == "scene_index" or not SCENE_NAME.fullmatch(name):
            raise ValueError("invalid scene filename")
        raw = path.read_bytes()
        if len(raw) > 8_000_000:
            raise ValueError("scene exceeds byte limit")
        data = json.loads(raw, object_pairs_hook=unique_object)
        if type(data.get("version")) is not int or data["version"] != 2 or data.get("scene") != name:
            raise ValueError("scene name/version mismatch")
        # SceneID = big-endian integer of SHA-256(UTF-8(name))[0:6].
        scene_id = int.from_bytes(hashlib.sha256(name.encode("utf-8")).digest()[:6], "big")
        if scene_id == 0 or scene_id in ids:
            raise ValueError("zero or colliding SceneID")
        ids.add(scene_id)
        entries.append({"scene_id": scene_id, "scene_name": name})
        (target / path.name).write_bytes(raw)
    if not entry or entry not in {item["scene_name"] for item in entries}:
        raise ValueError("--entry must identify a supplied Scene")
    return entries, entry

def write_json(name, value):
    (DIST / name).parent.mkdir(parents=True, exist_ok=True)
    (DIST / name).write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":")),
                             encoding="utf-8")

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scenes", type=pathlib.Path)
    parser.add_argument("--entry")
    args = parser.parse_args()
    try:
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
        write_json("runtime_config.json", {"entry_scene": entry})
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
