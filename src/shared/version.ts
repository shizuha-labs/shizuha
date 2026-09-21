/**
 * SCLI-397: single canonical public version identity for the installed CLI.
 *
 * Previously the version was hardcoded in two places that disagreed:
 *   - `src/index.ts` reported `0.1.0` via `--version` / `-V`
 *   - `src/tui/components/WelcomeArt.tsx` branded the startup hero `v0.1.0-beta`
 *
 * Both surfaces now read this one constant so bug reports, release-channel
 * assertions, and QA can never cite contradictory versions from the same
 * executable. This is the beta channel build of 0.1.0, so the canonical string
 * carries the `-beta` channel suffix explicitly.
 */
export const CLI_VERSION = '0.1.0-beta';
