#!/bin/sh
# Runs INSIDE the build container (apps/vscode/build.sh starts it, after compile-stage.sh): assembles the VS Code server for linux-arm64.
#
#   /src                  the compiled VS Code tree; build/vmapp-package-server.ts is apps/vscode/build/package-server.ts (build.sh)
#   /out                  receives server/ (what the core runs: core/vscode/) and web/ (what the window loads: ui/static/)
#   BUILD_SOURCEVERSION   the commit (product.json "commit")
#   EXCLUDED_EXTENSIONS   built-in extensions not shipped (comma-separated)
#   EXCLUDED_MODULES      dependencies of remote/package.json not shipped (comma-separated)
#
# The server's out/ holds both halves of the reh-web build: the server's bundles and the web workbench, which the server would serve to
# a browser. Here the window loads the workbench from the package (ui/static/, the same files at the same paths as the server's
# /static/ route), so each half goes where it runs:
#   server/  the server without the web workbench's bundles (the big ones: the workbench, its CSS, the web workers, keyboard layouts)
#   web/     static/out (out/ without the server's own bundles), static/node_modules (remote/web's packages: every browser dependency
#            of the workbench, with their WebAssembly (Oniguruma, tree-sitter; the window declares "wasm"), filtered as packageTask filters
#            the server's: no source maps, lock files, test folders or .bin), static/extensions (the images and fonts of the built-in
#            extensions, for <img> and @font-face, which cannot go through the bridge), static/resources/server (icons)
# The server's Node is shipped as upstream ships it (the core is a core.erofs image: its size costs no memory, SPEC 2.1).
set -eu
: "${BUILD_SOURCEVERSION:?BUILD_SOURCEVERSION is not set}"
cd /src
echo "== gulp node-linux-arm64 (the server's Node from nodejs.org, checked against build/checksums/nodejs.txt)"
node --experimental-strip-types --max-old-space-size=8192 ./node_modules/gulp/bin/gulp.js node-linux-arm64
echo "== package the server"
rm -rf /out/server /out/web
node --experimental-strip-types --max-old-space-size=8192 build/vmapp-package-server.ts /out/server "${EXCLUDED_EXTENSIONS:-}" "${EXCLUDED_MODULES:-}"
cd /out/server
echo "== the server's Node: $(./node --version) ($(stat -c %s node) bytes)"

# the server's command line helpers, as packageTask adds them for linux: `code-oss <file>` in the integrated terminal opens the file in the
# window, and $BROWSER (helpers/browser.sh) opens a link through the window (which asks the platform, which asks the user)
APPNAME=$(node -p "require('/src/product.json').applicationName")
VERSION=$(node -p "require('/src/package.json').version")
mkdir -p bin/remote-cli bin/helpers
sed -e "s/@@VERSION@@/$VERSION/g" -e "s/@@COMMIT@@/$BUILD_SOURCEVERSION/g" -e "s/@@APPNAME@@/$APPNAME/g" \
    /src/resources/server/bin/remote-cli/code-linux.sh > "bin/remote-cli/$APPNAME"
sed -e "s/@@VERSION@@/$VERSION/g" -e "s/@@COMMIT@@/$BUILD_SOURCEVERSION/g" -e "s/@@APPNAME@@/$APPNAME/g" \
    /src/resources/server/bin/helpers/browser-linux.sh > bin/helpers/browser.sh
chmod 755 "bin/remote-cli/$APPNAME" bin/helpers/browser.sh

# the web workbench's files, by the entry points of build/next/index.ts (target server-web) that run in the browser
WEB_ONLY='vs/code/browser/workbench/workbench.js
vs/code/browser/workbench/workbench.css
vs/editor/common/services/editorWebWorkerMain.js
vs/workbench/api/worker/extensionHostWorkerMain.js
vs/workbench/contrib/notebook/common/services/notebookWebWorkerMain.js
vs/workbench/services/languageDetection/browser/languageDetectionWebWorkerMain.js
vs/workbench/services/search/worker/localFileSearchMain.js
vs/workbench/contrib/output/common/outputLinkComputerMain.js
vs/workbench/services/textMate/browser/backgroundTokenization/worker/textMateTokenizationWorker.workerMain.js'
# the server's own bundles (getBootstrapEntryPointsForTarget('server-web') and serverEntryPoints) and the NLS data only it reads
SERVER_ONLY='server-main.js
server-cli.js
bootstrap-fork.js
vs/workbench/api/node
vs/platform/files/node
vs/platform/terminal/node
vs/platform/agentHost/node
nls.metadata.json
nls.keys.json
nls.messages.json'

mkdir -p /out/web/static
cp -a out /out/web/static/out
for f in $SERVER_ONLY; do rm -rf "/out/web/static/out/$f"; done
for f in $WEB_ONLY; do rm -f "out/$f"; done
rm -rf out/vs/workbench/services/keybinding/browser/keyboardLayouts

# packageTask's filter of production dependencies: '!**/package-lock.json', '!**/*.{js,css}.map', '!<dep>/**/{test,tests}/**', '!<dep>/.bin/**'
mkdir -p /out/web/static/node_modules
(cd /src/remote/web/node_modules && find . -type f \
    ! -name '*.js.map' ! -name '*.css.map' ! -name 'package-lock.json' ! -path './.package-lock.json' \
    ! -path '*/test/*' ! -path '*/tests/*' ! -path '*/.bin/*' \
    -exec cp --parents {} /out/web/static/node_modules/ \;)

mkdir -p /out/web/static/extensions
(cd extensions && find . -type f \( -iname '*.png' -o -iname '*.svg' -o -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.gif' -o -iname '*.webp' \
    -o -iname '*.woff' -o -iname '*.woff2' -o -iname '*.ttf' -o -iname '*.otf' \) ! -path './node_modules/*' ! -path '*/node_modules/*' \
    -exec cp --parents {} /out/web/static/extensions/ \;)

mkdir -p /out/web/static/resources/server
cp /src/resources/server/favicon.ico /src/resources/server/code-192.png /src/resources/server/code-512.png /out/web/static/resources/server/

echo "== native modules"
find . -name '*.node' | sort
echo "== sizes (MiB)"
du -sm node out extensions node_modules | sort -n
du -sm . | awk '{print "server total " $1}'
du -sm /out/web/static/* | sort -n
du -sm /out/web | awk '{print "web total " $1}'
