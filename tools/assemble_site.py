"""Public, keyless GitHub Actions assembler. Standard library only."""
from __future__ import annotations
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import shutil
import tempfile
import time
import urllib.request
import zipfile

REPO = "shengmenghui/TelegramFriendArchivePages"
WEB_FILES = ("index.html", "styles.css", "app.js", "crypto.js", "worker.js", "reader.js")
OBJECT = re.compile(r"objects/([a-f0-9]{32})\.bin")
TAG = re.compile(r"reader-[A-Za-z0-9.-]+")


def sha(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def download(url, path):
    if not url.startswith(f"https://github.com/{REPO}/releases/download/"):
        raise ValueError("Unexpected release URL")
    for attempt in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "TFA-Pages-Assembler"}), timeout=120) as response, Path(path).open("wb") as output:
                if not response.url.startswith("https://"):
                    raise ValueError("Insecure redirect")
                shutil.copyfileobj(response, output)
            return
        except Exception:
            if attempt == 2:
                raise
            time.sleep(2 ** attempt)


def write_frontend(source, output):
    source, output = Path(source), Path(output)
    contents = {}
    for name in WEB_FILES:
        path = source / name
        if path.is_symlink() or not path.is_file():
            raise ValueError("Missing safe frontend asset")
        contents[name] = path.read_text(encoding="utf-8")
    version = hashlib.sha256("".join(contents.values()).encode("utf-8")).hexdigest()[:16]
    for name, content in contents.items():
        for asset in WEB_FILES:
            if asset != "index.html":
                content = content.replace("./" + asset, "./" + asset + "?v=" + version)
        (output / name).write_text(content, encoding="utf-8")


def assemble(source, manifest, output, package_paths):
    source, output = Path(source).resolve(), Path(output).resolve()
    if output == source or source.is_relative_to(output):
        raise ValueError("Unsafe build destination")
    if manifest.get("format") != "TFA-SITE-1" or manifest.get("repository") != REPO:
        raise ValueError("Not a reader deployment manifest")
    if output.exists() and any(output.iterdir()):
        raise ValueError("Build destination must be empty")
    output.mkdir(parents=True, exist_ok=True)
    (output / "objects").mkdir(exist_ok=True)
    expected = {}
    for descriptor in manifest["objects"]:
        if not re.fullmatch(r"[a-f0-9]{32}", descriptor["id"]) or descriptor["id"] in expected:
            raise ValueError("Invalid or duplicate object")
        expected[descriptor["id"]] = descriptor
    total = sum(d["bytes"] for d in expected.values())
    if total > 900_000_000:
        raise ValueError("Site exceeds size limit")
    seen = set()
    for package in manifest["packages"]:
        path = Path(package_paths[package["key"]])
        if path.stat().st_size != package["bytes"] or sha(path) != package["sha256"]:
            raise ValueError("Package checksum mismatch")
        with zipfile.ZipFile(path) as archive:
            names = archive.namelist()
            if len(set(names)) != len(names):
                raise ValueError("Duplicate ZIP members")
            for info in archive.infolist():
                match = OBJECT.fullmatch(info.filename)
                if not match or info.is_dir() or (info.external_attr >> 16) & 0o170000 == 0o120000:
                    raise ValueError("Unexpected ZIP member or symlink")
                object_id = match[1]
                descriptor = expected.get(object_id)
                if not descriptor or descriptor["package"] != package["key"]:
                    continue  # Old versions can share a package; only the pinned snapshot is deployed.
                if object_id in seen or info.file_size != descriptor["bytes"] or info.file_size > 100_000_000:
                    raise ValueError("Invalid object size or duplication")
                target = output / "objects" / (object_id + ".bin")
                with archive.open(info) as original, target.open("wb") as destination:
                    shutil.copyfileobj(original, destination)
                if sha(target) != descriptor["sha256"]:
                    raise ValueError("Object checksum mismatch")
                seen.add(object_id)
    if seen != set(expected):
        raise ValueError("Deployment is missing objects")
    bootstrap = manifest["bootstrap"]
    if set(bootstrap) != {"format", "dataset_id", "kdf", "wrap_nonce", "wrapped_key", "manifest"} or bootstrap["manifest"]["id"] not in seen:
        raise ValueError("Invalid public bootstrap")
    write_frontend(source, output)
    (output / "bootstrap.json").write_text(json.dumps(bootstrap, separators=(",", ":")), encoding="utf-8")
    (output / "publication.json").write_text(json.dumps({"manifest_id": bootstrap["manifest"]["id"],
        "built_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds")}), encoding="utf-8")
    (output / ".nojekyll").write_text("", encoding="utf-8")
    actual_size = sum(path.stat().st_size for path in output.rglob("*") if path.is_file())
    if actual_size > 900_000_000:
        raise ValueError("Final site exceeds size limit")
    print(f"ASSEMBLED objects={len(seen)} bytes={actual_size} capacity_warning={actual_size >= 800_000_000}", flush=True)
    return {"objects": len(seen), "bytes": actual_size}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=Path.cwd())
    parser.add_argument("--output", type=Path, default=Path("_site"))
    args = parser.parse_args()
    current = json.loads((args.source / "current.json").read_text(encoding="utf-8"))
    if not TAG.fullmatch(current["tag"]):
        raise ValueError("Invalid release tag")
    with tempfile.TemporaryDirectory(prefix="tfa-pages-") as temporary:
        directory = Path(temporary)
        descriptor_path = directory / "snapshot.json"
        download(f'https://github.com/{REPO}/releases/download/{current["tag"]}/snapshot.json', descriptor_path)
        if sha(descriptor_path) != current["sha256"]:
            raise ValueError("Snapshot descriptor checksum mismatch")
        manifest = json.loads(descriptor_path.read_text(encoding="utf-8"))
        paths = {}
        def get_package(pair):
            index, package = pair
            if package["bytes"] > 64 * 1024 * 1024:
                raise ValueError("Package exceeds 64 MiB")
            path = directory / f"{index}.zip"
            download(package["url"], path)
            return package["key"], path
        with ThreadPoolExecutor(max_workers=4) as pool:
            for key, path in pool.map(get_package, enumerate(manifest["packages"])):
                if key in paths:
                    raise ValueError("Duplicate package keys")
                paths[key] = path
        assemble(args.source, manifest, args.output, paths)


if __name__ == "__main__":
    main()
