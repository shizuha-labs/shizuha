# Platform Sync Design — Local-First Agent Configuration

## Principle

**Local runtime is the source of truth. Platform is a mirror, relay, and backup store.**

Local changes push up automatically. Platform changes arrive as proposals (like pull requests) that the runtime can accept or reject. The user is always in control.

---

## Architecture

```
Local Runtime (~/.shizuha/)              Platform (shizuha-agent SaaS)
━━━━━━━━━━━━━━━━━━━━━━━━━━━              ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
agents.json                              Agent DB
  ├── Full agent config          ──push──→  ├── Full agent config (mirror)
  ├── Prompts, models, skills              ├── per-field updated_at
  ├── Everything                           ├── updated_by (runtime:X or admin)
  └── SOURCE OF TRUTH                      └── pending_updates queue

credentials, tokens              ──never──→  (never leaves the machine)
enabled/disabled, ports          ──never──→  (local runtime state only)
```

---

## Sync Behavior

### Direction: Local → Platform (Auto-Push)

Every local change is immediately pushed to the platform via the WS channel.

```
User edits Kai's prompt on local dashboard
  → agents.json updated (immediate)
  → WS: sync:field_update { agent_id, field: "contextPrompt", value, updated_at }
  → Platform updates mirror
```

No user action needed. The platform always has a current copy.

### Direction: Platform → Local (Manual by Default)

Platform changes (admin edits on platform dashboard, another runtime's push) arrive as **pending updates** — never auto-applied.

```
Admin edits Kai's prompt on platform dashboard
  → Platform stores edit as pending_update for each connected runtime
  → WS: sync:pending_update { agent_id, field, new_value, old_value, updated_at }
  → Runtime shows notification:
      "Platform updated Kai's prompt (by admin). Accept? [View Diff] [Accept] [Reject]"
  → User accepts → apply locally + push ack
  → User rejects → push local version to platform (local wins)
```

### Configurable Sync Mode

```json
// ~/.shizuha/settings.json
{
  "platform": {
    "sync": {
      "mode": "manual",           // "auto" | "manual" | "off"
      "auto_fields": [],          // fields that auto-accept platform changes
      "push_on_change": true,     // push local changes to platform
      "pull_interval": 60         // heartbeat interval (seconds)
    }
  }
}
```

| Mode | Local → Platform | Platform → Local |
|------|-----------------|-----------------|
| `manual` (default) | Auto-push | Show notification, user decides |
| `auto` | Auto-push | Auto-accept (platform changes apply immediately) |
| `off` | No push | No pull (fully disconnected) |

### Conflict Resolution

When both sides changed the same field:

```
T1: Runtime changes Kai's prompt locally
T2: Platform admin changes Kai's prompt (T2 > T1)

On next heartbeat:
  Runtime sees: platform has newer change for contextPrompt

  If mode=manual → notification: "Platform has newer prompt. Accept?"
    Accept → apply platform version locally
    Reject → push local version to platform (local wins)

  If mode=auto → local still wins (auto-push overwrites platform)
    Rationale: runtime is production, platform is mirror
```

**Local always wins in auto mode.** The runtime is where agents actually run. Platform edits are suggestions, not commands.

---

## WS Sync Protocol

All sync uses the existing authenticated WebSocket connection (shizuha-ws platform channel). No new REST endpoints or connections.

### Connection / Initial Sync

```
Runtime                                    Platform
   │                                          │
   │◄──── WS authenticated ──────────────────│
   │                                          │
   │ ── sync:push ──────────────────────────► │
   │    {                                     │
   │      runtime_id: "s1",                   │
   │      agents: [{                          │
   │        id: "uuid",                       │
   │        username: "kai",                  │
   │        fields: {                         │
   │          contextPrompt: {                │
   │            value: "You are Kai...",      │
   │            updated_at: "2026-03-25T12Z", │
   │          },                              │
   │          modelFallbacks: { ... },        │
   │          skills: { ... },                │
   │          // all config fields            │
   │        }                                 │
   │      }, ...]                             │
   │    }                                     │
   │                                          │
   │ ◄── sync:result ─────────────────────── │
   │    {                                     │
   │      registered: ["kai", "shizuha"],     │
   │      conflicts: [{                       │
   │        username: "akira",                │
   │        reason: "registered by runtime    │
   │                 'home-server'",          │
   │        other_runtime: "home-server"      │
   │      }],                                 │
   │      pending_updates: [{                 │
   │        agent_id: "...",                  │
   │        field: "contextPrompt",           │
   │        new_value: "...",                 │
   │        updated_at: "...",                │
   │        updated_by: "admin@platform"      │
   │      }],                                 │
   │      new_agents: [{                      │
   │        // full config for agents on      │
   │        // platform not in local          │
   │        // (one-time import)              │
   │      }]                                  │
   │    }                                     │
```

### Conflicts Block Link

If `sync:result` contains any conflicts, the runtime **refuses to complete the link**:

```
$ shizuha up --connect platform.shizuha.com

Linking agents to platform...
  ✓ shizuha — registered
  ✓ kai — registered
  ✓ mio — registered
  ✗ akira — CONFLICT: registered by runtime "home-server"

Link BLOCKED. Resolve conflicts before connecting:
  - Delete local 'akira' and restart
  - Or rename local 'akira' to a different username
  - Or delete 'akira' on the platform via the web dashboard
```

The user MUST manually resolve all conflicts. No auto-rename, no silent skip. This prevents accidental agent duplication across runtimes.

### Live Sync (After Link)

```
Runtime                                    Platform
   │                                          │
   │ ── sync:field_update ──────────────────► │  (on every local change)
   │    {                                     │
   │      agent_id: "uuid",                   │
   │      field: "contextPrompt",             │
   │      value: "new prompt...",             │
   │      updated_at: "2026-03-25T12:30Z",   │
   │      updated_by: "runtime:s1"            │
   │    }                                     │
   │                                          │
   │ ◄── sync:pending_update ─────────────── │  (platform change)
   │    {                                     │
   │      agent_id: "uuid",                   │
   │      field: "skills",                    │
   │      old_value: ["backend", "frontend"], │
   │      new_value: ["backend", "frontend",  │
   │                   "mobile"],             │
   │      updated_at: "...",                  │
   │      updated_by: "admin@platform"        │
   │    }                                     │
   │                                          │
   │ ── sync:accept ────────────────────────► │  (user accepted)
   │    { agent_id, field: "skills" }         │
   │                                          │
   │ ── sync:reject ────────────────────────► │  (user rejected)
   │    {                                     │
   │      agent_id, field: "skills",          │
   │      local_value: ["backend","frontend"],│  ← pushes local version
   │      updated_at: "..."                   │
   │    }                                     │
   │                                          │
   │ ── sync:agent_created ─────────────────► │  (new local agent)
   │    { full agent config }                 │
   │                                          │
   │ ── sync:agent_deleted ─────────────────► │  (agent removed locally)
   │    { agent_id, username }                │
   │                                          │
   │ ◄── sync:agent_claimed ────────────────  │  (another runtime claimed)
   │    {                                     │
   │      agent_id, username,                 │
   │      claimed_by: "gpu-box"               │
   │    }                                     │
```

---

## Agent Identity & Registration

### Username Uniqueness

Usernames are globally unique across all runtimes in an organization. Enforced by the platform registry.

```
Platform Registry:
  ┌──────────┬──────────┬─────────────┬──────────────┐
  │ username │ agent_id │ runtime_id  │ last_seen    │
  ├──────────┼──────────┼─────────────┼──────────────┤
  │ shizuha  │ uuid-001 │ s1          │ 2026-03-25   │
  │ kai      │ uuid-002 │ s1          │ 2026-03-25   │
  │ nori     │ uuid-003 │ gpu-box     │ 2026-03-25   │
  │ akira    │ uuid-004 │ home-server │ 2026-03-25   │
  └──────────┴──────────┴─────────────┴──────────────┘
```

### Agent Creation

```
1. User creates agent locally (dashboard or tool)
2. agents.json updated with new UUID + username
3. sync:agent_created pushed to platform
4. Platform checks username uniqueness:
   ├── Unique → registered, ack sent
   └── Conflict → reject, runtime notified
       "Username 'kai' already taken. Choose another."
```

### Agent Movement (Claim Ownership)

To move an agent from one runtime to another:

```
1. New runtime creates the agent locally (same username)
2. sync:push → conflict: "kai registered on old-runtime"
3. User chooses to claim ownership
4. Platform re-routes: kai → new-runtime
5. Old runtime notified: sync:agent_claimed { username: "kai", claimed_by: "new-runtime" }
6. Old runtime removes kai from its agents.json (or marks as unclaimed)
```

---

## Dashboard Notifications

### Pending Update Notification

When the platform has changes the runtime hasn't accepted:

```
┌─────────────────────────────────────────────────────┐
│ 🔔 Platform Update (1)                              │
│                                                     │
│ Agent: Kai (@kai)                                   │
│ Changed: contextPrompt                              │
│ By: admin via platform dashboard                    │
│ When: 5 minutes ago                                 │
│                                                     │
│ ┌─ Diff ──────────────────────────────────────────┐ │
│ │ - You are Kai, Lead Engineer...                 │ │
│ │ + You are Kai, Senior Staff Engineer...         │ │
│ └─────────────────────────────────────────────────┘ │
│                                                     │
│ [Accept]  [Reject (keep local)]                     │
└─────────────────────────────────────────────────────┘
```

### Conflict Notification

When another runtime claims an agent:

```
┌─────────────────────────────────────────────────────┐
│ ⚠️ Agent Claimed                                    │
│                                                     │
│ Agent 'akira' has been claimed by runtime "gpu-box". │
│ It will be removed from this runtime.               │
│                                                     │
│ [OK]                                                │
└─────────────────────────────────────────────────────┘
```

---

## Snapshot & Recovery

### Snapshot Contents

A snapshot captures everything needed to restore an agent on any runtime:

```
snapshot-kai-2026-03-25.tar.gz
  ├── agent.json              # Full agent config (the agents.json entry)
  ├── workspace/              # Agent workspace volume
  │   ├── .mcp.json
  │   ├── .claude-session-id
  │   └── (all workspace files)
  ├── claude-session/          # Claude Code session data
  │   ├── settings.json
  │   ├── .claude.json
  │   └── projects/           # Conversation history
  └── pulse-tasks.json         # Tasks assigned to this agent
```

### Snapshot Storage

Stored on SCS (Shizuha Cloud Services):

```
POST /scs/api/snapshots/ { agent_id, runtime_id }
  → Upload tarball to S3-compatible storage
  → Platform records: snapshot_id, agent_id, created_at, size, storage_url
```

### Restore Flow

```
1. Download snapshot from SCS
2. Extract to local workspace + claude-session dirs
3. Add agent.json entry to local agents.json
4. shizuha up --connect
   → sync:push includes the restored agent
   → If username conflict (old runtime still has it):
       Claim ownership or rename
   → If username free: register normally
5. Agent starts with full workspace, session history, and config
```

The snapshot is self-contained. The platform doesn't parse it — it's an opaque blob stored for disaster recovery.

---

## Fields Reference

### Synced Fields (Local → Platform push, Platform → Local via pending updates)

| Field | Description |
|-------|-------------|
| `name` | Display name |
| `email` | Agent email |
| `role` | Role title |
| `contextPrompt` | System prompt |
| `modelFallbacks` | Model chain (method, model, effort, thinking) |
| `modelOverrides` | Model routing overrides |
| `skills` | Skill tags |
| `personalityTraits` | Behavior traits |
| `mcpServers` | MCP server config |
| `executionMethod` | How the agent runs (shizuha, claude_code_server, etc.) |
| `runtimeEnvironment` | container, bare_metal, sandbox |

### Local-Only Fields (Never synced)

| Field | Description |
|-------|-------------|
| `credentials` | API keys, OAuth tokens |
| `workSchedule` | Local work hours |
| `tokenBudget` | Spending limits |
| `agentMemory` | Persistent memory |
| `localPort` | Gateway port |
| `enabled` | Whether running on this machine |

### Platform-Only Fields

| Field | Description |
|-------|-------------|
| `runtime_id` | Which runtime hosts this agent |
| `last_seen` | Last heartbeat |
| `pending_updates` | Queued changes awaiting runtime acceptance |
| `per-field updated_at` | Timestamps for sync resolution |
| `per-field updated_by` | Who last changed each field |

---

## Migration from Current Behavior

### Current (`mergeRemoteAgents` in state.ts)

```
Platform → Local: Auto-overwrite 11 fields on every connect
Local → Platform: Never
Conflicts: Silent overwrite (platform wins)
```

### New Behavior

```
Platform → Local: Pending updates only (manual accept/reject)
Local → Platform: Auto-push on every change
Conflicts: Block link until user resolves
Username: Globally unique, enforced by platform
```

### Migration Steps

1. **Modify `mergeRemoteAgents()`** — Stop overwriting local fields. Only import new agents (one-time pull).
2. **Add sync:push on WS connect** — Push all local agent configs to platform on connection.
3. **Add sync:field_update on local change** — Push field-level changes to platform via WS.
4. **Add sync:pending_update handler** — Receive and queue platform changes for user review.
5. **Add conflict detection on link** — Check username uniqueness, block on conflicts.
6. **Add dashboard notification UI** — Show pending updates, diff view, accept/reject buttons.
7. **Add sync mode config** — `settings.json` → `platform.sync.mode` (manual/auto/off).

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| **Local-first** | Runtime is production; platform is mirror. Never break a running system. |
| **WS for all sync** | Connection already exists, authenticated, bidirectional. No new endpoints. |
| **Manual mode default** | Prevents surprises. User opts into auto if they trust the platform. |
| **Block on conflicts** | No silent resolution. User must explicitly resolve. Prevents agent duplication. |
| **Field-level timestamps** | Granular sync — changing a prompt doesn't affect model config timestamps. |
| **Pending updates persist** | Platform keeps pending changes until accepted/rejected. No data loss. |
| **Snapshots are opaque** | Platform stores but doesn't parse. Recovery is runtime-side only. |
| **Username globally unique** | One agent per username per org. Unambiguous message routing. |

---

## Alternatives Considered & Rejected

| Alternative | Why Rejected |
|-------------|-------------|
| **Platform-first (current)** | Breaks local autonomy, loses edits on reconnect |
| **Bidirectional auto-merge** | Complex, error-prone, unexpected behavior |
| **CRDTs** | Massive over-engineering for config that changes rarely |
| **REST API for sync** | Redundant when WS channel exists. REST adds latency and connection overhead. |
| **No platform mirror** | Platform should have visibility for dashboards, backup, and multi-runtime routing |
| **Auto-rename on conflict** | Confusing. User should explicitly choose. |
| **Silent skip on conflict** | Leads to agents that exist locally but can't receive cross-runtime messages |
