# OpenCode TPS Plugin

> Real-time token speed metrics — PP and TG speeds with session totals — displayed in the OpenCode sidebar.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/Node-%3E%3D18-339933)

A TUI plugin for [OpenCode](https://opencode.ai) that monitors Prompt Processing (PP) and Token Generation (TG) speeds during every LLM interaction. Accumulates session-wide token totals including cache and reasoning tokens. Handles subagent nesting, connection drops, and rapid reconnects.

---

## Features

- **PP speed** — input tokens per second (authoritative from `step-finish`)
- **TG speed** — output tokens per second, live `(cur)` during streaming and `(avg)` after completion
- **Session totals** — cumulative input, output, cache, and reasoning tokens across all messages
- **Subagent nesting** — multi-layer subagent tokens accumulate without corrupting main thread speeds
- **Chaos-resilient** — survives connection timeouts, rapid reconnects, stale events, and interleaved failure modes
- **Configurable** — toggle each metric on/off and adjust the refresh interval via JSON config
- **Dual fallback chain** — `message.updated` + `session.status` idle catch missed `step-finish` events
- **No build step** — loaded directly by OpenCode at runtime as raw `.tsx`

## Tech Stack

| Component | Technology | Version |
|-----------|-----------|---------|
| Language | TypeScript | ^5.4.0 |
| UI Framework | SolidJS (via `@opentui/solid`) | runtime |
| Plugin API | `@opencode-ai/plugin/tui` | runtime |
| Test Runner | Vitest | ^1.6.0 |
| Runtime | Node.js | >= 18 |
| Module System | ESM (`type: "module"`) | — |

## Architecture

Three-layer design with strict separation of concerns:

```
┌─────────────────────────────────────────────┐
│  UI Layer (SolidJS JSX)                     │
│  - Registers in sidebar_content slot        │
│  - Reads tracker.state() via reactive sigs  │
│  - Uses api.theme.current for colors        │
├─────────────────────────────────────────────┤
│  Tracker (createTracker)                    │
│  - SolidJS signals for state                │
│  - accumulateTokens() for subagent routing  │
│  - Guards: double-start, double-end,        │
│    negative deltas, not-generating          │
│  - Live TG speed ticker via setInterval     │
├─────────────────────────────────────────────┤
│  Event Handlers (tui function)              │
│  - message.part.updated → step-start/finish │
│  - message.part.delta → text deltas         │
│  - session.status → busy/idle fallback      │
│  - message.updated → final tokens fallback  │
│  - Message-ID correlation for subagent      │
│    detection + stale event rejection        │
└─────────────────────────────────────────────┘
```

### Data Flow

1. **`step-start`** → `startGeneration()` — starts timer, marks prefill phase
2. **First `text` delta** → `onFirstToken()` — records first-token timestamp, ends prefill
3. **Each delta** → `addDeltaChars()` — accumulates live character count
4. **`step-finish`** (matching messageID) → `endGeneration()` — computes PP/TG speeds, accumulates session totals
5. **`step-finish`** (subagent, different messageID) → `accumulateTokens()` — adds to session totals without affecting speeds or generation state
6. **Fallbacks** — `message.updated` (authoritative tokens) or `session.status idle` (char-based approximation)

## Getting Started

### Prerequisites

- Node.js v18+ (ES modules)
- npm v9+
- OpenCode with TUI plugin support

### Installation

### From npm (recommended)

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["@jimicze-pw/opencode-tps"]
}
```

Or via CLI:

```shell
opencode plugin @jimicze-pw/opencode-tps
```

OpenCode auto-installs and caches it — no manual setup needed.

### From source (development)

```shell
git clone <repo-url> ~/.config/opencode/plugins/tps
```

Register in `.opencode/tui.json`:

```json
{
  "plugin": ["./plugins/tps-plugin.tsx"]
}
```

Restart OpenCode. The plugin loads automatically.

> No build step — OpenCode loads `.tsx` directly at runtime.

## Metrics

| Metric | Idle | Prefilling | Generating | Complete |
|--------|------|------------|------------|---------|
| **Total** | `1,234 total` | `0 out` | `42 out` | `1,234 total` |
| **PP** | `--` | `...` (blue) | `512 tok/s (avg)` | `512 tok/s (avg)` |
| **TG** | `--` | `...` (green) | `63 tok/s (cur)` (green) | `63 tok/s (avg)` |
| **Cache** | hidden | hidden | hidden | `200 tok` |
| **Reasoning** | hidden | hidden | hidden | `30 tok` |

### Calculation

- **PP Speed** = input tokens / prefill time (authoritative from `step-finish`)
- **TG Speed** = output tokens / generation time (authoritative from `step-finish`)
- **Live TG** = chars generated / time since first token (approximate; no tokenizer access in TUI)
- **Session Totals** = cumulative across all assistant messages, never reset

### Configuration

Create `.opencode/plugins/tps-config.json` to customize display:

```json
{
  "showTotal": true,
  "showPpSpeed": true,
  "showTgSpeed": true,
  "showCache": true,
  "showReasoning": true,
  "liveIntervalMs": 150
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `showTotal` | `true` | Show total token count |
| `showPpSpeed` | `true` | Show PP speed |
| `showTgSpeed` | `true` | Show TG speed |
| `showCache` | `true` | Show cache tokens (when > 0) |
| `showReasoning` | `true` | Show reasoning tokens (when available) |
| `liveIntervalMs` | `150` | Live TG speed update interval (ms, clamped to >= 50) |

## Project Structure

```
.
├── .opencode/
│   ├── plugins/
│   │   ├── tps-plugin.tsx          # Source (457 lines)
│   │   └── tps-plugin.test.ts      # Tests (2974 lines)
│   ├── tui.json                    # Plugin registration
│   ├── tsconfig-check.json         # TypeScript config
│   └── opencode.json               # OpenCode config
├── package.json                    # Dev dependencies
├── vitest.config.ts                # Test config
└── .gitignore                      # Ignores docs/, AGENTS.md, .opencode/*.md

## Development

### Setup

```shell
npm install        # install vitest + typescript
```

### Test

```shell
npm test           # vitest run — 163 tests
npm run test:watch # watch mode
```

### TypeCheck

```shell
npm run typecheck  # tsc --noEmit via tsconfig-check.json
```

> No lint or format tool configured — the project is intentionally minimal (1 source file).

### Test Coverage

| Suite | Tests | Focus |
|-------|-------|-------|
| `createTracker` | ~80 | Guards, state transitions, accumulation, formatting, interval |
| `accumulateTokens` | 5 | Subagent-safe accumulation, speed preservation, nesting |
| `chaos scenarios` | 7 | Timeouts, reconnects, stale events, interleaved failures |
| `event handlers` | ~70 | All 4 handlers, malformed data, subagent routing, stale rejection |
| **Total** | **163** | **120 negative, 43 positive** |

Test philosophy: negative tests outnumber positive. Every guard, edge case, and failure mode is tested before the happy path.

## Troubleshooting

### Plugin not showing in sidebar

- Check `.opencode/tui.json` has the correct path to `./plugins/tps-plugin.tsx`
- Verify `~/.local/state/opencode/plugin-meta.json` shows `tps.status` with a load count
- Restart OpenCode — plugins load at session start

### Metrics look wrong

- **PP speed is very high** — normal with fast models; prefill time can be < 20ms
- **TG speed drops to zero** — `step-finish` was likely missed; a fallback from `session.status` or `message.updated` is used instead
- **Cache is zero** — some providers don't report cache tokens; this is expected
- **Session totals include subagent tokens** — by design; subagent work contributes to the session total

### Debug logs not visible

- `console.log` from the plugin goes to the **TUI/browser console**, not `opencode.log`
- Look for `[TPS]`-prefixed messages in the browser console

## Known Limitations

- **Live TG speed is approximate** — uses char count as a proxy for tokens (no tokenizer access in TUI)
- **Session totals reset on OpenCode restart** — this is intentional (session-level, not global)
- **Idle fallback may slight double-count** — if `step-finish` arrives after idle fallback ran, the char proxy and authoritative tokens both accumulate. Acceptable trade-off for an edge case.
- **No formatter/linter configured** — project is intentionally minimal

## Contributing

The project uses a test-driven approach with extensive negative testing. See the test file for conventions, and the `.opencode/` agent context files if you have access to them.

## Backlog

Top candidates for future work:

- Per-model speed tracking
- UI polish (prefill spinner, toggle sidebar/footer)
- Cost estimation (if token pricing is available from API)
- Config option to reset session totals

## License

MIT — see [LICENSE](LICENSE).
