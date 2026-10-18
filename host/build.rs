// Adapted from agent-vm/host/build.rs (agent-vm commit 8f0c069)
//
// Compiles the Objective-C (ARC) shim over Virtualization.framework.
// Minimum macOS: 13.0. A higher MACOSX_DEPLOYMENT_TARGET in the environment is respected.

const MIN_MACOS: (u32, u32) = (13, 0);

fn deployment_target() -> String {
    let from_env = std::env::var("MACOSX_DEPLOYMENT_TARGET").ok().and_then(|v| {
        let mut parts = v.split('.');
        let major: u32 = parts.next()?.parse().ok()?;
        let minor: u32 = parts.next().map_or(Some(0), |m| m.parse().ok())?;
        Some((major, minor))
    });
    let (major, minor) = from_env.map_or(MIN_MACOS, |e| e.max(MIN_MACOS));
    format!("{major}.{minor}")
}

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=src/shim/vz_shim.h");
    println!("cargo:rerun-if-changed=src/shim/vz_shim.m");
    println!("cargo:rerun-if-env-changed=MACOSX_DEPLOYMENT_TARGET");
    println!("cargo:rerun-if-env-changed=SDKROOT");
    println!("cargo:rerun-if-env-changed=DEVELOPER_DIR");

    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    let min_macos = deployment_target();

    cc::Build::new()
        .file("src/shim/vz_shim.m")
        .flag("-fobjc-arc")
        // Clean up ARC-managed objects when an Objective-C exception unwinds through a frame
        // (the shim converts every exception to an error code).
        .flag("-fobjc-arc-exceptions")
        .flag("-fobjc-exceptions")
        .flag(format!("-mmacosx-version-min={min_macos}"))
        .flag("-Wall")
        .flag("-Wextra")
        .flag("-Wno-unused-parameter")
        .flag("-Wshadow")
        .flag("-Wunguarded-availability")
        .warnings(true)
        .compile("vmapp_vz_shim");

    println!("cargo:rustc-link-lib=framework=Virtualization");
    println!("cargo:rustc-link-lib=framework=Foundation");
    // SecTaskCopyValueForEntitlement (entitlement check).
    println!("cargo:rustc-link-lib=framework=Security");
    println!("cargo:rustc-link-arg=-mmacosx-version-min={min_macos}");
}
