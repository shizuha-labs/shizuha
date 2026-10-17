# Deployment-owned identity configuration

The Pulse adapter has no built-in personal mailbox. An installation that routes
human handles to email addresses supplies `SHIZUHA_PULSE_HUMAN_EMAILS` as a JSON
object, for example `{"maintainer":"maintainer@example.invalid"}`. Supply the
installation's reviewed mapping before adopting an upgrade; unknown agent handles
keep the existing `handle@agents.shizuha.io` convention. Malformed or ambiguous
mappings fail instead of selecting another person's mailbox. This config is
local deployment data and must not be copied into public source or fixtures.

For an operator CLI, when this environment variable is absent, the adapter reads
`$XDG_CONFIG_HOME/shizuha/pulse-human-emails.json` or
`~/.config/shizuha/pulse-human-emails.json`. This file contains the same JSON
object. On POSIX it must be owned by the running user, with no group/other
permissions (for example `0600`). Symlinks, nonregular or oversized files are
refused. A missing file gives an empty mapping; malformed configured data fails
with a sanitized error. The adapter rereads this bounded file for each lookup,
so removing or correcting a mapping does not retain cached routing. An explicit
environment variable, including an empty one, takes precedence over the file.

Managed fleet agents retain Hive as configuration authority: supply the reviewed
mapping through each agent's persisted `FleetAgent.env` before adopting a new
runtime. Do not edit daemon caches or restart an agent to inject it. The local
file is installation data for user-launched CLIs, not an alternative fleet control
plane or an authorization grant.

Historical fleet SSH audit enrichment is optional. If it is still required,
set both `SHIZUHA_LEGACY_FLEET_SSH_DIR` and `SHIZUHA_LEGACY_FLEET_SSH_USER` to the
already-approved legacy mount and remote account. This matches existing grants
for audit metadata only; it creates no extra authority and never discovers keys
from HOME or an SSH agent. Leaving it unset preserves ordinary grant migration
without inferring a particular operator's identity. Existing audit labels remain
compatible with previously stored records.

Legacy host publishing scripts and their systemd units are retired. The
canonical Origin build-publish-scli workflow remains the only release publisher.
