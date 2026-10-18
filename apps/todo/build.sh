#!/usr/bin/env bash
# Builds the Todo core: a framework-dependent linux-arm64 `dotnet publish` into core/ (the VM's /app).
# The dotnet8 runtime provides the shared framework, so the output is small. Needs Docker; the SDK image is pinned by
# digest (mcr.microsoft.com/dotnet/sdk:8.0, linux/arm64).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDK='mcr.microsoft.com/dotnet/sdk@sha256:ec9c0a0dc5f60adc2065762050638dd5ed5facfc53716d4580a42d86027c8e80'

mkdir -p "$HERE/core"
# The sources are mounted read-only and built in a scratch directory, so no obj/ or bin/ lands in the app folder.
# core/ is emptied inside the container first, then receives the publish output.
docker run --rm --platform linux/arm64 \
  -e DOTNET_CLI_TELEMETRY_OPTOUT=1 -e DOTNET_NOLOGO=1 -e DOTNET_CLI_HOME=/tmp/dotnet \
  -v "$HERE":/src:ro -v "$HERE/core":/out \
  "$SDK" sh -c '
    set -e
    mkdir -p /tmp/b && cp /src/Todo.csproj /src/Program.cs /tmp/b/ && cd /tmp/b
    find /out -mindepth 1 -delete
    dotnet publish Todo.csproj -c Release -r linux-arm64 --self-contained false -p:UseAppHost=false \
      -p:DebugType=None -p:DebugSymbols=false -o /out
  '
echo "built $HERE/core:"
ls -l "$HERE/core"
