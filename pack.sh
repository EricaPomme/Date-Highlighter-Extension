#!/bin/sh
# pack.sh -- build the Date Highlighter store package and distribution bundle.
#
# Usage:
#   ./pack.sh                 write both archives into dist/
#   ./pack.sh -o DIR          write them into DIR instead
#   ./pack.sh -h              show this help
#
# The version is read from manifest.json, and nothing outside the payload list
# is packaged, so tests, node_modules, and the packaging scripts stay out.
#
# Artifacts:
#   dist/Date-Highlighter-<version>.zip          store package: the payload
#                                                with manifest.json at the
#                                                archive root, ready for the
#                                                Chrome Web Store, Edge
#                                                Add-ons, or addons.mozilla.org
#   dist/Date-Highlighter-<version>-bundle.tar.gz  the same payload plus
#                                                install.sh inside a single
#                                                Date-Highlighter/ folder
#
# The store package stays a .zip on every platform because the stores require
# zip uploads; only the bundle follows the Unix .tar.gz convention. Building
# the store package needs Info-ZIP `zip` or `python3` on PATH (zip is preferred
# when both are present); use pack.ps1 on Windows.
#
# Payload:  manifest.json content popup options icons
# Excluded: .git node_modules tests dist web-ext-artifacts
#
# Standalone POSIX sh: no bashisms and no dependencies beyond POSIX tools,
# tar, and zip. The payload and exclusion lists are duplicated across
# install.sh, pack.sh, and cleanup.sh by design, and are kept in sync with the
# .ps1 trio (the portability contract shared by the packaging skills).
set -eu

PAYLOAD_ITEMS='manifest.json content popup options icons'
EXCLUDED_DIRS='.git node_modules tests dist web-ext-artifacts'
INSTALLER_ITEM='install.sh'
ARCHIVE_NAME='Date-Highlighter'

# This script sits at the repository root, so its directory is the source tree.
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)

OUTPUT_DIR=

usage() {
    sed -n '2,29p' "$0" | sed 's/^# \{0,1\}//'
}

die() {
    printf '%s\n' "$*" >&2
    exit 1
}

size_kb() {
    awk "BEGIN { printf \"%.1f\", $(wc -c < "$1" | tr -d ' ') / 1024 }"
}

# Creates a zip from the named entries, run from the directory that holds them.
# Info-ZIP zip is preferred; python3's zipfile covers minimal images that ship
# without it, and both write the entry names verbatim so the archive root ends
# up with manifest.json and the payload tree.
make_zip() {
    _archive=$1
    shift
    if [ "$ZIP_TOOL" = 'zip' ]; then
        # shellcheck disable=SC2086 # the payload list is intentionally split
        zip -q -r "$_archive" "$@"
        return 0
    fi
    python3 - "$_archive" "$@" <<'PY'
import os
import sys
import zipfile

archive, items = sys.argv[1], sys.argv[2:]
with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as bundle:
    for item in items:
        if os.path.isdir(item):
            for root, dirs, files in os.walk(item):
                dirs.sort()
                for name in sorted(files):
                    path = os.path.join(root, name)
                    bundle.write(path, path)
        else:
            bundle.write(item, item)
PY
}

while [ $# -gt 0 ]; do
    case "$1" in
        -o|--output)
            [ $# -ge 2 ] || die "pack.sh: $1 needs a directory"
            OUTPUT_DIR=$2
            shift 2
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            usage >&2
            die "pack.sh: unknown option: $1"
            ;;
    esac
done

# Validate the payload, the installer, and the tools before staging anything.
missing=
for _item in $PAYLOAD_ITEMS $INSTALLER_ITEM; do
    [ -e "$SCRIPT_DIR/$_item" ] || missing="$missing $_item"
done
[ -z "$missing" ] || die "pack.sh: missing items in $SCRIPT_DIR:$missing"

command -v tar >/dev/null 2>&1 || die 'pack.sh: tar not found on PATH'
if command -v zip >/dev/null 2>&1; then
    ZIP_TOOL=zip
elif command -v python3 >/dev/null 2>&1; then
    ZIP_TOOL=python3
else
    die 'pack.sh: the store package needs Info-ZIP zip or python3 on PATH (use pack.ps1 on Windows)'
fi

# The version comes from the project's version manifest. Anchoring the pattern
# to the start of the line keeps "manifest_version" from matching.
version=$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*$/\1/p' "$SCRIPT_DIR/manifest.json" | head -n 1)
[ -n "$version" ] || die "pack.sh: could not read a version from $SCRIPT_DIR/manifest.json"

if [ -n "$OUTPUT_DIR" ]; then
    output_dir=$OUTPUT_DIR
else
    output_dir=$SCRIPT_DIR/dist
fi
store_archive=$output_dir/$ARCHIVE_NAME-$version.zip
bundle_archive=$output_dir/$ARCHIVE_NAME-$version-bundle.tar.gz

staging_dir=$(mktemp -d "${TMPDIR:-/tmp}/$ARCHIVE_NAME-pack.XXXXXX")
trap 'rm -rf "$staging_dir"' EXIT HUP INT TERM

store_stage=$staging_dir/store
bundle_stage=$staging_dir/bundle
wrapper=$bundle_stage/$ARCHIVE_NAME
mkdir -p "$store_stage" "$wrapper"

# Stage the payload at the archive root and inside the wrapper folder.
for _item in $PAYLOAD_ITEMS; do
    if [ -d "$SCRIPT_DIR/$_item" ]; then
        cp -Rp "$SCRIPT_DIR/$_item" "$store_stage/$_item"
        cp -Rp "$SCRIPT_DIR/$_item" "$wrapper/$_item"
    else
        cp -p "$SCRIPT_DIR/$_item" "$store_stage/$_item"
        cp -p "$SCRIPT_DIR/$_item" "$wrapper/$_item"
    fi
done
cp -p "$SCRIPT_DIR/$INSTALLER_ITEM" "$wrapper/$INSTALLER_ITEM"

store_files=$(find "$store_stage" -type f | wc -l | tr -d ' ')
bundle_files=$(find "$wrapper" -type f | wc -l | tr -d ' ')

mkdir -p "$output_dir"

# Store package: the payload entries are named explicitly so the archive root
# holds manifest.json and the directory tree, with no wrapper folder.
(cd "$store_stage" && make_zip "$store_archive" $PAYLOAD_ITEMS)
# Bundle: pass the wrapper folder so the archive root contains it, mirroring
# the installed layout.
tar -czf "$bundle_archive" -C "$bundle_stage" "$ARCHIVE_NAME"

printf 'Packaged %s %s\n' "$ARCHIVE_NAME" "$version"
printf '  %-14s %s (%s files, %s KB)\n' 'Store package' "$store_archive" "$store_files" "$(size_kb "$store_archive")"
printf '  %-14s %s (%s files, %s KB)\n' 'Bundle' "$bundle_archive" "$bundle_files" "$(size_kb "$bundle_archive")"
printf 'Store package: upload it to the Chrome Web Store, Edge Add-ons, or addons.mozilla.org.\n'
printf 'Bundle: extract %s/ into the install location, or extract it anywhere and run install.sh.\n' "$ARCHIVE_NAME"
