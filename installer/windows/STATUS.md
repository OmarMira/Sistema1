# Windows installer — verified local artifact

**Delivery:** `installer/windows/dist/AccountExpress-Setup.exe` (288,273,293 bytes).
**SHA256:** `1ca776bcb51347f87fe70e984cd581445a67a125c979a930a73c41f606c66676`.

## Observed results

- Windows x64 production compilation/types/routes and standalone payload: job5 exit0.
- Node24.22.2 official SHA256 matched; PostgreSQL16.15/EDB revision1 freshly downloaded from its official HTTPS distributor, local archive SHA matched prior bytes. Do not describe the latter as an independently published vendor checksum.
- Final source/helper tests:27 Node +19 setup/relay Vitest +28 durable-root/logo Vitest =74 passed. Runtime ACL regression observed RED then GREEN.
- Real bundled payload startup/shutdown: job11 exit0. Browser job12:120 states,0 failures.
- Actual Inno compilation: job18 exit0. Optional pgAdmin/Python/StackBuilder were excluded after their deep source paths broke earlier attempts; required PostgreSQL bin/lib/share/licenses retained.
- Actual executable acceptance job19: exit0 after12m3s, owned `.checks/installed-proof-qq6zgl`. Fresh install/configure, real migrations/start/bootstrap, browser120 states/0 failures, malformed verification rejected, missing-mail failure with no fictitious account, restart/config retention, actual uninstall/server removal/data retention all passed.
- Accepted exe and `dist` copy were both rehashed; SHA matched exactly. No global runtime/service or registry registration was created by the installer.

## Explicit limits

- These are tests on the current Windows host in isolated owned directories, **not a fresh Windows VM**.
- Browser code-form geometry uses a mocked mail receipt. No actual inbox, verified first administrator, completed real onboarding or Google deployment is claimed. Those require owner Google authorization.
- Independent verifier reviewed source and the bounded ACL correction only; it executed no functional tests because its role requires external system-temp scratch without a session grant. Parent tests are not represented as independent execution.
- RDD is on; native assessment remains unassessable on undeclared ambient untracked scope and supplied no reviewDue/start route. No native approval/receipt is claimed.
- Artifact is unsigned. Installed Inno6.7.3 identifies its compiler license as non-commercial; no commercial-distribution licensing clearance, publication or paid license purchase is claimed.

Task/commit record: `odd/tasks/windows-single-pc-installer.md`. Prior staged cache/STATUS entries and unrelated human source/design changes remain outside owned work-unit commits.
