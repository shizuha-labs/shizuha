# Contributing to Shizuha Code

## Develop

Runtime: Node.js 22+.

```bash
npm install
npm run build:check
npm test
```

Please open an issue before large changes.

Do not commit credentials, host-local paths, or cluster inventory. Use
environment variables or `~/.shizuha/` for secrets.

## Pull requests

- One logical change per PR
- Keep tests green (`npm test`)
- Do not add generated `dist/` output
