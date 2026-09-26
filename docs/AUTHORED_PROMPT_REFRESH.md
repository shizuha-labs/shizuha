# Authoritative instructions and the resume prefix

The gateway preserves the previous provider prompt head across resumes. Git,
memory, discovered MCP tools and generated tool catalogs are volatile; changes
in those inputs do not authorize a cold replacement of a warm provider prefix.

An actual change to the full prompt builder's authored `Custom Instructions`
is different. For example, a Hive context-prompt update must become effective
before the next real request, rather than waiting indefinitely for a session
to reach the capacity compaction threshold.

The resume pin still adopts the previous serialized head. It separately marks
an authored-instruction change pending. At the next pre-turn boundary, the
gateway performs its existing provider-backed semantic compaction transaction,
then adopts the fresh prompt and tools and prewarms the rewritten prefix. The
old and fresh overhead estimates both participate in the capacity budget.
The exact generated ToolSearch paragraph and optional source catalog are
excluded from authored comparison; arbitrary authored Markdown headings and
section separators remain significant. Adding or removing instructions counts.

This explicit configuration checkpoint may use the compactor's existing
`allowNonReducing` mode for tiny histories, just like explicit `/compact`.
Provider quality checks, generation/source fencing, transcript validation,
transactional persistence and final context-fit checks remain mandatory.
Ordinary capacity-triggered compaction still requires reduction. Failure leaves
the old prompt and working transcript intact, preserves the pending refresh,
and does not acknowledge the input. No session reset, deterministic transcript
trim, auto-reply switch or prompt-pin bypass is involved.

Scope: full system-prompt composition with its `Custom Instructions` section.
Headerless model-specific and talk-minimal prompt formats retain their existing
resume-pin behavior; this change does not infer authority from arbitrary text
differences in those formats. Hive remains the source of agent configuration.

Regression coverage uses the real prompt builder, resume pin, gateway inbox
processing, provider compaction and SQLite persistence. It includes low-context
and tiny-history checkpoints, stable subsequent turns, volatile/catalog-only
drift, and provider/quality/persistence failure followed by a successful retry.
