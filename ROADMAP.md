# ROADMAP.md - Shizuha (AI Core)

Planned features and technical debt for the AI inference engine.

## Current Focus

<!-- Update as priorities change -->

- Tool approval enforcement
- Code interpreter safety

## Planned Features

### High Priority

- [ ] Additional data source tools (weather, news)
- [ ] Image generation tool
- [ ] File analysis tool (PDF, documents)

### Medium Priority

- [ ] Local LLM support (Ollama integration)
- [ ] Tool chaining (multi-step workflows)
- [ ] Conversation memory persistence

### Future Considerations

- [ ] Custom tool upload by users
- [ ] Tool marketplace
- [ ] Fine-tuned models for specific tasks

## Technical Debt

<!-- Track items needing refactoring -->

- [ ] Improve error messages from tools
- [ ] Add tool execution metrics
- [ ] Better prompt templates

## Recently Completed

<!-- Move items here when done, with date -->

- [x] RestrictedPython sandbox for code_interpreter
- [x] Tool approval caching
- [x] Financial data tools (stocks, crypto)
- [x] Web search and scraping

## Notes

<!-- Context about priorities or decisions -->

RestrictedPython chosen over Docker sandbox for lower latency. May revisit for untrusted code execution.
