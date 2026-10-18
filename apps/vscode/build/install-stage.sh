#!/bin/sh
# Runs INSIDE the build container (apps/vscode/build.sh starts it): installs the npm dependencies of the parts of VS Code that this app
# builds, the way VS Code's own build/npm/preinstall.ts and postinstall.ts do, minus what the app does not ship.
#
#   /src                  the patched VS Code source tree (read-write: node_modules are created in it)
#   /root/.npm            the npm cache ($VMAPP_WORK/cache/npm)
#   /root/.cache/node-gyp the Node headers for node-gyp ($VMAPP_WORK/cache/node-gyp)
#   SERVER_NODE_VERSION   the Node the server runs on (remote/.npmrc "target"; build.sh checks they agree)
#
# Every `npm ci` installs exactly what that folder's package-lock.json says and checks each package's integrity hash.
#
# What differs from `npm ci` at the root (which runs postinstall.ts for every folder of build/npm/dirs.ts):
#   * the root and every folder but remote/ run WITHOUT install scripts. The root's scripts build the DESKTOP app's native modules
#     against Electron's headers and download Electron and Playwright; none of that is part of the server or the web workbench.
#   * remote/ runs its install scripts (only those package.json "allowScripts" lists): they compile the server's native modules
#     (node-pty, @parcel/watcher, @vscode/spdlog, @vscode/sqlite3, kerberos, ...) for Node SERVER_NODE_VERSION on linux-arm64, with
#     remote/.npmrc's settings, as postinstall.ts does (setNpmrcConfig('remote')).
#   * skipped folders: extensions/copilot (Chat is not shipped, CONVERSION.md), the test extensions, test/**, .vscode/extensions/**,
#     build/rspack, build/vite (dev tools).
set -eu
: "${SERVER_NODE_VERSION:?SERVER_NODE_VERSION is not set}"
cd /src
export npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false npm_config_progress=false
export ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
node --version
npm --version

ci() { # ci DIR [npm args...]: npm ci in DIR with a clean environment of npm_config_* from any .npmrc
    d=$1
    shift
    echo "== npm ci ${d:-.} $*"
    (cd "/src/$d" && npm ci --no-audit "$@")
}

# node-gyp, the one VS Code pins (build/npm/gyp), and the headers of the server's Node
ci build/npm/gyp --ignore-scripts
NODE_GYP=/src/build/npm/gyp/node_modules/.bin/node-gyp
"$NODE_GYP" install --dist-url https://nodejs.org/dist "$SERVER_NODE_VERSION"

ci "" --ignore-scripts
ci build --ignore-scripts

# remote/: remote/.npmrc's settings as npm_config_* variables, exactly as postinstall.ts's setNpmrcConfig('remote') does
(
    while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in '' | '#'*) continue ;; esac
        key=$(printf '%s' "${line%%=*}" | tr '-' '_') # npm reads npm_config_legacy_peer_deps as legacy-peer-deps
        value=${line#*=}
        value=${value#\"}
        value=${value%\"}
        export "npm_config_$key=$value"
    done < remote/.npmrc
    [ "$npm_config_target" = "$SERVER_NODE_VERSION" ] || { echo "remote/.npmrc target is $npm_config_target, not $SERVER_NODE_VERSION" >&2; exit 1; }
    export npm_config_node_gyp="$NODE_GYP"
    ci remote
)
# as postinstall.ts's removeParcelWatcherPrebuild: the watcher must be the one compiled above, not a prebuilt binary
rm -rf remote/node_modules/@parcel/watcher-*
ci remote/web --ignore-scripts

ci extensions --ignore-scripts
for pkg in extensions/*/package-lock.json extensions/*/server/package-lock.json; do
    d=${pkg%/package-lock.json}
    case "$d" in
        extensions/copilot | extensions/vscode-api-tests | extensions/vscode-colorize-tests | extensions/vscode-colorize-perf-tests | extensions/vscode-test-resolver) continue ;;
    esac
    ci "$d" --ignore-scripts
done

echo "== native modules of the server (remote/node_modules)"
find remote/node_modules -name '*.node' -path '*/build/Release/*' | sort
