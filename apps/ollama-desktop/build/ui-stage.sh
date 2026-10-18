#!/bin/sh
# Runs INSIDE a container of the node22 runtime's base image (apps/ollama-desktop/build.sh starts it): builds Ollama's React app.
#
#   /ui      app/ui/app of the patched source tree (read-write: node_modules and tsbuildinfo are created in it)
#   /out     receives dist/ (the built app) and THIRD-PARTY-LICENSES.txt
#   /stage   this folder (read-only)
#   npm_config_cache=/npmcache  the npm cache ($VMAPP_WORK/cache/npm)
#
# The steps are the ones of app/ui/app/package.json ("build": "tsc -b && vite build"); `npm ci` installs exactly what package-lock.json
# says (it fails when the lockfile and package.json disagree, and checks every package's integrity hash), without running install scripts.
set -eu
cd /ui
export npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
node --version
npm --version
npm ci --ignore-scripts
npx tsc -b
npx vite build --outDir /out/dist --emptyOutDir
node /stage/licenses.mjs /ui/package-lock.json /out/THIRD-PARTY-LICENSES.txt
echo "built: $(find /out/dist -type f | wc -l | tr -d ' ') files, $(du -sk /out/dist | awk '{print int($1 / 1024)}') MiB"
