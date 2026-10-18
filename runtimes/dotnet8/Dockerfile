# vmapp runtime "dotnet8": the shared .NET 8 runtime. Apps ship framework-dependent `dotnet publish` output and
# run ["dotnet", "App.dll"]. SPEC section 3.

# mcr.microsoft.com/dotnet/runtime:8.0 (linux/arm64, .NET 8.0.32 when pinned), pinned by digest.
FROM mcr.microsoft.com/dotnet/runtime@sha256:60d11c2be381e7f90b8bd984472dd2432933858aba55087d5936980cf2071d5a

# No diagnostics IPC socket in /tmp, no ICU needed, no telemetry. These reach the core through
# /etc/vmapp/runtime.env, which mkruntime writes from the image's ENV.
ENV DOTNET_EnableDiagnostics=0 \
    DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1 \
    DOTNET_CLI_TELEMETRY_OPTOUT=1
