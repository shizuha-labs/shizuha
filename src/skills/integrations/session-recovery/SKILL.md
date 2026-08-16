---
name: session-recovery
description: How to find and read past conversation sessions from disk when context is lost after a restart
tags:
  - sessions
  - memory
  - recovery
  - context
---

# Session Recovery

Your agent process may restart (daemon restart, MCP config change, container restart), losing your in-memory conversation context. The raw transcript of every past session is preserved on disk as NDJSON files.

## Session Location

```
/home/agent/.claude/projects/-workspace/
├── <uuid-1>.jsonl    ← Past sessions
├── <uuid-2>.jsonl
└── ...
```

Current session ID: `cat /workspace/.claude-session-id`

## Find Your Previous Session

```bash
ls -lt /home/agent/.claude/projects/-workspace/*.jsonl | head -5
```

The most recent file matching your current session ID is active. The **next one** is your previous session.

## Read a Past Session

Each line is JSON. Key types: `user` (human messages), `assistant` (your responses).

### Extract what the human asked:

```bash
python3 -c "
import json, sys
with open(sys.argv[1]) as f:
    for line in f:
        obj = json.loads(line)
        if obj.get('type') == 'user':
            msg = obj.get('message', {})
            content = msg.get('content', '')
            if isinstance(content, str): text = content
            elif isinstance(content, list):
                text = ' '.join(b.get('text','') for b in content if b.get('type')=='text')
            else: text = str(content)
            if text.strip(): print(f'USER: {text[:300]}'); print()
" /home/agent/.claude/projects/-workspace/<session-id>.jsonl
```

### Extract your responses:

```bash
python3 -c "
import json, sys
with open(sys.argv[1]) as f:
    for line in f:
        obj = json.loads(line)
        if obj.get('type') == 'assistant':
            for block in obj.get('message',{}).get('content',[]):
                if block.get('type') == 'text' and block['text'].strip():
                    print(f'ASSISTANT: {block[\"text\"][:300]}'); print()
" /home/agent/.claude/projects/-workspace/<session-id>.jsonl
```

## After Recovery

Save anything important to your persistent memory so you don't lose it on the next restart.
