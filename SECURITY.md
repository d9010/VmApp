# Security policy

D9010 VmApp exists to keep an app away from your files, your network and your Mac. Isolation is its main feature, so a weakness in it matters more here than in most projects, and we want to hear about it.

## Reporting a vulnerability

**Please do not open a public issue.** Use GitHub's private reporting: on this repository's **Security** tab, choose **Report a vulnerability**. Only the maintainers see it. Please include what you did,
what you expected and what happened, the version or commit, and your macOS version.

We will read every report and reply as soon as we can. If a report is confirmed, we fix it first and describe it publicly afterwards, and we credit you if you want that.

## What counts

The promises in [docs/SECURITY.md](docs/SECURITY.md) and the invariants in [GOVERNANCE.md](GOVERNANCE.md) define the target. In scope, for example:

- an app's engine (the code in the VM) reading a file or reaching a host you did not grant;
- an app's window escaping its sandbox, or getting a permission, a device or the network that it was not given;
- a bypass of the network proxy's checks (the allowlist, the refusal of private and local addresses);
- a VM or a GPU server that survives the launcher, or a package that installs different bytes from the ones reviewed;
- a way for an app to fake or tamper with the launcher's own dialogs, or to read what the Inspector hides.

Out of scope: the limits the project documents as not protected ("What D9010 VmApp does not protect against" in [docs/SECURITY.md](docs/SECURITY.md)), such as misuse of access you granted,
and weaknesses in Apple's Virtualization framework, the Linux kernel or Chromium themselves, which should be reported to their own projects (tell us too if we are affected).

## Supported versions

The current `main` branch and the latest release. The format is version 1; there is no older supported line.
