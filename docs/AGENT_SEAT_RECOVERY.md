# Agent seat recovery ladder

Use this when an agent's MCP client/session is detached or wedged but the runtime manager is still reachable.

1. Check the agent's queue/task state first; do not reset a seat just because it is quiet.
2. Try `reset_agent_session(target="<agent>")` to clear the conversation/session cache without killing the process.
3. If the MCP client is still detached, run `restart_agent(target="<agent>")`.
4. If the agent is intentionally disabled, do not re-enable it unless the task explicitly requires capacity restoration and the disabled reason is resolved.
5. If `reset_agent_session` / `restart_agent` fails while creating or exchanging the agent auth challenge with an HTTP 5xx, check the runtime manager/control proxy health. That is an infra issue for DevOps, not an operator-only session reset.
6. Escalate to Hritik only if the runtime manager/control plane itself is down in a way no agent with cluster/host access can repair, or if a business decision/operator-only secret is genuinely required.

Supported self-serve expectation: DevOps agents authenticate to the daemon with the agent gateway token and hold `agents:control` for reset/restart/toggle operations. Denials should include the daemon HTTP status or explicit daemon error so the next step is actionable.
