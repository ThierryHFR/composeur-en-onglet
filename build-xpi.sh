#!/bin/sh

set -eu

script_name=$(basename "$0")
project_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
version=$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$project_dir/manifest.json" | head -n 1)

if [ -z "$version" ]; then
    echo "Unable to read the extension version from manifest.json." >&2
    exit 1
fi

output=${1:-"dist/tab-composer-${version}.xpi"}
case "$output" in
    /*) ;;
    *) output="$project_dir/$output" ;;
esac

if ! command -v zip >/dev/null 2>&1; then
    echo "The zip command is required to build the XPI." >&2
    exit 1
fi

mkdir -p "$(dirname -- "$output")"
temporary_dir=$(mktemp -d "${TMPDIR:-/tmp}/tab-composer-xpi.XXXXXX")
temporary_xpi="$temporary_dir/extension.xpi"
trap 'rm -rf "$temporary_dir"' EXIT HUP INT TERM

(
    cd "$project_dir"
    zip -q -r "$temporary_xpi" . \
        -x '.git' '.git/*' \
        -x 'PRIVACY.md' \
        -x 'test' 'test/*' \
        -x 'tests' 'tests/*' \
        -x "$script_name" \
        -x 'dist' 'dist/*'
)

mv -f "$temporary_xpi" "$output"
printf 'XPI created: %s\n' "$output"
