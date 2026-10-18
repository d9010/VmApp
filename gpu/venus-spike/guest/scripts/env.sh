# Sourced by the tests: selects the Vulkan ICD (Venus) and optional Venus debug knobs.
#   SPIKE_MESA=patched  Mesa 26.2.5 Venus with the 16K blob alignment patch (default)
#   SPIKE_MESA=stock    Debian trixie's own mesa-vulkan-drivers (unpatched Venus)
case "${SPIKE_MESA:-patched}" in
    patched)
        export VK_ICD_FILENAMES=$(ls /opt/mesa-venus/share/vulkan/icd.d/virtio_icd*.json | head -1)
        export LD_LIBRARY_PATH=$(ls -d /opt/mesa-venus/lib/*-linux-gnu 2>/dev/null | head -1)${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}
        ;;
    upstream)
        # unmodified Mesa 26.2.5 Venus (needs a guest kernel that reports VIRTGPU_PARAM_BLOB_ALIGNMENT)
        export VK_ICD_FILENAMES=$(ls /opt/mesa-venus-upstream/share/vulkan/icd.d/virtio_icd*.json | head -1)
        export LD_LIBRARY_PATH=$(ls -d /opt/mesa-venus-upstream/lib/*-linux-gnu 2>/dev/null | head -1)${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}
        ;;
    stock)
        export VK_ICD_FILENAMES=$(ls /usr/share/vulkan/icd.d/virtio_icd*.json | head -1)
        ;;
esac
[ -n "${SPIKE_VN:-}" ] && export VN_DEBUG="$SPIKE_VN"
[ -n "${SPIKE_VN_PERF:-}" ] && export VN_PERF="$SPIKE_VN_PERF"
echo "[env] mesa=${SPIKE_MESA:-patched} ICD=$VK_ICD_FILENAMES VN_DEBUG=${VN_DEBUG:-} VN_PERF=${VN_PERF:-}"
