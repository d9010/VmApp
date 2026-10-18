/*
 * gpu-probe: the GPU liveness probe of the experimental Vulkan backend (SPEC 8.7). vmapp-init starts it, with the core's own
 * restrictions, in a VM that has a GPU (kernel command line vmapp.gpu=1), and reads what it prints on stdout:
 *
 *   B   a cycle begins        E   the cycle is done
 *
 * A cycle allocates a small block of host-visible GPU memory, maps it, touches it, unmaps and frees it. With Venus, mapping
 * such memory is a request the host's virtio-gpu worker must answer before the mapping exists, so a worker that is wedged (the
 * failure of the spike's REPORT B3/B4) leaves this program stuck between B and E while every other process of the guest keeps
 * running. The launcher's watchdog (host/src/krun.rs) reads how long the cycle has been stuck through the guest's `hello`.
 *
 * "B" is printed for the first time only after the instance, the device and the memory type were set up, so a guest without a
 * usable Vulkan device ends the program before any B and the probe is simply off.
 *
 * Plain Vulkan 1.0 and libc; the program writes nothing to disk and takes no argument. Exit 1: a Vulkan call failed. Exit 2: no
 * device or no host-visible memory.
 *
 * Licence: part of vmapp (see the repository), no third-party code.
 */
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <vulkan/vulkan.h>

#define CK(x)                                                                                                           \
    do {                                                                                                                \
        VkResult r_ = (x);                                                                                              \
        if (r_ != VK_SUCCESS) {                                                                                         \
            fprintf(stderr, "gpu-probe: %s failed: %d\n", #x, (int)r_);                                                 \
            return 1;                                                                                                   \
        }                                                                                                               \
    } while (0)

int main(void) {
    setvbuf(stdout, NULL, _IOLBF, 0);
    VkApplicationInfo app = {.sType = VK_STRUCTURE_TYPE_APPLICATION_INFO, .pApplicationName = "vmapp-gpu-probe", .apiVersion = VK_API_VERSION_1_0};
    VkInstanceCreateInfo ici = {.sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO, .pApplicationInfo = &app};
    VkInstance inst;
    CK(vkCreateInstance(&ici, NULL, &inst));
    uint32_t n = 0;
    CK(vkEnumeratePhysicalDevices(inst, &n, NULL));
    if (n == 0) {
        fprintf(stderr, "gpu-probe: no Vulkan device\n");
        return 2;
    }
    VkPhysicalDevice pds[8];
    if (n > 8) n = 8;
    CK(vkEnumeratePhysicalDevices(inst, &n, pds));
    VkPhysicalDevice pd = pds[0];

    uint32_t nq = 0;
    vkGetPhysicalDeviceQueueFamilyProperties(pd, &nq, NULL);
    if (nq == 0) return 2;
    float prio = 1.0f;
    VkDeviceQueueCreateInfo dq = {.sType = VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO, .queueFamilyIndex = 0, .queueCount = 1, .pQueuePriorities = &prio};
    VkDeviceCreateInfo dci = {.sType = VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO, .queueCreateInfoCount = 1, .pQueueCreateInfos = &dq};
    VkDevice dev;
    CK(vkCreateDevice(pd, &dci, NULL, &dev));

    VkPhysicalDeviceMemoryProperties mp;
    vkGetPhysicalDeviceMemoryProperties(pd, &mp);
    int type = -1;
    const VkMemoryPropertyFlags want = VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT;
    for (uint32_t i = 0; i < mp.memoryTypeCount; i++) {
        if ((mp.memoryTypes[i].propertyFlags & want) == want) {
            type = (int)i;
            break;
        }
    }
    if (type < 0) {
        fprintf(stderr, "gpu-probe: no host-visible memory type\n");
        return 2;
    }

    for (;;) {
        puts("B");
        VkMemoryAllocateInfo mai = {.sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO, .allocationSize = 65536, .memoryTypeIndex = (uint32_t)type};
        VkDeviceMemory mem;
        CK(vkAllocateMemory(dev, &mai, NULL, &mem));
        void *p = NULL;
        CK(vkMapMemory(dev, mem, 0, 65536, 0, &p));
        ((volatile char *)p)[0] = 1;
        vkUnmapMemory(dev, mem);
        vkFreeMemory(dev, mem, NULL);
        puts("E");
        usleep(500000);
    }
}
