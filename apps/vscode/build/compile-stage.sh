#!/bin/sh
# Runs INSIDE the build container (apps/vscode/build.sh starts it, after install-stage.sh): compiles VS Code's server and web workbench
# the way the gulp task `vscode-reh-web-linux-arm64-min` does (build/gulpfile.reh.ts), step by step, without the built-in Copilot
# extension (not shipped, CONVERSION.md):
#
#   copy-codicons, compile-api-proposal-names         as the gulp task
#   clean-extensions-build                            as the gulp task (an rm -rf of .build/extensions)
#   compile-non-native-extensions-build               the built-in extensions, and the marketplace ones of product.json (js-debug, ...),
#                                                     downloaded from their GitHub releases and checked against product.json's sha256
#   compile-native-extensions-build                   as the gulp task
#   compile-extension-media-build                     as the gulp task
#   (compile-copilot-extension-build is the step left out)
#   EXCLUDED_EXTENSIONS removed from .build/extensions   the extensions not shipped (CONVERSION.md), before the bundle bakes the list
#                                                     of built-in web extensions into the workbench
#   build/next/index.ts bundle --minify --nls --target server-web --out out-vscode-reh-web-min    the esbuild bundle of the gulp task
#
#   /src                  the patched VS Code tree with its node_modules (install-stage.sh)
#   BUILD_SOURCEVERSION   the commit (VS Code's build reads it from this variable when there is no .git: build/lib/getVersion.ts)
#   VSCODE_COMMIT_DATE    the commit's date, written to out-build/date (the build's "date" otherwise falls back to the current time)
#   EXCLUDED_EXTENSIONS   built-in extensions not shipped (comma-separated)
set -eu
: "${BUILD_SOURCEVERSION:?BUILD_SOURCEVERSION is not set}"
: "${VSCODE_COMMIT_DATE:?VSCODE_COMMIT_DATE is not set}"
cd /src
export npm_config_update_notifier=false
node --version

mkdir -p out-build
printf '%s' "$VSCODE_COMMIT_DATE" > out-build/date

gulp() {
    echo "== gulp $*"
    node --experimental-strip-types --max-old-space-size=8192 ./node_modules/gulp/bin/gulp.js "$@"
}
gulp copy-codicons
gulp compile-api-proposal-names
echo "== clean-extensions-build (defined in build/gulpfile.extensions.ts but not registered as a task: the same rimraf here)"
rm -rf .build/extensions
gulp compile-non-native-extensions-build
gulp compile-native-extensions-build
gulp compile-extension-media-build

# The extensions that are not shipped leave .build/extensions before the bundle: the server-web bundle bakes the list of built-in web
# extensions it finds there into the workbench (build/next/index.ts), and the server is packaged from the same folder.
echo "== left out: ${EXCLUDED_EXTENSIONS:-none}"
for e in $(printf '%s' "${EXCLUDED_EXTENSIONS:-}" | tr ',' ' '); do
    case "$e" in '' | *[!A-Za-z0-9._-]*) echo "bad extension name: $e" >&2; exit 1 ;; esac
    rm -rf ".build/extensions/$e"
done

echo "== esbuild bundle (server-web, minified, NLS)"
node --max-old-space-size=8192 build/next/index.ts bundle --minify --nls --target server-web --out out-vscode-reh-web-min

echo "== results"
ls .build/extensions | tr '\n' ' '
echo
du -sh out-vscode-reh-web-min .build/extensions
