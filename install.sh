#!/bin/sh
# install.sh -- install Date Highlighter as an unpacked browser extension.
#
# Usage:
#   ./install.sh              install into the default user-level folder
#   ./install.sh -p DIR       install into DIR instead
#   DEST=DIR ./install.sh     same, through the environment
#   ./install.sh -n           dry run: report the action, change nothing
#   ./install.sh -h           show this help
#
# The default destination is
# ${XDG_DATA_HOME:-$HOME/.local/share}/Date-Highlighter/extension, mirroring
# %LOCALAPPDATA%\Date-Highlighter\extension on Windows.
#
# Payload:  manifest.json content popup options
# Excluded: .git node_modules tests dist web-ext-artifacts
#
# Standalone POSIX sh: no bashisms and no dependencies beyond POSIX tools.
# The payload and exclusion lists are duplicated across install.sh, pack.sh,
# and cleanup.sh by design, and are kept in sync with the .ps1 trio (the
# portability contract shared by the packaging skills).
set -eu

PAYLOAD_ITEMS='manifest.json content popup options'
EXCLUDED_DIRS='.git node_modules tests dist web-ext-artifacts'
EXTENSION_NAME='Date Highlighter'

# This script sits at the repository root, so its directory is the source tree.
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)

DRY_RUN=0
DEST_OPT=

usage() {
    sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'
}

die() {
    printf '%s\n' "$*" >&2
    exit 1
}

# Verifies writability with a real create/delete probe. An actual probe is
# ground truth; permission bits and ACLs are not. The template argument works
# on both GNU and BSD mktemp (BSD mktemp has no -p).
probe_writable() {
    _dir=$1
    if _probe=$(mktemp "$_dir/.dh-probe.XXXXXX" 2>/dev/null); then
        rm -f "$_probe"
        return 0
    fi
    return 1
}

# Copies a directory tree, pruning excluded directory names during the walk.
# The prune predicate is built without eval: each name contributes
# "-name NAME -o" and a trailing -false closes the chain.
copy_tree() {
    _src=$1
    _dest=$2
    mkdir -p "$_dest"
    set --
    for _name in $EXCLUDED_DIRS; do
        set -- "$@" -name "$_name" -o
    done
    (cd "$_src" && find . \( "$@" -false \) -prune -o -type d -print) | while IFS= read -r _dir; do
        mkdir -p "$_dest/$_dir"
    done
    (cd "$_src" && find . \( "$@" -false \) -prune -o -type f -print) | while IFS= read -r _file; do
        cp -p "$_src/$_file" "$_dest/$_file"
    done
}

while [ $# -gt 0 ]; do
    case "$1" in
        -p|--destination)
            [ $# -ge 2 ] || die "install.sh: $1 needs a directory"
            DEST_OPT=$2
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
            die "install.sh: unknown option: $1"
            ;;
    esac
done

# Validate the payload before touching any destination.
missing=
for _item in $PAYLOAD_ITEMS; do
    [ -e "$SCRIPT_DIR/$_item" ] || missing="$missing $_item"
done
[ -z "$missing" ] || die "install.sh: missing payload items in $SCRIPT_DIR:$missing"

if [ -n "$DEST_OPT" ]; then
    dest=$DEST_OPT
elif [ -n "${DEST:-}" ]; then
    dest=$DEST
else
    dest=${XDG_DATA_HOME:-$HOME/.local/share}/Date-Highlighter/extension
fi

# Probe the nearest existing ancestor: the folder that has to accept the copy
# or the folder that has to accept the new destination itself.
probe_target=$dest
while [ ! -d "$probe_target" ]; do
    parent=$(dirname -- "$probe_target")
    [ "$parent" != "$probe_target" ] || break
    probe_target=$parent
done

if [ ! -d "$probe_target" ] || ! probe_writable "$probe_target"; then
    {
        printf 'Cannot install %s: no writable location found.\n\n' "$EXTENSION_NAME"
        printf 'Destination:  %s\n' "$dest"
        printf 'Checked:      %s\n' "$probe_target"
        printf 'Payload:      %s\n\n' "$PAYLOAD_ITEMS"
        printf 'Create a writable destination yourself, then re-run this script:\n'
        printf '    mkdir -p "%s"\n' "$dest"
        printf 'Locations under /usr or /opt may require an elevated session (sudo).\n'
    } >&2
    exit 1
fi

if [ -d "$dest" ]; then
    action="replace the existing install and copy the payload to '$dest'"
else
    action="copy the payload to '$dest'"
fi

if [ "$DRY_RUN" -eq 1 ]; then
    printf '[dry-run] would %s\n' "$action"
    exit 0
fi

# Clean replace: an existing install is removed first, so no stale file from an
# earlier version can survive the upgrade.
if [ -d "$dest" ]; then
    rm -rf "$dest"
fi
mkdir -p "$dest"

for _item in $PAYLOAD_ITEMS; do
    if [ -d "$SCRIPT_DIR/$_item" ]; then
        copy_tree "$SCRIPT_DIR/$_item" "$dest/$_item"
    else
        cp -p "$SCRIPT_DIR/$_item" "$dest/$_item"
    fi
done

installed=$(find "$dest" -type f | wc -l | tr -d ' ')
printf 'Installed %s files to %s\n' "$installed" "$dest"
printf 'Load it as an unpacked extension:\n'
printf '  Chromium (Chrome, Edge): chrome://extensions -> Developer mode -> Load unpacked -> %s\n' "$dest"
printf '  Firefox:                 about:debugging#/runtime/this-firefox -> Load Temporary Add-on -> %s\n' "$dest/manifest.json"
