# Hold stable CLI publication while qualifying source

The Origin repository variable `SCLI_STABLE_RELEASE_HOLD=true` holds only the
standalone CLI stable release. Set and verify it before pushing source that
requires an installation configuration migration. Missing or `false` retains
the existing automatic release behavior; any other explicit value refuses the
workflow before cluster access. Host updater settings are not changed.

A held `build-publish-scli` run still builds Linux x64/arm64 and Darwin
x64/arm64 artifacts. Its finalizer fetches all four archives, verifies each
checksum, exact triggering source SHA and consistent version, then stores
`release.json` in the immutable run package version
`<short-sha>-<run-number>-a<attempt>`. That receipt is candidate evidence, not
a stable release. The finalizer logs `QUALIFIED_CANDIDATE` and does not read or
write `scli-builds/latest`; the stable publisher and release indexer are skipped.
Consequently their existing public `latest.json` remains unchanged, and host
updaters keep selecting the previous stable artifacts.

After the installation configuration is preserved, clear the hold (or set it
to `false`) and dispatch `build-publish-scli` on the reviewed primary revision,
supplying its full lowercase 40-character SHA as `expected_source_sha`.
The policy refuses a different triggering revision. Native build checkouts
also verify their actual HEAD against that same SHA. This dispatch rebuilds
and qualifies the complete four-platform cohort before the existing coherent
stable promotion; it does not combine metadata or archives from separate runs.
Do not treat a held run as permission to promote or install it.

This hold does not govern agent-runtime OCI builds, Hive configuration, MCP
broker publication, extension publication, or local snapshot-channel wrappers.
Their own qualification and adoption controls remain separate.

The parity gate executes the real policy/finalizer shell against a local
package API fixture, including invalid values, wrong source, every missing or
corrupt platform, held zero-stable-write behavior, and ordinary promotion.
