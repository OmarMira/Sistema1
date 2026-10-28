# Gentle toolchain repair
Objective: repair the Windows installer and update Gentle Shell, Engram, and Gentle AI using stable official distributions while preserving user data.
Route: inline installation maintenance with delegated diagnostic and independent verification; no application source changes or Git delivery. Checks: official checksums, CLI versions, installer preflight, isolated Engram smoke probe. Forecast: <150 authored tracking lines; binaries and generated dependencies excluded.

## Specs
S1. User: "podes solucionar todos los problemas quiero instalarlo desde el instalador". Restore a supported installer path and resolve `unknown-tool` and `Conflicting version destination: C:\Users\PC Omar\AppData\Local\gentle-shell\versions\4.4.0-1.2.0`; verify through the official installer preflight when available.
S2. User: "ademas no quiero tener problemas y actualizar todo lo que sea gentle-shell, engram y gentle-ai". Update these three tools to compatible stable official releases; verify executable resolution and reported versions. Absolute absence of future bugs is not a guarantee.
S3. Authorization: "si hacelo" follows explicit consent to modify tool install paths, tool-only Downloads installers, `go/bin/gentle-ai.exe`, `go/bin/engram.exe`, and tool configuration/data roots `.gentle-ai`, `.gentle-shell`, `.engram`; backup replaced files and preserve memory, sessions, credentials, and application source. Engram service restart is authorized if needed.

## Tasks
T1 | S1-S2 | diagnostic delegated (evidence/context budget) | done | Observed installer screenshot unknown-tool, shell 4.3.0, incomplete 4.4 folder, AI 4.1.1, Engram 3.4.0 and second old executable. No source change or commit applicable.
T2 | S1-S3 | inline (one sequential installation outcome, no independent writer units) | in_progress | Prepare verified official distributions, backup replacements, repair installed ownership and active paths. Risk: item 5 (installers/environment); item 1 if running new Engram against existing data, requiring consistent data backup first. No source commit: unrelated dirty application repository is outside this installation repair.
T3 | S1-S3 | independent verifier (Risk item 5) | pending | Read-only resolution/version checks, installer preflight, backup existence, and isolated smoke check. Native code review is not applicable to external installed binary payloads, and must not review unrelated application diff.

## Log
L1. Original request: "podes solucionar todos los problemas quiero instalarlo desde el instalador y me sale C:\Users\PC Omar\AppData\Local\Packages\MicrosoftWindows.Client.Core_cw5n1h2txyewy\TempState\ScreenClip\{CBFC6053-ADD8-456A-B0AF-DFBE093D7B8B}.png ademas no quiero tener problemas y actualizar todo lo que sea gentle-shell, engram y gentle-ai"
L2. User authorized external tool repairs and necessary Engram restart: "si hacelo".
L3. Screenshot read successfully. Installed bundled launcher reads `current` as a text file, not a directory/junction; do not append package paths to it. Bash `which` can miss Windows .cmd launchers; use `where.exe`. Prior advice to delete directories or assert upstream repository corruption was not evidence-based and is superseded.
L4. Public official release metadata confirms shell v4.4.0 (pins Gentle AI v4.3.1) and Engram v3.6.0. Old AI updater attempts obsolete non-/v3 Engram Go package on main. No package source patch or fabricated test-first cycle: this is installation maintenance; observe real preflight failures then functional post-install checks.
L5. Preserve the unrelated heavily modified Sistema1 tree; no stage, restore, reset, stash, source changes, or commits. Diagnostic worker reported creating/removing a scratch .cod/diag-note.md despite read-only scope; no further writes are authorized for diagnostic/verifier actors.
