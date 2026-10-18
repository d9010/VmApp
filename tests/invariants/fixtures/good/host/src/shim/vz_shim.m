/*
 * Fixture of the VZ shim: the VM configuration has NO network device. (A comment may say VZNATNetworkDeviceAttachment.)
 */
#import <Virtualization/Virtualization.h>

static NSString *validate(VZVirtualMachineConfiguration *cfg) {
    NSMutableArray<NSString *> *bad = [NSMutableArray array];
    if (cfg.networkDevices.count > 0) {
        [bad addObject:@"network"];
    }
    return [bad componentsJoinedByString:@", "];
}

VZVirtualMachineConfiguration *vmapp_make_config(NSString *kernel) {
    VZVirtualMachineConfiguration *cfg = [[VZVirtualMachineConfiguration alloc] init];
    VZLinuxBootLoader *boot = [[VZLinuxBootLoader alloc] initWithKernelURL:[NSURL fileURLWithPath:kernel]];
    cfg.bootLoader = boot;
    (void)validate(cfg);
    return cfg;
}
