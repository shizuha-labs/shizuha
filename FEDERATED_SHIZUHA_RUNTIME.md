# Federated Shizuha Runtime — Multi-Host Agent Clusters

## Problem

The Shizuha agent runtime currently runs on a single host. All 17+ agents share one machine's CPU, memory, and GPU. When capacity is exhausted, there's no way to scale horizontally.

## Current Architecture (Single Host)

```
Single host (shizuha.com)
  └── shizuha daemon (:8015)
        ├── 17 DinD containers (sysbox)
        ├── Local Pulse (SQLite)
        ├── Event log (SQLite)
        ├── Dashboard UI
        └── All agent-to-agent communication is localhost
```

## Design Decision: Federation over Kubernetes

### Why NOT Kubernetes (K3s/K8s)

- **DinD conflict** — Our agents run in sysbox DinD containers with full Docker inside. K8s pod scheduling conflicts with this nested container model.
- **Lifecycle conflict** — The daemon manages agent lifecycle (start/stop/restart/config). K8s wants to manage pod lifecycle itself. Two reconciliation loops fighting each other.
- **Complexity** — Each agent becomes Deployment + Service + PVC + ConfigMap. Overkill for 17-50 agents.
- **WebSocket** — Our agent communication is WebSocket-based. K8s Ingress WS support adds configuration overhead.
- **Wrong stage** — K8s solves problems we don't have yet (100+ pods, multi-region, canary deploys) and creates problems we do have (nested Docker, agent management).

### Why Federation

Each host runs its own `shizuha up` daemon. Daemons discover each other and agents communicate cross-host using the existing gateway protocol.

**Key insight:** We already have all the building blocks:
- Tailscale mesh VPN (`*.tail.shizuha.com`) — zero-config networking between hosts
- Daemon HTTP API (`/v1/agents/:id/message`) — async message injection
- Agent tools (`message_agent`, `create_agent`, `list_agents`) — agent management
- Local Pulse — task/alert tracking per host

Federation is just routing `message_agent` across Tailscale instead of localhost.

## Target Architecture

```
┌─────────────────────────────────────┐     ┌─────────────────────────────────────┐
│ Host A (shizuha.com)        │     │ Host B (gpu.tail.shizuha.com)       │
│                                     │     │                                     │
│ shizuha daemon (:8015)              │     │ shizuha daemon (:8015)              │
│   ├── Shizuha (Chief of Staff)      │     │   ├── Nori (Social Media + GPU)     │
│   ├── Kai (Eng Lead)                │     │   ├── Benchmark agents              │
│   ├── Akira (Security Lead)         │     │   └── GPU-intensive workloads       │
│   ├── Haru (Docs Lead)              │     │                                     │
│   ├── Mio (Mail Ops)                │     │ Resources: 4x GPU, 128GB RAM        │
│   ├── Hana, Zen, Sora...            │     └─────────────┬───────────────────────┘
│   └── Local Pulse (SQLite)          │                   │
│                                     │                   │
│ Resources: 32-core, 512GB RAM       │                   │
└─────────────────┬───────────────────┘                   │
                  │                                       │
                  └──── Tailscale mesh (100.x.x.x) ───────┘
                         Zero-config, encrypted, NAT-traversal
```

## Implementation Phases

### Phase 1: Manual Multi-Host (No Code Changes)

**Works today.** Run `shizuha up` on multiple hosts independently. Agents on different hosts communicate via Tailscale IPs.

```bash
# Host A
shizuha up --foreground

# Host B (GPU box)
shizuha up --foreground
```

Manual agent placement: configure which agents run on which host via `~/.shizuha/agents.json` on each host.

**Limitations:**
- `message_agent` only reaches local agents
- `list_agents` only shows local agents
- Tasks/alerts are per-host (separate SQLite DBs)

### Phase 2: Cross-Host Routing

**New: daemon-to-daemon communication.**

#### 2.1 Cluster Config

Each daemon reads `~/.shizuha/cluster.json`:

```json
{
  "cluster_id": "shizuha-prod",
  "this_host": "s1",
  "hosts": [
    {
      "id": "s1",
      "name": "Primary",
      "url": "https://shizuha.com:8015",
      "tailscale_ip": "100.64.0.1",
      "capabilities": ["cpu", "docker"],
      "max_agents": 20
    },
    {
      "id": "gpu1",
      "name": "GPU Box",
      "url": "https://gpu.tail.shizuha.com:8015",
      "tailscale_ip": "100.64.0.20",
      "capabilities": ["cpu", "docker", "gpu"],
      "max_agents": 10
    }
  ]
}
```

#### 2.2 Cross-Host Message Routing

When `message_agent(target="nori")` is called:
1. Check local agents — if Nori is local, route locally (current behavior)
2. If not found locally, query each remote daemon: `GET https://{host}:8015/v1/agents`
3. Find which host has Nori, then: `POST https://{host}:8015/v1/agents/nori/message`
4. Cache the host→agent mapping for future calls (invalidate on agent start/stop)

```
Agent on Host A                        Agent on Host B
     │                                      ▲
     │ message_agent(target="nori")         │
     ▼                                      │
Local daemon A                         Remote daemon B
     │                                      ▲
     │ Not found locally                    │
     │ → Check cluster.json                 │
     │ → POST https://gpu:8015              │
     │      /v1/agents/nori/message ────────┘
```

#### 2.3 Federated Agent Discovery

`list_agents` aggregates from all daemons:

```
GET /v1/agents?cluster=true

Response:
{
  "agents": [
    { "name": "Kai", "host": "s1", "status": "running" },
    { "name": "Nori", "host": "gpu1", "status": "running" }
  ]
}
```

#### 2.4 Cross-Host Agent Creation

`create_agent` with placement hints:

```
create_agent(
  name="VideoGen",
  username="videogen",
  host="gpu1",           # explicit placement
  capabilities=["gpu"],  # or let the system pick
)
```

The daemon routes the creation request to the target host's daemon.

### Phase 3: Resource-Aware Scheduling

**New: automatic agent placement based on host capacity.**

#### 3.1 Host Health Reporting

Each daemon periodically reports to the cluster:
- CPU usage (%)
- Memory usage (%)
- GPU usage (%) and VRAM
- Number of running agents
- Available container slots

#### 3.2 Placement Algorithm

When `create_agent` is called without a specific host:

```
1. Filter hosts by required capabilities (e.g., GPU)
2. Filter by available capacity (< max_agents, < 80% CPU)
3. Score remaining hosts: lower load = higher score
4. Place agent on highest-scoring host
```

#### 3.3 Agent Migration

Move an agent between hosts:
1. Stop agent on source host
2. Transfer workspace volume (rsync over Tailscale)
3. Start agent on target host
4. Update cluster routing table

### Phase 4: Shared State (When Needed)

**Replace SQLite with shared storage for multi-host consistency.**

| Component | Current | Federated |
|-----------|---------|-----------|
| Local Pulse (tasks/alerts) | SQLite per host | PostgreSQL (shared) or CockroachDB |
| Event log | SQLite per host | PostgreSQL with per-host partitions |
| Agent config | JSON per host | PostgreSQL or etcd |
| Credentials | JSON per host | Vault or encrypted PostgreSQL |
| Session storage | SQLite per host | Keep local (sessions are agent-specific) |

**Alternative:** Keep SQLite everywhere and sync via Litestream to S3. Simpler, works offline, eventually consistent.

## No Control Plane / Data Plane Split

At our scale (17-50 agents, 2-5 hosts), splitting into separate control and data planes is premature:

- **The "control plane" IS Shizuha** (the agent). She decides what work goes where, creates agents, monitors status.
- **The "data plane" is Tailscale + daemon HTTP APIs.** Messages route through the mesh automatically.
- **Splitting creates operational overhead** — a separate control plane service to deploy, monitor, scale, and secure. Not justified until 100+ agents across 20+ hosts.

When we reach that scale, the natural evolution is:
1. Promote the daemon's REST API to a standalone "cluster coordinator" service
2. Run it on 3 nodes with etcd for leader election
3. Daemons become pure "node agents" that execute commands from the coordinator

But that's a 100-agent problem, not a 20-agent problem.

## Security Considerations

- **Tailscale handles encryption** — all inter-host traffic is WireGuard-encrypted
- **Daemon auth** — inter-daemon requests use mutual TLS or shared secret tokens
- **Agent isolation** — containers provide the same isolation on every host
- **Credential scope** — each host only has credentials for agents it runs
- **No public endpoints** — daemons are only accessible via Tailscale (private mesh)

## Migration Path

```
Today                    Phase 1              Phase 2              Phase 3
─────                    ───────              ───────              ───────
Single host              Multiple hosts       Cross-host routing   Auto-placement
17 agents                Manual placement     message_agent works  create_agent picks
All localhost             Separate daemons     across hosts         best host
                         Tailscale mesh       Cluster config       Health monitoring
```

Each phase is additive — no rework of previous phases. The daemon code changes are:
- Phase 1: Zero code changes
- Phase 2: ~200 lines (cluster config reader, remote message routing, federated list_agents)
- Phase 3: ~300 lines (health reporter, placement algorithm, migration)

## Decision Log

| Decision | Rationale |
|----------|-----------|
| Federation over K8s | K8s conflicts with DinD/sysbox, adds complexity we don't need |
| Tailscale for networking | Already deployed, zero-config, encrypted, NAT-traversal |
| No control plane split | Shizuha (the agent) IS the control plane at this scale |
| SQLite first, Postgres later | SQLite works for 2-5 hosts; switch when consistency matters |
| Container-only runtime | Eliminates bare metal issues (zombies, ports, paths) across all hosts |
| Phase 2 before Phase 3 | Cross-host routing is more valuable than auto-placement |
