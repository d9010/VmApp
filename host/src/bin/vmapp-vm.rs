// Adapted from agent-vm/host/src/bin/avm.rs (agent-vm commit 8f0c069)
//
//! `vmapp-vm run ...`: the host launcher (Virtualization.framework). The command line, the stdin protocol and the main
//! loop are in `vmapp::cli`, shared with the experimental libkrun launcher `vmapp-vm-krun`. The launcher contract is in
//! vmapp/SPEC.md section 5.

fn main() -> std::process::ExitCode {
    vmapp::cli::run(vmapp::cli::Kind::Vz)
}
