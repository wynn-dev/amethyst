#!/usr/bin/env python3
"""Deterministic jar packaging and manifest.json for the patched LWJGL 3 GLFW natives.

  package.py jar <out.jar> <entry-name>=<path> ...
      Writes a jar (zip) with a fixed timestamp, sorted entries and fixed permissions, so equal
      inputs always give a byte-identical jar (and sha256). Its META-INF/MANIFEST.MF carries the
      attributes LWJGL reads from its own natives jars (Implementation-Title, LWJGL-Platform), so
      LWJGL's platform-mismatch diagnostics still recognise it.

  package.py manifest <out manifest.json> <base url> <name>:<version>:<jar path> ...
      Writes the manifest consumed by the launcher (packages/game `GlfwArm64Source`):
      { baseUrl, artifacts: [{ name, version, file, url, sha256, size }] }, where `url` is the
      file name relative to baseUrl and `version` is the LWJGL version the jar is built for.
"""
import hashlib
import json
import os
import sys
import zipfile

# 1980-01-01 is the zip epoch; SOURCE_DATE_EPOCH (if set) wins.
EPOCH = (1980, 1, 1, 0, 0, 0)

MANIFEST = (
    'Manifest-Version: 1.0\r\n'
    'Created-By: Amethyst natives/lwjgl3-glfw/build.sh\r\n'
    'Implementation-Title: lwjgl-glfw\r\n'
    'Implementation-Vendor: Amethyst (patched build of LWJGL-CI/glfw)\r\n'
    'LWJGL-Platform: macos/arm64\r\n'
    '\r\n'
).encode()


def date_time():
    sde = os.environ.get('SOURCE_DATE_EPOCH')
    if not sde:
        return EPOCH
    import time
    t = time.gmtime(max(int(sde), 315532800))
    return (t.tm_year, t.tm_mon, t.tm_mday, t.tm_hour, t.tm_min, t.tm_sec)


def make_jar(out, entries):
    dt = date_time()
    pairs = sorted(e.split('=', 1) for e in entries)
    names = ['META-INF/MANIFEST.MF'] + [n for n, _ in pairs]
    if len(set(names)) != len(names):
        sys.exit('duplicate jar entry')
    tmp = out + '.tmp'
    with zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        def add(name, data):
            info = zipfile.ZipInfo(name, dt)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            info.create_system = 3
            z.writestr(info, data)
        add('META-INF/MANIFEST.MF', MANIFEST)
        for name, path in pairs:
            with open(path, 'rb') as f:
                add(name, f.read())
    os.replace(tmp, out)


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def make_manifest(out, base_url, specs):
    if not base_url.endswith('/'):
        base_url += '/'
    artifacts = []
    for spec in specs:
        name, version, path = spec.split(':', 2)
        f = os.path.basename(path)
        artifacts.append({
            'name': name,
            'version': version,
            'file': f,
            'url': f,
            'sha256': sha256(path),
            'size': os.path.getsize(path),
        })
    with open(out, 'w') as fh:
        json.dump({'baseUrl': base_url, 'artifacts': artifacts}, fh, indent=2)
        fh.write('\n')


def main():
    if len(sys.argv) >= 3 and sys.argv[1] == 'jar':
        make_jar(sys.argv[2], sys.argv[3:])
    elif len(sys.argv) >= 4 and sys.argv[1] == 'manifest':
        make_manifest(sys.argv[2], sys.argv[3], sys.argv[4:])
    else:
        sys.exit(__doc__)


if __name__ == '__main__':
    main()
