#!/usr/bin/env python3
"""Extract only the exact files in a pinned dashboard lock, ignoring AppleDouble."""
import hashlib
import json
import pathlib
import sys
import tarfile

archive, destination, lock_file = map(pathlib.Path, sys.argv[1:4])
lock = json.loads(lock_file.read_text())
if hashlib.sha256(archive.read_bytes()).hexdigest() != lock['archiveSha256']:
    raise SystemExit('Dashboard archive digest mismatch')
expected = lock['files']
destination.mkdir(parents=True, exist_ok=False)
seen = set()
with tarfile.open(archive, 'r:gz') as tar:
    for member in tar:
        item = pathlib.PurePosixPath(member.name)
        if item.is_absolute() or '..' in item.parts:
            raise SystemExit('Unsafe dashboard archive path')
        if str(item) == '.':
            if not member.isdir():
                raise SystemExit('Invalid archive root')
            continue
        # BSD tar on macOS stores filesystem metadata as AppleDouble files.
        # These are not dashboard assets and are never extracted.
        if item.name.startswith('._'):
            if not member.isfile():
                raise SystemExit('Invalid AppleDouble metadata')
            continue
        name = str(item)
        if member.isdir():
            continue
        if not member.isfile() or name not in expected or name in seen:
            raise SystemExit(f'Unexpected dashboard archive entry: {name}')
        source = tar.extractfile(member)
        if source is None:
            raise SystemExit(f'Unreadable dashboard asset: {name}')
        data = source.read()
        if hashlib.sha256(data).hexdigest() != expected[name]:
            raise SystemExit(f'Dashboard digest mismatch: {name}')
        output = destination.joinpath(*item.parts)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(data)
        seen.add(name)
if seen != set(expected):
    raise SystemExit('Dashboard archive is missing locked files')
