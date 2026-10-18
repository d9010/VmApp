//! `vmapp-vm-krun run ...`: the EXPERIMENTAL launcher for apps that were granted the Vulkan GPU (SPEC 8.7). The same
//! command line and stdout/stdin protocol as `vmapp-vm` (SPEC 5), but the VM is run by libkrun on Hypervisor.framework
//! with a virtio-gpu (Venus) device, in a sandboxed child process of this launcher.
//!
//! One executable plays both roles. Started as `vmapp-vm-krun __vmm <spec.json>` it is the VMM child (it loads libkrun, applies
//! the sandbox profile and runs the VM; see `vmapp::krun`); otherwise it is the launcher, which holds the bridge, the
//! network proxy, the shares and the watchdog and is never given the GPU stack.

fn main() -> std::process::ExitCode {
    let mut args = std::env::args();
    if args.nth(1).as_deref() == Some("__vmm") {
        return vmapp::krun::vmm_main(args.next());
    }
    vmapp::cli::run(vmapp::cli::Kind::Krun)
}
