# Shizuha TUI Rendering Roadmap

## Problem Statement

The Shizuha TUI (built on Ink 5 + React 18) suffers from flickering, slowness, and visual glitches — especially when resuming sessions with large history, during streaming, and inside tmux. These issues stem from fundamental limitations in Ink's rendering pipeline.

---

## Root Cause: Ink's `clearTerminal` Fallback

In Ink 5's `onRender` (`node_modules/ink/build/ink.js`), the critical path is:

```javascript
if (outputHeight >= this.options.stdout.rows) {
    this.options.stdout.write(ansiEscapes.clearTerminal + this.fullStaticOutput + output);
    this.lastOutput = output;
    return;
}
```

**When the rendered output height exceeds the terminal viewport, Ink clears the ENTIRE terminal and rewrites everything from scratch on every render.** This is the nuclear path — it causes visible white flash / content jump on every state change.

Since we removed `<Static>` (to fix ghost frame stacking), ALL content lives in the dynamic area. Once messages + streaming response + status bar + input box exceed the terminal height, Ink triggers `clearTerminal` on every render → constant flickering.

The normal path (output fits in viewport) uses `logUpdate`:

```javascript
stream.write(ansiEscapes.eraseLines(previousLineCount) + output);
```

This erases only the previous output lines and rewrites them — much smoother. But it only works when `outputHeight < stdout.rows`.

---

## Solution Tiers

### Tier 1: Quick Wins Within Ink 5 (Immediate)

**Goal:** Keep output height below `stdout.rows` at all times to stay on the fast `logUpdate` path.

#### 1a. Height-Aware Viewport Windowing

Currently `MAX_VISIBLE_ENTRIES = 50` (static). This should be dynamic based on terminal height.

Budget breakdown for a 50-row terminal:
- StatusBar box with border: 3 lines
- Header: 2 lines
- InputBox: 3+ lines
- Padding/margins: ~2 lines
- **Available for content: ~40 lines**

Each message entry is 3–10 lines, so we can show roughly 5–10 entries before exceeding the viewport.

**Implementation:**
- Use `process.stdout.rows` to compute available content height
- Dynamically adjust max visible entries so total output stays under viewport
- Show `[+N older entries — Ctrl+P for full transcript]` when truncated

#### 1b. Streaming Content Height Cap

During streaming, a single assistant response can grow to exceed the viewport (long tool outputs, large code blocks). Cap the rendered height of the live streaming entry and show a `[streaming... Ctrl+P for full output]` indicator.

#### 1c. Better Memoization

Verify `React.memo` on `MessageBlock` is actually preventing re-renders. Consider a custom `arePropsEqual` function that compares entry IDs and streaming state rather than deep equality.

#### 1d. Reduce Re-render Triggers

- Ensure `completedEntries` array identity is stable (no unnecessary spreads)
- Avoid creating new callback references on every render (use `useRef` for handlers — already partially done with `handleSubmitRef`)
- Throttle state updates during streaming (already at 220ms via `STREAM_RENDER_INTERVAL_MS`)

---

### Tier 2: Upgrade to Ink 6 + React 19 (Short-Term)

Ink 6.5+ adds `incrementalRendering: true` which only updates **changed lines** instead of full redraws. This is the single most impactful change available.

#### Requirements

| Dependency | Current | Required |
|-----------|---------|----------|
| Node.js | 22.12.0 | 20+ ✅ |
| React | 18.3.1 | 19 ❌ |
| Ink | 5.2.1 | 6.5+ ❌ |

#### Key Ink 6 Features

- **`incrementalRendering: true`** — Only updates changed lines instead of full redraws
- **`maxFps`** — Cap frame rate to prevent excessive renders (e.g., 30fps)
- **`onRender(metrics)`** — Callback with `renderTime` for performance monitoring
- **`concurrent`** — React concurrent mode with Suspense support

#### Migration Steps

1. Upgrade React 18 → 19 (review breaking changes, update types)
2. Upgrade Ink 5 → 6 (minimal API changes beyond React 19 requirement)
3. Enable `incrementalRendering: true` in `render()` call
4. Set `maxFps: 30` to prevent excessive renders
5. Test all components for React 19 compatibility
6. Verify `<Static>` behavior if we decide to re-introduce it

#### Usage After Upgrade

```tsx
render(
  <App cwd={cwd} initialModel={options.model} initialMode={options.mode} />,
  { exitOnCtrlC: false, incrementalRendering: true, maxFps: 30 },
);
```

---

### Tier 3: Custom Differential Renderer (Long-Term) — IMPLEMENTED

Ink 6's `incrementalRendering` proved incompatible with dynamic layout changes (ghost lines in tmux). Instead of a full cell-level renderer, we implemented a **line-level diff renderer** that replaces Ink's output pipeline via esbuild `onLoad` plugins while keeping Ink for React reconciliation + Yoga layout.

#### Our Architecture (Lightweight Tier 3)

Rather than building a full TypedArray double-buffer renderer (Claude Code's approach), we intercept two critical Ink modules at build time:

1. **`diffLogUpdate.ts`** (replaces `ink/build/log-update.js`)
   - Line-level diff: moves cursor to top of output block, overwrites only changed lines, clears removed lines
   - Explicit `cursorOffset` tracking for robust cursor positioning across renders
   - Uses `\x1b[1B` (cursor down) between lines instead of `\r\n` (avoids scroll issues at terminal bottom)
   - Writes to real `process.stdout`, not Ink's proxy stream
   - Never clears terminal — no blank moment, flicker-free even without DEC 2026

2. **`stableUseInput.ts`** (replaces `ink/build/hooks/use-input.js`)
   - Stores handler in `useRef` (always current, never re-subscribes)
   - Registers stdin listener ONCE with empty `useEffect` deps
   - Eliminates keystroke drops from listener re-subscription during renders

3. **`inkPatchPlugin`** (in `esbuild.config.js`)
   - `onLoad` handlers swap Ink's modules with our replacements at build time
   - `resolveDir` set to Ink's build directory so relative imports resolve correctly
   - Zero runtime overhead — replacements are compiled into the bundle

4. **`stdout.rows` Proxy** (in `App.tsx`)
   - Spoofs `rows` to 9999 to prevent Ink's fullscreen/clearTerminal path
   - All rendering goes through our `diffLogUpdate` renderer
   - Layout unaffected since Ink only uses `stdout.columns` for Yoga

#### Performance Results

- **Zero flickering** — line-level diff means no moment where content is blank
- **Zero keystroke drops** — stable ref pattern eliminates listener re-subscription window
- **Fast typing at 10ms intervals** — all characters captured in correct order
- **Clean transitions** — init→ready, typing updates, streaming all render without ghost lines
- **DEC Mode 2026** still handled by Ink's `throttledLog` — we don't nest

#### Claude Code's Full Approach (Reference)

From the [Claude Code TUI engineer on HN](https://news.ycombinator.com/item?id=46701013):

> The pipeline follows: React scene graph → Layout → Rasterization to 2D screen → Differential comparison → ANSI sequence generation. This operates within a ~16ms frame budget with ~5ms for React-to-ANSI conversion.

Their approach uses TypedArray screen buffers, cell-level double buffering, and contributed DEC 2026 patches to VSCode/tmux. Our line-level approach is simpler but sufficient — we can escalate to cell-level if needed in the future.

---

## Current State (2026-03-07)

### Completed

- [x] Removed `<Static>` to eliminate ghost frame stacking
- [x] Isolated StatusBar timer to prevent per-second full re-renders
- [x] Static viewport windowing (`MAX_VISIBLE_ENTRIES = 50`)
- [x] Stabilized `handleSubmit` via `useRef` to prevent InputBox re-renders
- [x] DEC Mode 2026 sync output utility (written but disabled — freezes Ink's input loop via `queueMicrotask`)
- [x] tmux selection help hint added to HelpOverlay
- [x] **Tier 1a**: Height-aware viewport windowing (dynamic `computeMaxEntries(terminalRows)`)
- [x] **Tier 2**: Upgraded React 18→19 + Ink 5→6 with `maxFps: 0` (uncapped — our diff renderer handles efficiency)
- [x] Removed obsolete esbuild `inkRenderPatchPlugin` (Ink 6 fixes ghost line bug natively via `log.sync()`)
- [x] Removed unused `ink-spinner` and `ink-text-input` dependencies
- [x] Ink 6 built-in DEC Mode 2026 synchronized output (replaces our custom `syncOutput.ts`)
- [x] Stabilized all `useInput` handlers via `useRef` pattern to prevent keystroke dropping in React 19
- [x] **Ink 6 `incrementalRendering` disabled** — causes ghost lines and layout corruption in tmux when component tree structure changes (init→ready, typing updates). Standard rendering + `maxFps: 0` is the reliable path.
- [x] **Tier 3**: Line-level diff renderer (`diffLogUpdate.ts`) replaces Ink's `log-update.js` via esbuild plugin
- [x] **Tier 3**: Stable `useInput` hook (`stableUseInput.ts`) replaces Ink's `use-input.js` via esbuild plugin
- [x] **Tier 3**: `stdout.rows` proxy (9999) prevents Ink's clearTerminal/fullscreen path entirely
- [x] **Tier 3**: `pendingCommitAcksRef` FIFO queue in MultiLineInput prevents prop rollback during fast typing

### Verified

- Zero flickering in idle state (10/10 identical frame hashes)
- Zero flickering after session resume (10/10 identical)
- Clean live → completed transitions (no ghost frames)
- All 444 tests pass after Tier 3 renderer
- Clean esbuild bundle (no warnings)
- Fast typing at 10ms intervals: all characters captured in correct order (83-char rapid test)
- No ghost "Initializing..." or double status bar after init
- Clean multi-turn conversation rendering
- Clean init→ready transition with line-level diff (no erase/rewrite flicker)

### Remaining Issues

- Streaming content height cap not yet implemented (Tier 1b)
- Cell-level double buffering (full Tier 3 à la Claude Code) reserved if line-level diff proves insufficient

---

## Priority Order

1. ~~**Tier 1a** — Height-aware viewport windowing~~ ✅
2. **Tier 1b** — Streaming content height cap (remaining)
3. ~~**Tier 2** — Ink 6 + React 19 upgrade~~ ✅
4. ~~**Tier 3** — Custom differential renderer~~ ✅ (line-level diff via esbuild plugin)
5. **Tier 1c/1d** — Memoization and re-render reduction (low priority — current perf is good)

---

## References

- [Ink GitHub](https://github.com/vadimdemedes/ink)
- [Ink Flickering Analysis](https://github.com/atxtechbro/test-ink-flickering/blob/main/INK-ANALYSIS.md)
- [Ink Issue #359 — Flickering when view exceeds screen](https://github.com/vadimdemedes/ink/issues/359)
- [Ink Issue #450 — Flickering at precise screen height](https://github.com/vadimdemedes/ink/issues/450)
- [Ink 3 Performance Blog](https://vadimdemedes.com/posts/ink-3)
- [Ink 6 jsDocs](https://www.jsdocs.io/package/ink)
- [Claude Code Rendering Rewrite](https://www.threads.com/@boris_cherny/post/DSZbZatiIvJ)
- [Claude Code TUI Engineer on HN](https://news.ycombinator.com/item?id=46701013)
- [Profiling Claude Code Rendering](https://dev.to/vmitro/i-profiled-claude-code-some-more-part-2-do-androids-dream-of-on-diffs-2kp6)
- [Claude Code Flickering Issue #1913](https://github.com/anthropics/claude-code/issues/1913)
- [Claude Code Terminal CPU Spin Issue #21567](https://github.com/anthropics/claude-code/issues/21567)
- [DEC Mode 2026 Spec](https://gist.github.com/christianparpart/d8a62cc1ab659194337d73e399004036)
