/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule, TuiSlotContext } from "@opencode-ai/plugin/tui"
import { TextAttributes } from "@opentui/core"
import { createSignal, Show } from "solid-js"

// ═══════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════

interface TpsConfig {
  showTotal: boolean
  showPpSpeed: boolean
  showTgSpeed: boolean
  showCache: boolean
  showReasoning: boolean
  liveIntervalMs: number
}

const DEFAULT_CONFIG: TpsConfig = {
  showTotal: true,
  showPpSpeed: true,
  showTgSpeed: true,
  showCache: true,
  showReasoning: true,
  liveIntervalMs: 150,
}

// Try to load user config from a simple JSON file (optional)
let userConfig: Partial<TpsConfig> = {}
try {
  // @ts-ignore — dynamic import for config
  const configModule = await import("./tps-config.json")
  userConfig = configModule.default || configModule
} catch {
  // Config file doesn't exist — use defaults
}

const config: TpsConfig = { ...DEFAULT_CONFIG, ...userConfig }

// ═══════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════

interface TpsState {
  // Per-generation state
  isGenerating: boolean
  isPrefilling: boolean
  startTime: number | null
  firstTokenTime: number | null

  // Live output token count (char-level, approximated)
  liveOutputChars: number

  // Final values from step.ended (authoritative)
  ppSpeed: number | null  // tok/s — input tokens / time-to-first-token
  tgSpeed: number | null  // tok/s — output tokens / generation time
  // Session totals (never reset between messages)
  sessionInputTokens: number
  sessionOutputTokens: number
  sessionCacheTokens: number
  sessionReasoningTokens: number
}

export const createTracker = (options: { liveIntervalMs?: number } = {}) => {
  // Clamp interval to minimum 50ms; reject NaN/Infinity/negative
  const rawIntervalMs = options.liveIntervalMs ?? config.liveIntervalMs
  const intervalMs = Number.isFinite(rawIntervalMs) && rawIntervalMs >= 50 ? rawIntervalMs : 50

  const [state, setState] = createSignal<TpsState>({
    isGenerating: false,
    isPrefilling: false,
    startTime: null,
    firstTokenTime: null,
    liveOutputChars: 0,
    ppSpeed: null,
    tgSpeed: null,
    sessionInputTokens: 0,
    sessionOutputTokens: 0,
    sessionCacheTokens: 0,
    sessionReasoningTokens: 0,
  })

  const [liveTgSpeed, setLiveTgSpeed] = createSignal<number | null>(null)
  let intervalId: ReturnType<typeof setInterval> | null = null

  const startGeneration = () => {
    // Guard: don't double-start
    if (state().isGenerating) return

    if (intervalId) {
      clearInterval(intervalId)
      intervalId = null
    }

    setState(prev => ({
      ...prev,
      isGenerating: true,
      isPrefilling: true,
      startTime: Date.now(),
      firstTokenTime: null,
      liveOutputChars: 0,
      ppSpeed: null,
      tgSpeed: null,
      // cacheReadTokens and reasoningTokens NOT reset — preserve across generations
      // so UI does not blink when new gen starts
    }))

    // Live TG speed ticker
    intervalId = setInterval(() => {
      const s = state()
      if (!s.isGenerating || !s.firstTokenTime) {
        setLiveTgSpeed(null)
        return
      }
      const elapsed = (Date.now() - s.firstTokenTime) / 1000
      if (elapsed > 0 && s.liveOutputChars > 0) {
        // chars ≈ tokens (rough but live)
        setLiveTgSpeed(s.liveOutputChars / elapsed)
      }
    }, intervalMs)
  }

  const onFirstToken = () => {
    // Guard: don't overwrite an already-set firstTokenTime
    // (can happen via race: session.status busy → delta → step-start → delta)
    if (state().firstTokenTime !== null) return
    setState(prev => ({
      ...prev,
      isPrefilling: false,
      firstTokenTime: Date.now(),
    }))
  }

  const addDeltaChars = (count: number) => {
    if (!Number.isFinite(count) || count <= 0) return
    if (!state().isGenerating) return
    setState(prev => ({ ...prev, liveOutputChars: prev.liveOutputChars + count }))
  }

  const endGeneration = (
    inputTokens: number,
    outputTokens: number,
    cacheRead: number,
    reasoningTokens?: number,
  ) => {
    // Guard non-finite or negative tokens (would corrupt session totals)
    const safeInput = Number.isFinite(inputTokens) && inputTokens >= 0 ? inputTokens : 0
    const safeOutput = Number.isFinite(outputTokens) && outputTokens >= 0 ? outputTokens : 0
    const safeCache = Number.isFinite(cacheRead) && cacheRead > 0 ? cacheRead : 0
    const safeReasoning = reasoningTokens != null && Number.isFinite(reasoningTokens) && reasoningTokens > 0 ? reasoningTokens : 0

    if (!state().isGenerating) {
      // Accumulate tokens even after generation ended
      // (subagent step-finish arriving after main thread step-finish)
      accumulateTokens(safeInput, safeOutput, safeCache, safeReasoning)
      return
    }

    const now = Date.now()

    if (intervalId) {
      clearInterval(intervalId)
      intervalId = null
    }

    setState(prev => {
      const startTime = prev.startTime ?? now
      const firstTokenTime = prev.firstTokenTime ?? now

      // PP speed: how fast input was processed (input tokens / prefill time)
      const prefillSec = (firstTokenTime - startTime) / 1000
      const ppSpeed = prefillSec > 0 && safeInput > 0 ? safeInput / prefillSec : null

      // TG speed: authoritative from token counts / generation time
      const tgSec = (now - firstTokenTime) / 1000
      const tgSpeed = tgSec > 0 && safeOutput > 0 ? safeOutput / tgSec : null

      return {
        ...prev,
        isGenerating: false,
        isPrefilling: false,
        ppSpeed,
        tgSpeed,
        sessionInputTokens: prev.sessionInputTokens + safeInput,
        sessionOutputTokens: prev.sessionOutputTokens + safeOutput,
        sessionCacheTokens: prev.sessionCacheTokens + safeCache,
        sessionReasoningTokens: prev.sessionReasoningTokens + safeReasoning,
      }
    })

    setLiveTgSpeed(null)
  }

  const accumulateTokens = (
    inputTokens: number,
    outputTokens: number,
    cacheRead: number,
    reasoningTokens?: number,
  ) => {
    const safeInput = Number.isFinite(inputTokens) && inputTokens >= 0 ? inputTokens : 0
    const safeOutput = Number.isFinite(outputTokens) && outputTokens >= 0 ? outputTokens : 0
    const safeCache = Number.isFinite(cacheRead) && cacheRead > 0 ? cacheRead : 0
    const safeReasoning = reasoningTokens != null && Number.isFinite(reasoningTokens) && reasoningTokens > 0 ? reasoningTokens : 0

    setState(prev => ({
      ...prev,
      sessionInputTokens: prev.sessionInputTokens + safeInput,
      sessionOutputTokens: prev.sessionOutputTokens + safeOutput,
      sessionCacheTokens: prev.sessionCacheTokens + safeCache,
      sessionReasoningTokens: prev.sessionReasoningTokens + safeReasoning,
    }))
  }

  const formatSpeed = (speed: number | null): string => {
    if (speed === null || !Number.isFinite(speed)) return "--"
    if (Math.abs(speed) >= 1000) return `${(speed / 1000).toFixed(1)}K`
    return speed.toFixed(1)
  }

  return {
    state,
    liveTgSpeed,
    startGeneration,
    onFirstToken,
    addDeltaChars,
    accumulateTokens,
    endGeneration,
    formatSpeed,
  }
}

const tui: TuiPlugin = async (api) => {
  const tracker = createTracker()

  // Register sidebar slot
  api.slots.register({
    order: 150,
    slots: {
      sidebar_content(ctx: Readonly<TuiSlotContext>, props: { session_id: string }) {
        const theme = () => api.theme.current
        const s = () => tracker.state()

        const displayTgSpeed = () => {
          if (s().isGenerating) {
            const live = tracker.liveTgSpeed()
            return live !== null ? `${tracker.formatSpeed(live)} tok/s (cur)` : "..."
          }
          return s().tgSpeed !== null
            ? `${tracker.formatSpeed(s().tgSpeed)} tok/s (avg)`
            : "--"
        }

        const displayPpSpeed = () => {
          if (s().isPrefilling) return "..."
          return s().ppSpeed !== null
            ? `${tracker.formatSpeed(s().ppSpeed)} tok/s (avg)`
            : "--"
        }

        const totalSessionTokens = () =>
          s().sessionInputTokens + s().sessionOutputTokens + s().sessionReasoningTokens

        return (
          <box flexDirection="column" paddingTop={0} paddingBottom={0} gap={0}>
            <text fg={theme().text} attributes={TextAttributes.BOLD} wrapMode="none">Tokens</text>

            {/* Session total */}
            <Show when={config.showTotal}>
              <box flexDirection="row" gap={1}>
                <text fg={theme().textMuted} wrapMode="none">Total:</text>
                <text fg={theme().text} wrapMode="none">
                  {s().isGenerating
                    ? `${s().liveOutputChars} out`
                    : `${totalSessionTokens().toLocaleString()} total`
                  }
                </text>
              </box>
            </Show>

            {/* PP Speed */}
            <Show when={config.showPpSpeed}>
              <box flexDirection="row" gap={1}>
                <text fg={theme().textMuted} wrapMode="none">PP:</text>
                <text
                  fg={s().isPrefilling ? theme().info : theme().text}
                  wrapMode="none"
                >
                  {displayPpSpeed()}
                </text>
              </box>
            </Show>

            {/* TG Speed */}
            <Show when={config.showTgSpeed}>
              <box flexDirection="row" gap={1}>
                <text fg={theme().textMuted} wrapMode="none">TG:</text>
                <text
                  fg={s().isGenerating ? theme().success : theme().text}
                  wrapMode="none"
                >
                  {displayTgSpeed()}
                </text>
              </box>
            </Show>

            {/* Cache read tokens — cumulative session total */}
            <Show when={config.showCache && s().sessionCacheTokens > 0}>
              <box flexDirection="row" gap={1}>
                <text fg={theme().textMuted} wrapMode="none">Cache:</text>
                <text fg={theme().text} wrapMode="none">
                  {`${s().sessionCacheTokens.toLocaleString()} tok`}
                </text>
              </box>
            </Show>

            {/* Reasoning tokens — cumulative session total */}
            <Show when={config.showReasoning && s().sessionReasoningTokens > 0}>
              <box flexDirection="row" gap={1}>
                <text fg={theme().textMuted} wrapMode="none">Reasoning:</text>
                <text fg={theme().text} wrapMode="none">
                  {`${s().sessionReasoningTokens.toLocaleString()} tok`}
                </text>
              </box>
            </Show>
          </box>
        )
      }
    }
  })

  // Track which parts we've seen to detect first delta
  let seenFirstDelta = false
  // Track part types so we know what deltas to count
  const partTypes = new Map<string, string>()
  // Track current message ID to reject stale message.updated events
  let currentMessageId: string | null = null
  // Track last ended message ID to reject stale step-finish from previous gen
  // (when generation started via session.status, currentMessageId is null)
  let lastEndedMessageId: string | null = null

  // Step started → generation begins (prefill phase)
  api.event.on("message.part.updated", (event) => {
    const { properties } = event
    if (!properties || !properties.part) return
    const { part } = properties
    partTypes.set(part.id, part.type)
    console.log(`[TPS] message.part.updated: type=${part.type}`)

    if (part.type === "step-start") {
      if (!tracker.state().isGenerating) {
        currentMessageId = part.messageID
        seenFirstDelta = false
        tracker.startGeneration()
        console.log(`[TPS] Generation started for message ${currentMessageId}`)
      }
    }
    if (part.type === "step-finish") {
      const tokens = part.tokens
      if (!tokens) {
        console.log("[TPS] step-finish: no tokens, skipping")
        return
      }
      const cacheRead = tokens.cache?.read ?? 0
      // Subagent step-finish has a different messageID than the main thread
      if (part.messageID && currentMessageId && part.messageID !== currentMessageId) {
        console.log(`[TPS] step-finish (subagent): input=${tokens.input}, output=${tokens.output}, cache.read=${cacheRead}, reasoning=${tokens.reasoning}`)
        tracker.accumulateTokens(tokens.input, tokens.output, cacheRead, tokens.reasoning)
      } else if (part.messageID && !currentMessageId && part.messageID === lastEndedMessageId) {
        // Stale step-finish from a previous generation (session.status start path)
        console.log(`[TPS] step-finish (stale): input=${tokens.input}, output=${tokens.output}, cache.read=${cacheRead}, reasoning=${tokens.reasoning}`)
        tracker.accumulateTokens(tokens.input, tokens.output, cacheRead, tokens.reasoning)
      } else {
        console.log(`[TPS] step-finish: input=${tokens.input}, output=${tokens.output}, cache.read=${cacheRead}, reasoning=${tokens.reasoning}`)
        tracker.endGeneration(tokens.input, tokens.output, cacheRead, tokens.reasoning)
        if (!currentMessageId && part.messageID) {
          lastEndedMessageId = part.messageID
        }
      }
      seenFirstDelta = false
    }
  })

  // First text delta → prefill done, token generation starts
  api.event.on("message.part.delta", (event) => {
    const { properties } = event
    if (!properties) return
    const { partID, field, delta } = properties
    if (field !== "text") return
    console.log(`[TPS] message.part.delta: partID=${partID}, field=${field}, delta.length=${delta?.length}`)
    if (!seenFirstDelta) {
      tracker.onFirstToken()
      seenFirstDelta = true
      console.log("[TPS] First token received")
    }
    tracker.addDeltaChars(delta?.length || 0)
  })

  // Fallback: session.status busy → start, idle → end (covers models that
  // don't emit session.next.* events, or if step.ended is missed)
  api.event.on("session.status", (event) => {
    const { properties } = event
    if (!properties || !properties.status) return
    const status = properties.status
    console.log(`[TPS] session.status: type=${status?.type}`)
    if (status?.type === "busy") {
      if (!tracker.state().isGenerating) {
        // Clear messageID since session.status doesn't carry one;
        // step-finish without matching currentMessageId will be treated as authoritative
        currentMessageId = null
        seenFirstDelta = false
        tracker.startGeneration()
        console.log("[TPS] Generation started (via session.status)")
      }
    } else if (status?.type === "idle") {
      const s = tracker.state()
      if (s.isGenerating) {
        // Step.ended was not received — finish with char-based approximation
        console.log(`[TPS] session.idle fallback: ending with liveOutputChars=${s.liveOutputChars}`)
        tracker.endGeneration(0, s.liveOutputChars, 0)
        seenFirstDelta = false
      }
    }
  })

  // message.updated fires with final authoritative tokens when message completes
  api.event.on("message.updated", (event) => {
    const { properties } = event
    if (!properties || !properties.info) return
    const info = properties.info
    const completed = (info.time && "completed" in info.time && info.time.completed) ? info.time.completed : null
    console.log(`[TPS] message.updated: role=${info.role}, completed=${completed}, generating=${tracker.state().isGenerating}`)
    if (info.role !== "assistant") return
    // Only act when message is truly complete (has a completion time)
    if (!completed) return
    const tokens = info.tokens
    if (!tokens) return
    // Reject stale message.updated for old messages
    if (info.id && currentMessageId && info.id !== currentMessageId) return
    // Only use this as fallback if step.ended hasn't already resolved things
    if (!tracker.state().isGenerating) return
    console.log(`[TPS] message.updated fallback: input=${tokens.input}, output=${tokens.output}, cache.read=${tokens.cache?.read}, reasoning=${tokens.reasoning}`)
    tracker.endGeneration(
      tokens.input,
      tokens.output,
      tokens.cache?.read ?? 0,
      tokens.reasoning,
    )
    seenFirstDelta = false
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "tps.status",
  tui,
}

export default plugin
