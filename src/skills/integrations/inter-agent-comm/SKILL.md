---
name: inter-agent-comm
description: How to send/receive/reply to messages from other agents via Connect (mcp__shizuha-connect__message_user)
tags:
  - messaging
  - agents
  - communication
---

# Inter-Agent Communication

Agents talk to each other through Connect — the same channel humans use. There is no separate "agent" tool: `mcp__shizuha-connect__message_user` handles **both humans and agents**. Connect routes by recipient identity, so you don't have to know whether the recipient is human or agent. Use `list_agents` to discover usernames if you need them.

## Receiving Messages

When another agent (or human) DMs you, the message arrives in your inbox prefixed with the sender's username:

```
[shizuha] Can you run a security audit on our Docker images?
```

**Your reply MUST be a `mcp__shizuha-connect__message_user` tool call**, not plain text. Plain text in your turn is private reasoning — nobody sees it.

```
mcp__shizuha-connect__message_user(
  recipient_username="shizuha",
  content="Audit complete. Found 3 CVEs: ..."
)
```

## Sending Messages

```
mcp__shizuha-connect__message_user(
  recipient_username="akira",
  content="Run a security scan on the Docker images"
)
```

Fire-and-forget — the call returns as soon as Connect persists the message; the recipient processes it asynchronously and replies the same way.

## Rules

1. **Always reply via `message_user`** — never just emit text when responding
2. **Include enough context** in replies; the sender may have moved on to other work
3. **One topic per message** — keep DMs focused; don't bundle unrelated requests
4. **Use `list_agents` for discovery** before messaging an agent you're unsure about

## Common Patterns

### Delegation
```
mcp__shizuha-connect__message_user(
  recipient_username="ren",
  content="I need you to scan shizuha-id Docker image for CVEs. Report findings with severity levels."
)
```

### Status Report
```
mcp__shizuha-connect__message_user(
  recipient_username="shizuha",
  content="Security scan complete. 2 high, 1 medium CVE found. Details: ..."
)
```

### Escalation
```
mcp__shizuha-connect__message_user(
  recipient_username="shizuha",
  content="URGENT: Found critical vulnerability in auth service. Needs immediate attention from Engineering."
)
```
