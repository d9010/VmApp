/*
 * Copied from gpu/venus-spike/guest/tools/vk-spin.c in this repository (GOVERNANCE INV-G4: copied code names its source).
 * The only change: the shader spin.comp.spv is read from the folder of the executable (or $VK_SPV_DIR) instead of the
 * spike's fixed /opt/spike-tools, so the tool works from /app/bin in the test core.
 *
 * vk-spin: submit ONE compute dispatch that runs for a chosen number of iterations and report how long it took and
 * whether the device survived. Used to probe GPU watchdog / device-lost behaviour through Venus.
 *
 *   vk-spin ITERS [GROUPS]       ITERS = loop count per invocation (default 1000000), GROUPS = workgroups of 256 (default 65536)
 *   VK_DEVICE_INDEX=n            pick physical device n (default: first non-llvmpipe)
 *   VK_SPV_DIR=dir               where spin.comp.spv is (default: the folder of this executable)
 *
 * Exit: 0 finished, 3 device lost / error. Vulkan 1.0 core only. Apache-2.0, spike tool.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <vulkan/vulkan.h>

static double now(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec + t.tv_nsec * 1e-9; }
#define CK(x) do { VkResult r_ = (x); if (r_ != VK_SUCCESS) { printf("%s -> %d\n", #x, (int)r_); fflush(stdout); exit(3); } } while (0)

/* Path of a shader file: $VK_SPV_DIR/name, else next to this executable. */
static const char *spv_path(const char *name) {
    static char path[4096];
    char self[4096];
    const char *dir = getenv("VK_SPV_DIR");
    if (!dir) {
        ssize_t n = readlink("/proc/self/exe", self, sizeof self - 1);
        if (n > 0) { self[n] = 0; char *s = strrchr(self, '/'); if (s) { *s = 0; dir = self; } }
    }
    snprintf(path, sizeof path, "%s/%s", dir ? dir : ".", name);
    return path;
}

int main(int argc, char **argv) {
    uint32_t iters = argc > 1 ? (uint32_t)strtoul(argv[1], NULL, 10) : 1000000u;
    uint32_t groups = argc > 2 ? (uint32_t)strtoul(argv[2], NULL, 10) : 65536u;
    VkApplicationInfo app = {.sType = VK_STRUCTURE_TYPE_APPLICATION_INFO, .apiVersion = VK_API_VERSION_1_0};
    VkInstanceCreateInfo ici = {.sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO, .pApplicationInfo = &app};
    VkInstance inst; CK(vkCreateInstance(&ici, NULL, &inst));
    uint32_t n = 0; CK(vkEnumeratePhysicalDevices(inst, &n, NULL));
    VkPhysicalDevice pds[8]; if (n > 8) n = 8; CK(vkEnumeratePhysicalDevices(inst, &n, pds));
    int pick = -1; const char *forced = getenv("VK_DEVICE_INDEX");
    for (uint32_t i = 0; i < n; i++) {
        VkPhysicalDeviceProperties p; vkGetPhysicalDeviceProperties(pds[i], &p);
        if (forced ? (int)i == atoi(forced) : (pick < 0 && !strstr(p.deviceName, "llvmpipe"))) pick = (int)i;
    }
    if (pick < 0) { printf("no device\n"); return 3; }
    VkPhysicalDevice pd = pds[pick];
    VkPhysicalDeviceProperties props; vkGetPhysicalDeviceProperties(pd, &props);
    printf("device: %s, iters=%u groups=%u (%.1f M invocations)\n", props.deviceName, iters, groups, groups * 256.0 / 1e6);

    uint32_t nq = 0; vkGetPhysicalDeviceQueueFamilyProperties(pd, &nq, NULL);
    VkQueueFamilyProperties qf[8]; if (nq > 8) nq = 8; vkGetPhysicalDeviceQueueFamilyProperties(pd, &nq, qf);
    uint32_t qfi = 0; for (uint32_t i = 0; i < nq; i++) if (qf[i].queueFlags & VK_QUEUE_COMPUTE_BIT) { qfi = i; break; }
    float prio = 1.0f;
    VkDeviceQueueCreateInfo dq = {.sType = VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO, .queueFamilyIndex = qfi, .queueCount = 1, .pQueuePriorities = &prio};
    VkDeviceCreateInfo dci = {.sType = VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO, .queueCreateInfoCount = 1, .pQueueCreateInfos = &dq};
    VkDevice dev; CK(vkCreateDevice(pd, &dci, NULL, &dev));
    VkQueue q; vkGetDeviceQueue(dev, qfi, 0, &q);

    VkDeviceSize bytes = (VkDeviceSize)groups * 256 * 4;
    VkBufferCreateInfo bci = {.sType = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO, .size = bytes, .usage = VK_BUFFER_USAGE_STORAGE_BUFFER_BIT};
    VkBuffer buf; CK(vkCreateBuffer(dev, &bci, NULL, &buf));
    VkMemoryRequirements mr; vkGetBufferMemoryRequirements(dev, buf, &mr);
    VkPhysicalDeviceMemoryProperties mp; vkGetPhysicalDeviceMemoryProperties(pd, &mp);
    uint32_t mt = 0; for (uint32_t i = 0; i < mp.memoryTypeCount; i++) if (mr.memoryTypeBits & (1u << i)) { mt = i; break; }
    VkMemoryAllocateInfo mai = {.sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO, .allocationSize = mr.size, .memoryTypeIndex = mt};
    VkDeviceMemory mem; CK(vkAllocateMemory(dev, &mai, NULL, &mem)); CK(vkBindBufferMemory(dev, buf, mem, 0));

    const char *spv = spv_path("spin.comp.spv");
    FILE *f = fopen(spv, "rb");
    if (!f) { printf("missing %s\n", spv); return 2; }
    fseek(f, 0, SEEK_END); long sz = ftell(f); fseek(f, 0, SEEK_SET);
    uint32_t *code = malloc((size_t)sz); if (fread(code, 1, (size_t)sz, f) != (size_t)sz) return 2; fclose(f);
    VkShaderModuleCreateInfo smci = {.sType = VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO, .codeSize = (size_t)sz, .pCode = code};
    VkShaderModule sm; CK(vkCreateShaderModule(dev, &smci, NULL, &sm));
    VkDescriptorSetLayoutBinding b = {.binding = 0, .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, .descriptorCount = 1, .stageFlags = VK_SHADER_STAGE_COMPUTE_BIT};
    VkDescriptorSetLayoutCreateInfo dslci = {.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO, .bindingCount = 1, .pBindings = &b};
    VkDescriptorSetLayout dsl; CK(vkCreateDescriptorSetLayout(dev, &dslci, NULL, &dsl));
    VkPushConstantRange pcr = {VK_SHADER_STAGE_COMPUTE_BIT, 0, 4};
    VkPipelineLayoutCreateInfo plci = {.sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO, .setLayoutCount = 1, .pSetLayouts = &dsl, .pushConstantRangeCount = 1, .pPushConstantRanges = &pcr};
    VkPipelineLayout pl; CK(vkCreatePipelineLayout(dev, &plci, NULL, &pl));
    VkComputePipelineCreateInfo cpci = {.sType = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO, .layout = pl,
        .stage = {.sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_COMPUTE_BIT, .module = sm, .pName = "main"}};
    VkPipeline pipe; CK(vkCreateComputePipelines(dev, VK_NULL_HANDLE, 1, &cpci, NULL, &pipe));
    VkDescriptorPoolSize ps = {VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1};
    VkDescriptorPoolCreateInfo dpci = {.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO, .maxSets = 1, .poolSizeCount = 1, .pPoolSizes = &ps};
    VkDescriptorPool dp; CK(vkCreateDescriptorPool(dev, &dpci, NULL, &dp));
    VkDescriptorSetAllocateInfo dsai = {.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO, .descriptorPool = dp, .descriptorSetCount = 1, .pSetLayouts = &dsl};
    VkDescriptorSet ds; CK(vkAllocateDescriptorSets(dev, &dsai, &ds));
    VkDescriptorBufferInfo dbi = {buf, 0, VK_WHOLE_SIZE};
    VkWriteDescriptorSet w = {.sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = ds, .descriptorCount = 1, .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, .pBufferInfo = &dbi};
    vkUpdateDescriptorSets(dev, 1, &w, 0, NULL);

    VkCommandPoolCreateInfo cpi = {.sType = VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO, .queueFamilyIndex = qfi};
    VkCommandPool pool; CK(vkCreateCommandPool(dev, &cpi, NULL, &pool));
    VkCommandBufferAllocateInfo cbai = {.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO, .commandPool = pool, .level = VK_COMMAND_BUFFER_LEVEL_PRIMARY, .commandBufferCount = 1};
    VkCommandBuffer cmd; CK(vkAllocateCommandBuffers(dev, &cbai, &cmd));
    VkCommandBufferBeginInfo cbbi = {.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO};
    CK(vkBeginCommandBuffer(cmd, &cbbi));
    vkCmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, pipe);
    vkCmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, pl, 0, 1, &ds, 0, NULL);
    vkCmdPushConstants(cmd, pl, VK_SHADER_STAGE_COMPUTE_BIT, 0, 4, &iters);
    vkCmdDispatch(cmd, groups, 1, 1);
    CK(vkEndCommandBuffer(cmd));
    VkFenceCreateInfo fci = {.sType = VK_STRUCTURE_TYPE_FENCE_CREATE_INFO};
    VkFence fence; CK(vkCreateFence(dev, &fci, NULL, &fence));
    VkSubmitInfo si = {.sType = VK_STRUCTURE_TYPE_SUBMIT_INFO, .commandBufferCount = 1, .pCommandBuffers = &cmd};
    double t0 = now();
    CK(vkQueueSubmit(q, 1, &si, fence));
    VkResult r = vkWaitForFences(dev, 1, &fence, VK_TRUE, 120ull * 1000000000ull);
    double dt = now() - t0;
    printf("vkWaitForFences -> %d after %.2f s (%s)\n", (int)r, dt, r == VK_SUCCESS ? "finished" : r == VK_TIMEOUT ? "TIMEOUT" : r == VK_ERROR_DEVICE_LOST ? "DEVICE LOST" : "error");
    fflush(stdout);
    return r == VK_SUCCESS ? 0 : 3;
}
