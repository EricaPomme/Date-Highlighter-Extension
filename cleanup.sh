#!/bin/sh
# cleanup.sh -- remove build artifacts from the Date Highlighter repository.
#
# Usage:
#   ./cleanup.sh              remove the artifact folders below
#   ./cleanup.sh -n           dry run: report what would be removed
#   ./cleanup.sh -p ROOT      clean ROOT instead of this script's folder
#   ./cleanup.sh -h           show this help
#
# Artifacts removed (allowlist, nothing else is ever touched):
#   dist/                store packages and bundles written by pack.sh/pack.ps1
#   web-ext-artifacts/   output from "npx web-ext build"
#
# The repository root must contain .git or manifest.json before anything is
# removed, so running this script from the wrong folder cannot delete unrelated
# data. Sources, tests, node_modules, and an installed copy are left alone.
#
# Standalone POSIX sh: no bashisms and no dependencies beyond POSIX tools.
# The payload and artifact lists are duplicated across install.sh, pack.sh,
# and cleanup.sh by design, and are kept in sync with the .ps1 trio (the
# portability contract shared by the packaging skills).
set -eu

ARTIFACT_DIRS='dist web-ext-artifacts'
PROTECTED_ITEMS='manifest.json content popup options tests install.sh pack.sh cleanup.sh'
MARKERS='.git manifest.json'

# This script sits at the repository root, so its directory is the repository.
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)

DRY_RUN=0
ROOT_OPT=

usage() {
    sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'
}

die() {
    printf '%s\n' "$*" >&2
    exit 1
}

# Refuses a target unless it is a directory strictly inside the root whose leaf
# name is on the artifact allowlist. Every rm -rf passes through this. The guard
# uses its own variable names because POSIX sh has no function scope: reusing a
# caller's variable here silently rewrites the caller's loop state.
is_safe_target() {
    _guard_target=$1
    _guard_leaf=$2
    [ -n "$_guard_target" ] || return 1
    [ -d "$_guard_target" ] || return 1
    [ "$_guard_target" != "$root" ] || return 1
    case "$_guard_leaf" in
        ''|*/*) return 1 ;;
    esac
    _guard_allowed=0
    for _guard_name in $ARTIFACT_DIRS; do
        [ "$_guard_leaf" = "$_guard_name" ] && _guard_allowed=1
    done
    [ "$_guard_allowed" -eq 1 ] || return 1
    _guard_canonical=$(CDPATH= cd -- "$_guard_target" && pwd -P)
    case "$_guard_canonical" in
        "$root"/*) return 0 ;;
        *) return 1 ;;
    esac
}

while [ $# -gt 0 ]; do
    case "$1" in
        -p|--path)
            [ $# -ge 2 ] || die "cleanup.sh: $1 needs a directory"
            ROOT_OPT=$2
            shift 2
            ;;
        -n|--dry-run)
            DRY_RUN=1
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            usage >&2
            die "cleanup.sh: unknown option: $1"
            ;;
    esac
done

if [ -n "$ROOT_OPT" ]; then
    [ -d "$ROOT_OPT" ] || die "cleanup.sh: repository root not found: $ROOT_OPT"
    root=$(CDPATH= cd -- "$ROOT_OPT" && pwd -P)
else
    root=$SCRIPT_DIR
fi

# Marker guard: refuse to delete anything outside a Date Highlighter checkout.
marked=0
for _marker in $MARKERS; do
    [ -e "$root/$_marker" ] && marked=1
done
[ "$marked" -eq 1 ] || die "cleanup.sh: refusing to clean $root: neither .git nor manifest.json is present"

removed=0
matched=0
total_files=0
for _name in $ARTIFACT_DIRS; do
    _target=$root/$_name
    for _protected in $PROTECTED_ITEMS; do
        [ "$_name" = "$_protected" ] && die "cleanup.sh: refusing to remove '$_name': it is part of the payload"
    done
    if [ ! -d "$_target" ]; then
        continue
    fi
    is_safe_target "$_target" "$_name" || die "cleanup.sh: refusing to remove unsafe target: $_target"
    _files=$(find "$_target" -type f | wc -l | tr -d ' ')
    matched=$((matched + 1))
    total_files=$((total_files + _files))
    if [ "$DRY_RUN" -eq 1 ]; then
        printf '[dry-run] would remove %s (%s files)\n' "$_name" "$_files"
        continue
    fi
    rm -rf "$_target"
    printf 'Removed %s (%s files)\n' "$_name" "$_files"
    removed=$((removed + 1))
done

if [ "$matched" -eq 0 ]; then
    if [ "$DRY_RUN" -eq 1 ]; then
        printf '[dry-run] nothing to clean: no build artifacts found.\n'
    else
        printf 'Nothing to clean: no build artifacts found.\n'
    fi
    exit 0
fi

if [ "$DRY_RUN" -eq 1 ]; then
    printf '[dry-run] %s artifact folder(s) would be removed: %s files.\n' "$matched" "$total_files"
    exit 0
fi

printf 'Cleaned %s artifact folder(s): %s files removed.\n' "$removed" "$total_files"
printf 'Source files, tests, node_modules, and an installed copy of the extension were not touched.\n'
