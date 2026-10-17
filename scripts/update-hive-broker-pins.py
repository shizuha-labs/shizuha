#!/usr/bin/env python3
"""Prepare one coherent Hive source commit after native broker qualification."""
import argparse
import json
from pathlib import Path
import re
import sys

IMAGE = r'localhost:30500/mcp-auth-proxy:src-[0-9a-f]{12}'
PINS = {
    'hive_project/settings.py': r"FLEET_BROKER_IMAGE\s*=\s*os\.environ\.get\(\s*'FLEET_BROKER_IMAGE',\s*'(" + IMAGE + r")',\s*\)",
    'k8s/hive-backend-live.yaml': r'- name: FLEET_BROKER_IMAGE\s*\n\s*value: (' + IMAGE + r')(?=\s|$)',
    'k8s/shizuha-hive.yaml': r'- name: FLEET_BROKER_IMAGE\s*\n\s*value: (' + IMAGE + r')(?=\s|$)',
    '.forgejo/scripts/ring-release-fleet.sh': r'ensure_env\(container, "FLEET_BROKER_IMAGE", "(' + IMAGE + r')"\)',
}


def update(root, image, source):
    if not re.fullmatch(r'[0-9a-f]{40}', source):
        raise ValueError('source must be a full Git SHA')
    if image != 'localhost:30500/mcp-auth-proxy:src-' + source[:12]:
        raise ValueError('image must bind the qualified source SHA')
    prepared = []
    # Validate the complete source contract before writing any file. The caller
    # publishes these exact paths in one Git commit, never individual live pins.
    for name, pattern in PINS.items():
        path = root / name
        text = path.read_text()
        matches = list(re.finditer(pattern, text))
        if len(matches) != 1:
            raise ValueError(f'{name}: expected exactly one broker pin')
        match = matches[0]
        prepared.append((name, path, text, match))
    old_images = {match.group(1) for _, _, _, match in prepared}
    if len(old_images) != 1:
        raise ValueError('Hive broker source pins disagree; refuse partial publication')
    changed = []
    for name, path, text, match in prepared:
        if match.group(1) != image:
            path.write_text(text[:match.start(1)] + image + text[match.end(1):])
            changed.append(name)
    return {'changed_paths': changed, 'old_image': old_images.pop(), 'image': image}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--hive-root', type=Path, required=True)
    parser.add_argument('--image', required=True)
    parser.add_argument('--source-sha', required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(update(args.hive_root, args.image, args.source_sha)))
    except (OSError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
