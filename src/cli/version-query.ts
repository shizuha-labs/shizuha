/**
 * SCLI-521: `--version` / `-V` must only succeed for structurally valid argv.
 *
 * Commander's built-in `.version()` prints the version and exits 0 as soon as
 * it sees the flag during option parsing, masking unknown commands/options or
 * unexpected operands before or after it. That eager success path made
 * `shizuha definitely-not-a-command --version` and `shizuha --bogus --version`
 * exit 0 with a version line — a false success a caller could mistake for
 * proof the sibling tokens were recognized (SCLI-178 parent program).
 *
 * `versionQueryError` runs BEFORE `program.parse()`. When a version flag is
 * present it requires the argv to be exactly the flag; otherwise it returns an
 * error naming the offending token (the caller prints it to stderr and exits
 * nonzero, never emitting a success-shaped version line). A valid lone
 * `--version` / `-V` argv returns null so commander's `.version()` prints the
 * canonical `CLI_VERSION` and exits 0 (SCLI-397).
 */
export function versionQueryError(argv: string[]): string | null {
  const versionFlags = new Set(['--version', '-V']);
  const allowedCompanions = new Set(['--json']);
  const hasVersionFlag = argv.some((a) => versionFlags.has(a));
  if (!hasVersionFlag) return null;

  const versionCount = argv.filter((a) => versionFlags.has(a)).length;
  const valid =
    versionCount === 1 &&
    argv.every((a) => versionFlags.has(a) || allowedCompanions.has(a));
  if (valid) return null; // commander's .version() prints CLI_VERSION and exits 0.

  // Name the first non-version token; if every token is a version flag (e.g.
  // `--version --version`), name the duplicate. In this branch argv is
  // non-empty, so the fallbacks are only for the type checker.
  const offender =
    argv.find((a) => !versionFlags.has(a)) ?? argv[1] ?? argv[0] ?? '';
  return `error: unexpected argument '${offender}' alongside --version`;
}
