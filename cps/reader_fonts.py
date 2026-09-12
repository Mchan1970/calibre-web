# -*- coding: utf-8 -*-

#  This file is part of the Calibre-Web (https://github.com/janeczku/calibre-web)
#    Copyright (C) 2026 OzzieIsaacs
#
#  This program is free software: you can redistribute it and/or modify
#  it under the terms of the GNU General Public License as published by
#  the Free Software Foundation, either version 3 of the License, or
#  (at your option) any later version.
#
#  This program is distributed in the hope that it will be useful,
#  but WITHOUT ANY WARRANTY; without even the implied warranty of
#  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
#  GNU General Public License for more details.
#
#  You should have received a copy of the GNU General Public License
#  along with this program. If not, see <http://www.gnu.org/licenses/>.

"""Read-only discovery of admin-provided EPUB reader fonts.

Fonts live in a persistent, read-only directory (see _resolve_font_dir) and are
described by a strict fonts.json manifest. This module only ever hands out a
fully validated, immutable snapshot; cps/web.py must not re-parse the manifest
or build filesystem paths from request data itself.
"""

import hashlib
import json
import os
import re
import threading
from collections import namedtuple

from . import logger
from .string_helper import strip_whitespaces

log = logger.create()

ENV_FONT_DIR = "CALIBRE_FONT_DIR"
MANIFEST_FILENAME = "fonts.json"

MAX_MANIFEST_BYTES = 256 * 1024
MAX_FONT_FILE_BYTES = 64 * 1024 * 1024
MAX_TOTAL_FONT_BYTES = 512 * 1024 * 1024
MAX_FAMILIES = 32
MAX_FACES_PER_FAMILY = 8

EXTENSION_MIME_TYPES = {
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
}

_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
_FILE_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$")
_ALLOWED_FALLBACKS = frozenset(("serif", "sans-serif", "monospace"))
_ALLOWED_WEIGHTS = frozenset((100, 200, 300, 400, 500, 600, 700, 800, 900))
_ALLOWED_STYLES = frozenset(("normal", "italic"))

_ROOT_ALLOWED_KEYS = frozenset(("version", "fonts"))
_FAMILY_ALLOWED_KEYS = frozenset(("id", "name", "fallback", "faces"))
_FACE_ALLOWED_KEYS = frozenset(("id", "file", "weight", "style"))

FaceRecord = namedtuple("FaceRecord", "id weight style path mime size mtime_ns")
FamilyRecord = namedtuple("FamilyRecord", "id name fallback faces")
FontSnapshot = namedtuple("FontSnapshot", "revision families")

EMPTY_REVISION = "empty"
EMPTY_SNAPSHOT = FontSnapshot(revision=EMPTY_REVISION, families={})


class _ManifestError(Exception):
    """The manifest as a whole is invalid; fail closed to an empty snapshot."""


class _FamilyRejected(Exception):
    """One font family entry is invalid; drop only that entry."""


def _is_plain_int(value):
    # bool is an int subclass in Python; JSON true/false must not pass as 1/0.
    return isinstance(value, int) and not isinstance(value, bool)


def _no_duplicate_keys(pairs):
    seen = set()
    result = {}
    for key, value in pairs:
        if key in seen:
            raise ValueError("duplicate key %r" % (key,))
        seen.add(key)
        result[key] = value
    return result


_snapshot_lock = threading.Lock()
_current_snapshot = EMPTY_SNAPSHOT

_warn_lock = threading.Lock()
_warned_fingerprints = set()


def _warn_once(fingerprint, message):
    with _warn_lock:
        if fingerprint in _warned_fingerprints:
            return
        _warned_fingerprints.add(fingerprint)
    log.warning("Server fonts: %s", message)


def _resolve_font_dir():
    env_dir = os.environ.get(ENV_FONT_DIR)
    if env_dir:
        if not os.path.isabs(env_dir):
            _warn_once(("env-relative", env_dir),
                        "%s must be an absolute path; server fonts disabled" % ENV_FONT_DIR)
            return None
        return os.path.realpath(env_dir)

    from . import cli_param
    settings_path = getattr(cli_param, "settings_path", None)
    if not settings_path:
        return None
    return os.path.realpath(os.path.join(os.path.dirname(os.path.abspath(settings_path)), "fonts"))


def _validate_face(entry, family_id, font_dir):
    if not isinstance(entry, dict):
        raise _FamilyRejected("family '%s': face entry must be an object" % family_id)
    unknown = set(entry) - _FACE_ALLOWED_KEYS
    if unknown:
        raise _FamilyRejected("family '%s': unknown face fields %s" % (family_id, sorted(unknown)))

    face_id = entry.get("id")
    if not isinstance(face_id, str) or not _ID_RE.match(face_id):
        raise _FamilyRejected("family '%s': invalid face id" % family_id)

    filename = entry.get("file")
    if not isinstance(filename, str) or not _FILE_NAME_RE.match(filename):
        raise _FamilyRejected("family '%s' face '%s': invalid file name" % (family_id, face_id))
    extension = os.path.splitext(filename)[1].lower()
    if extension not in EXTENSION_MIME_TYPES:
        raise _FamilyRejected("family '%s' face '%s': unsupported font file extension" % (family_id, face_id))

    weight = entry.get("weight")
    if not _is_plain_int(weight) or weight not in _ALLOWED_WEIGHTS:
        raise _FamilyRejected("family '%s' face '%s': invalid weight" % (family_id, face_id))

    style = entry.get("style")
    if style not in _ALLOWED_STYLES:
        raise _FamilyRejected("family '%s' face '%s': invalid style" % (family_id, face_id))

    candidate_path = os.path.join(font_dir, filename)
    # Filenames are single path segments (regex above forbids separators), so the
    # only way this can resolve outside font_dir is a symlink - reject explicitly
    # rather than silently following it, then re-confirm the real parent directory.
    if os.path.islink(candidate_path):
        raise _FamilyRejected("family '%s' face '%s': symlinked font files are not allowed" % (family_id, face_id))
    real_path = os.path.realpath(candidate_path)
    if os.path.dirname(real_path) != font_dir or not os.path.isfile(real_path):
        raise _FamilyRejected("family '%s' face '%s': font file missing or outside font directory"
                               % (family_id, face_id))

    try:
        stat_result = os.stat(real_path)
    except OSError as exc:
        raise _FamilyRejected("family '%s' face '%s': unable to read font file (%s)" % (family_id, face_id, exc))

    size = stat_result.st_size
    if size <= 0 or size > MAX_FONT_FILE_BYTES:
        raise _FamilyRejected("family '%s' face '%s': font file size out of bounds" % (family_id, face_id))

    face_record = FaceRecord(id=face_id, weight=weight, style=style, path=real_path,
                              mime=EXTENSION_MIME_TYPES[extension], size=size, mtime_ns=stat_result.st_mtime_ns)
    return face_record


def _validate_family(entry, font_dir, referenced_files):
    if not isinstance(entry, dict):
        raise _FamilyRejected("family entry must be an object")
    unknown = set(entry) - _FAMILY_ALLOWED_KEYS
    if unknown:
        raise _FamilyRejected("unknown family fields %s" % sorted(unknown))

    family_id = entry.get("id")
    if not isinstance(family_id, str) or not _ID_RE.match(family_id):
        raise _FamilyRejected("invalid family id")

    name = entry.get("name")
    if not isinstance(name, str):
        raise _FamilyRejected("family '%s': name must be a string" % family_id)
    name = strip_whitespaces(name)
    if not (1 <= len(name) <= 80):
        raise _FamilyRejected("family '%s': name must be 1-80 characters" % family_id)

    fallback = entry.get("fallback")
    if fallback not in _ALLOWED_FALLBACKS:
        raise _FamilyRejected("family '%s': invalid fallback" % family_id)

    faces_raw = entry.get("faces")
    if not isinstance(faces_raw, list) or not (1 <= len(faces_raw) <= MAX_FACES_PER_FAMILY):
        raise _FamilyRejected("family '%s': faces must contain 1-%d entries" % (family_id, MAX_FACES_PER_FAMILY))

    faces = {}
    seen_descriptors = set()
    has_base_face = False
    family_bytes = 0
    local_files = {}

    for face_entry in faces_raw:
        face = _validate_face(face_entry, family_id, font_dir)
        if face.id in faces:
            raise _FamilyRejected("family '%s': duplicate face id '%s'" % (family_id, face.id))
        descriptor = (face.weight, face.style)
        if descriptor in seen_descriptors:
            raise _FamilyRejected("family '%s': duplicate weight/style combination" % family_id)
        seen_descriptors.add(descriptor)
        if descriptor == (400, "normal"):
            has_base_face = True
        faces[face.id] = face
        local_files[face.path] = face.id
        family_bytes += face.size

    if not has_base_face:
        raise _FamilyRejected("family '%s': missing required weight 400 / normal base face" % family_id)

    # Cross-family duplicate-file check happens last and only for an otherwise
    # valid family, so a single bad face can't corrupt another family's registry.
    for path, face_id in local_files.items():
        if path in referenced_files:
            raise _FamilyRejected("family '%s' face '%s': font file already used by another family"
                                   % (family_id, face_id))
    referenced_files.update(local_files)

    return FamilyRecord(id=family_id, name=name, fallback=fallback, faces=faces), family_bytes


def _validate_root(data, font_dir):
    if not isinstance(data, dict):
        raise _ManifestError("root must be a JSON object")
    unknown = set(data) - _ROOT_ALLOWED_KEYS
    if unknown:
        raise _ManifestError("unknown root fields %s" % sorted(unknown))

    version = data.get("version")
    if not _is_plain_int(version) or version != 1:
        raise _ManifestError("unsupported or missing manifest version")

    fonts = data.get("fonts")
    if not isinstance(fonts, list):
        raise _ManifestError("'fonts' must be an array")
    if len(fonts) > MAX_FAMILIES:
        raise _ManifestError("too many font families (max %d)" % MAX_FAMILIES)

    families = {}
    referenced_files = {}
    total_bytes = 0

    for index, entry in enumerate(fonts):
        try:
            family, family_bytes = _validate_family(entry, font_dir, referenced_files)
        except _FamilyRejected as exc:
            _warn_once(("family", index, str(exc)), "discarding font family #%d: %s" % (index, exc))
            continue
        if family.id in families:
            raise _ManifestError("duplicate font family id '%s'" % family.id)
        total_bytes += family_bytes
        if total_bytes > MAX_TOTAL_FONT_BYTES:
            raise _ManifestError("total font size exceeds %d bytes" % MAX_TOTAL_FONT_BYTES)
        families[family.id] = family

    return families


def _load_and_validate(font_dir):
    manifest_path = os.path.join(font_dir, MANIFEST_FILENAME)
    try:
        with open(manifest_path, "rb") as fh:
            raw = fh.read(MAX_MANIFEST_BYTES + 1)
    except FileNotFoundError:
        return {}
    except OSError as exc:
        raise _ManifestError("unable to read fonts.json (%s)" % exc)

    if len(raw) > MAX_MANIFEST_BYTES:
        raise _ManifestError("fonts.json exceeds %d bytes" % MAX_MANIFEST_BYTES)
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise _ManifestError("fonts.json is not valid UTF-8 (%s)" % exc)
    try:
        data = json.loads(text, object_pairs_hook=_no_duplicate_keys)
    except ValueError as exc:
        raise _ManifestError("fonts.json is not valid JSON (%s)" % exc)

    return _validate_root(data, font_dir)


def _compute_revision(families):
    parts = []
    for family_id in sorted(families):
        family = families[family_id]
        face_parts = ";".join(
            "%s|%d|%s|%s|%d|%d" % (face.id, face.weight, face.style,
                                    os.path.basename(face.path), face.size, face.mtime_ns)
            for face in (family.faces[face_id] for face_id in sorted(family.faces))
        )
        parts.append("%s|%s|%s|%s" % (family.id, family.name, family.fallback, face_parts))
    digest = hashlib.sha256("\n".join(parts).encode("utf-8")).hexdigest()
    return digest[:16]


def refresh_snapshot():
    """Re-validate the font directory from disk and publish a new immutable
    snapshot. Any manifest-level problem fails closed to an empty snapshot
    rather than continuing to serve a previous good one."""
    global _current_snapshot

    font_dir = _resolve_font_dir()
    families = {}
    if font_dir is not None and os.path.isdir(font_dir):
        try:
            families = _load_and_validate(font_dir)
        except _ManifestError as exc:
            _warn_once(("manifest", font_dir, str(exc)), "ignoring fonts.json (%s)" % exc)
            families = {}

    snapshot = EMPTY_SNAPSHOT if not families else FontSnapshot(
        revision=_compute_revision(families), families=families)

    with _snapshot_lock:
        _current_snapshot = snapshot
    return snapshot


def _peek_snapshot():
    with _snapshot_lock:
        return _current_snapshot


def face_url(family_id, face_id, revision):
    return "/reader/fonts/%s/%s?v=%s" % (family_id, face_id, revision)


def get_public_catalog():
    snapshot = refresh_snapshot()
    fonts = []
    for family in snapshot.families.values():
        faces = [{"id": face.id, "weight": face.weight, "style": face.style,
                   "url": face_url(family.id, face.id, snapshot.revision)}
                  for face in family.faces.values()]
        fonts.append({"id": family.id, "name": family.name, "fallback": family.fallback, "faces": faces})
    return {"version": 1, "revision": snapshot.revision, "fonts": fonts}


def get_face(font_id, face_id, revision):
    """Return the FaceRecord for a URL that matches the currently published
    snapshot exactly, or None if the font/face/revision is not current."""
    snapshot = _peek_snapshot()
    if snapshot is EMPTY_SNAPSHOT:
        # A font-file request can reach a worker process that has never
        # served a manifest request yet; warm it once instead of 404-ing.
        snapshot = refresh_snapshot()
    if revision != snapshot.revision:
        return None
    family = snapshot.families.get(font_id)
    if family is None:
        return None
    return family.faces.get(face_id)


def invalidate_for_test():
    global _current_snapshot
    with _snapshot_lock:
        _current_snapshot = EMPTY_SNAPSHOT
    with _warn_lock:
        _warned_fingerprints.clear()
