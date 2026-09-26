# Immutable runtime requalification

`qualify-agent-runtime.yml` is a CI-only recovery path when an existing native
runtime build completed smoke and index publication but fleet pre-pull failed.
It does not build, push, tag, promote, restart agents or alter node admission.

Dispatch the current primary-branch workflow with the original full `source_sha`,
global Origin `build_run_id`, and immutable `sha256:` multi-architecture
`index_digest`. Never pass a mutable image tag. The runtime source must be an
ancestor of the exact qualification workflow checkout. The receipt distinguishes
runtime source, qualification source, original build run and qualification run.

Provenance is verified before any candidate executes:

- The authenticated Origin run belongs to `shizuha-labs/shizuha`, uses
  `build-agent-runtime.yml`, and names the exact source commit. A failed original
  run must have reached the actual fleet pre-pull failure boundary in CI logs.
- The index bytes match its digest and contain exactly linux/amd64 and
  linux/arm64. Both children are fetched by digest, then matched against that
  run's deterministic candidate discovery tags. Tags are not treated as immutable.
- Both native configurations must match the runtime source and source-controlled
  skills lock, and match all five resolved harness versions in the authenticated
  original build output, including explicit dispatch inputs when present.
  Cross-architecture agreement alone cannot self-certify replacement versions.
  Registry JSON bytes are digest-checked by the existing OCI verifier.
- Existing structured publication records must agree with every exact digest.
  If the original manifest Job remains available, its UID, name, successful
  status, creation/completion within the original run, child environment and
  structured output must also agree. Conflicting evidence fails closed.

Older builder runs did not copy successful manifest Job stdout into durable CI
logs. The qualifier does not invent that missing record or accept a caller's
replacement metadata. Its receipt states which original evidence was actually
available. New qualification receipts are emitted as structured CI output after
all gates pass and retained using a pinned Forgejo-compatible v3 artifact action.
Failures retain an explicit failed receipt, never a fabricated green result.
Original builder stdout improvements must land with a separately
coordinated runtime build; changing its workflow is itself a build trigger.

The existing native smoke renderer is loaded from the exact original runtime
source, including that source's entrypoint checksum and real startup fixture.
Both immutable children execute real harness version and startup tests again.
Only then are finite pre-pull Jobs created for the existing eligible-node policy,
using the immutable index digest. Existing memory-admission and node-unavailable
exceptions are reported explicitly. DiskPressure remains a failure: no node is
silently omitted, eviction threshold changed or failing result suppressed.

Requalification cannot manufacture storage headroom. Wait for actual node
recovery before retrying it. Unlike a full rebuild, it reuses existing image
layers instead of producing another multi-gigabyte candidate set. Its successful
receipt is qualification evidence, not evidence of Hive desired-state promotion,
agent runtime adoption or a successful user-facing reply.
