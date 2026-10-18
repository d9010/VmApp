## What this changes and why

<!-- One or two sentences. Link the issue if there is one. -->

## Checklist

- [ ] `bash tools/doctor <part>` shows my setup is complete for the part I changed (README, "Contributing")
- [ ] `node tools/check-invariants` passes, and `node --test tests/unit/ tests/invariants/ tests/registry/` passes
- [ ] If I changed behaviour, I changed `SPEC.md` in this pull request (GOVERNANCE INV-G1)
- [ ] If I touched a protected file (the list is in [GOVERNANCE.md](../GOVERNANCE.md)), I say so here and which invariants it affects:
- [ ] I did not weaken a permission, a CSP, a sandbox setting or a verification step to make something work
- [ ] My contribution is under the project's MIT licence; any code under another licence is listed in `THIRD-PARTY-NOTICES.md`
