# Changelog

What changed in each version of the D9010 VmApp Launcher, newest first. The launcher shows the latest entry on its update card, the
website's download page links here, and each GitHub release carries the same text.

## [0.1.1] - 2026-10-18

Fixes the launcher quitting as soon as it was opened. Version 0.1.0 does not start; please use this version instead.

### Fixed

- The launcher no longer quits right after you open it on a Mac: version 0.1.0 could not find its own helper programs and stopped at start.
- Downloading and unzipping the launcher no longer leaves stray `._` files inside it, which made macOS refuse to open it.

## [0.1.0] - 2026-10-18

The first public release, for macOS 13 or later on Apple silicon.

### Added

- The launcher: every app's engine runs in its own small virtual machine and its window in a sandbox on your Mac, and you choose which folders and which websites each app may reach.
- Fourteen sample apps come with the launcher: **Load examples** installs the ones you pick, and nothing is allowed until you say so.
- The Inspector shows every message between an app's window and its engine, and every internet connection an app tries, live.
- The launcher tells you when a newer version is available and can update itself. A card shows what changed and offers **Update now**, **Later** or **Skip this version**; **Check for Updates…** in the launcher's menu asks at any time, and a switch in Host Capabilities turns the automatic check off. Nothing is downloaded or restarted without your click, and the check sends nothing about you.
- Browse an app registry, install an app from it, and publish your own app from the launcher.
- Apps can ask to see your screen, use the mouse and keyboard, run tools you registered, use the microphone, or use your Mac's GPU. Each is off until you allow it, can be stopped at any time with one shortcut, and the experimental GPU path stays off until you turn it on.
