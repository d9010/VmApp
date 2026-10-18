#!/bin/bash
# Full vulkaninfo as JSON (Vulkan Profiles schema: api version, extensions, features, properties/limits, formats) and
# text into /work (virtiofs, read-write), for the "vmapp GPU profile" and the host-translator comparison.
. /spike/env.sh
tag=${SPIKE_TAG:-venus}
cd /work || exit 1
rm -f VP_VULKANINFO_*.json
vulkaninfo --json >/work/vkinfo-$tag.stdout 2>/work/vkinfo-$tag.err
echo "vulkaninfo --json rc=$?"
for f in VP_VULKANINFO_*.json; do [ -f "$f" ] && mv "$f" /work/vkinfo-$tag.json && echo "json: $(wc -c </work/vkinfo-$tag.json) bytes"; done
vulkaninfo --show-formats >/work/vkinfo-$tag.txt 2>&1
echo "vulkaninfo (text, formats) rc=$? lines=$(wc -l </work/vkinfo-$tag.txt)"
vulkaninfo --summary 2>&1 | grep -v mvk-info | head -40
