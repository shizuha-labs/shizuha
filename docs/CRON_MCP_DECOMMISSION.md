# shizuha-cron decommission map

`shizuha-cron` was legacy bridge glue, not a supported or user-configurable MCP
server. Its MCP command and bridge wiring have been retired. Local capabilities
now live in native SCLI tools, provider-native surfaces, dedicated browser
sidecars, or first-class platform MCP services.

## Already native in SCLI/gateway

- `search_skills`, `use_skill`
- `list_agents`
- `interactive_reply`
- `audit_log`
- `memory_index_search`
- `memory_store`, `memory_search`, `memory_list`, `memory_forget`
- `browser`, `mouse`, `keyboard`, `text_to_speech`,
  `generate_image`

Claude and Codex bridge agents load skills through their provider-native skill
directories, not cron-mcp:

- Codex: `/opt/skills` is linked into `$CODEX_HOME/skills` and
  `$HOME/.agents/skills`
- Claude: `/opt/skills` is linked into `$CLAUDE_CONFIG_DIR/skills` and
  `$HOME/.claude/skills`

Generic bridge agents must not receive `shizuha-cron` at all. Bridge startup and
platform MCP config pruning remove stale `shizuha-cron` entries from persistent
`.mcp.json` files.

Browser/social agents get a pod-local HTTP MCP server named `browser`, not
cron-mcp. The sidecar URL defaults to `http://127.0.0.1:18116/mcp` and exposes:

- `browser`, `mouse`, `keyboard`

Do not add new logic to cron copies. If a bridge needs another capability, move
it to a native/platform owner first and expose that owner directly.

## Platform-owned

- Pulse owns recurring work: `schedule_job`, `list_jobs`, `remove_job`. These
  cron MCP tools are now removed from cron advertisement unconditionally.
- Operator/runtime owns heartbeat policy: `configure_heartbeat`. This cron MCP
  tool is now removed from cron advertisement unconditionally.
- Runtime heartbeats own agent queue drain: `schedule_wakeup` is removed from
  cron/native advertisement. Use heartbeat cadence for agent work and `/watch`
  for user-visible background task monitoring.
- Hive owns fleet lifecycle:
  - `create_agent` -> `hive_create_fleet_agent`
  - `update_agent` -> `hive_update_fleet_agent`
  - `delete_agent` -> `hive_delete_fleet_agent`
  - `toggle_agent` -> `hive_enable_fleet_agent` / `hive_disable_fleet_agent`
  - `pause_agent` -> `hive_disable_fleet_agent`
  - `resume_agent` -> `hive_enable_fleet_agent`
  - `restart_agent` -> `hive_restart_fleet_agent`
  - `reset_agent_session` -> `hive_reset_agent_runtime_session`
- Hive owns credential metadata:
  - `agent_request_credential` -> `hive_request_credential`; Hive owns the
    durable request queue (`pending`, `fulfilled`, `denied`, `expired`)
  - credential request review -> `hive_list_credential_requests`,
    `hive_deny_credential_request`, `hive_expire_credential_requests`
  - `list_credentials` -> `hive_list_credentials`
  - `update_credential` -> Hive/broker credential APIs; platform runtimes must
    not persist local cron credential state
  - `agent_list_credentials` -> `hive_list_credentials`
  - `agent_grant_credential` -> `hive_create_credential` with a non-secret
    `secret_ref`
  - `agent_upsert_self_credential` -> `hive_upsert_self_credential` with a
    non-secret `secret_ref` handle; agent tokens may only upsert themselves
  - `agent_revoke_credential` -> `hive_revoke_credential`
  - `agent_query_credential_audit` -> `hive_get_credential_audit`
- Skills own integration guides:
  - `integration_guide(github)` -> native `github` skill
  - `integration_guide(notion)` -> native `notion` skill
  - `integration_guide(trello)` -> native `trello` skill
  - `integration_guide(spotify)` -> native `spotify` skill
  - `integration_guide(weather)` -> native `weather` skill
  - `integration_guide(obsidian)` -> native `obsidian` skill
  - `integration_guide(summarize)` -> native `summarize-url` skill
  - `integration_guide(smarthome)` -> native `philips-hue` skill
  - `integration_guide(camera)` -> native `ip-camera` skill
- Hive owns agent template discovery:
  - `search_templates` -> `hive_list_agent_templates`
  - `use_template` -> `hive_get_agent_template`

The cron MCP command is removed. Stale persistent MCP config is pruned rather
than kept as a compatibility surface.

## Still needs a proper owner before removal

None. The former helper modules were moved out of `src/cron-mcp`; there is no
cron MCP source directory left. Current helper owners:

- `src/daemon/agent-credential-broker-tools.ts`,
  `src/daemon/credential-persistence.ts`: credential broker helper/client code.
- `src/pulse/local-store.ts`, `src/pulse/backend.ts`: local dashboard/Pulse
  fallback helpers.

## Removed from cron

- `canvas_render`: removed from cron. Agents should return SVG/HTML/Mermaid
  directly, or use native browser/image tooling.
- `remote_exec`: removed from cron and moved to native SCLI `remote_exec`.
- `schedule_wakeup`: removed from cron/native exposure. Heartbeats and watches
  are the supported replacement.
- `memory_store`, `memory_search`, `memory_list`, `memory_forget`,
  `memory_index_search`: moved to native SCLI memory tools. Codex/Claude bridge
  agents use their provider-native memory surfaces instead of cron.
- `list_agents`: moved to native SCLI agent discovery / platform discovery.
- `interactive_reply`: moved to native SCLI interactive rendering.
- `audit_log`: moved to native SCLI audit log query.
- `browser_navigate`: folded into `browser(action="navigate", url=...)`.
- `browser`, `mouse`, `keyboard`: moved to the agent-local `browser` MCP
  sidecar.
