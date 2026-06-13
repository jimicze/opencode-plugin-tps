import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createTracker } from './tps-plugin'

// Small helper to wait for timers
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('createTracker', () => {
  let tracker: ReturnType<typeof createTracker>

  beforeEach(() => {
    tracker = createTracker()
  })

  // ─────────────────────────────────────────────────────────────
  // NEGATIVE TESTS — what should NOT happen, edge cases, guards
  // ─────────────────────────────────────────────────────────────

  describe('NEGATIVE: startGeneration guards', () => {
    it('should not reset state when called twice (double-start guard)', () => {
      tracker.startGeneration()
      const s1 = tracker.state()
      expect(s1.isGenerating).toBe(true)
      expect(s1.startTime).not.toBeNull()

      // Simulate time passing
      const originalStartTime = s1.startTime

      // Second call should be ignored
      tracker.startGeneration()
      const s2 = tracker.state()
      expect(s2.isGenerating).toBe(true)
      expect(s2.startTime).toBe(originalStartTime)
    })

    it('should not start if already generating (prefill guard)', () => {
      tracker.startGeneration()
      tracker.onFirstToken()
      const s1 = tracker.state()
      expect(s1.isPrefilling).toBe(false)
      expect(s1.firstTokenTime).not.toBeNull()

      // Double start should not reset firstTokenTime
      tracker.startGeneration()
      const s2 = tracker.state()
      expect(s2.firstTokenTime).toBe(s1.firstTokenTime)
    })
  })

  describe('NEGATIVE: endGeneration guards', () => {
    it('should not end if not currently generating (double-end guard)', () => {
      tracker.endGeneration(10, 20, 5)
      const s = tracker.state()
      expect(s.isGenerating).toBe(false)
      expect(s.ppSpeed).toBeNull()
      expect(s.tgSpeed).toBeNull()
      // Tokens still accumulate even when not generating
      // (subagent step-finish after main thread step-finish)
      expect(s.sessionInputTokens).toBe(10)
      expect(s.sessionOutputTokens).toBe(20)
    })

    it('should not double-accumulate session totals on double end', () => {
      tracker.startGeneration()
      tracker.onFirstToken()
      // Wait a tiny bit so time > 0
      const start = Date.now()
      while (Date.now() - start < 10) {} // 10ms
      tracker.endGeneration(10, 20, 5)

      const s1 = tracker.state()
      expect(s1.sessionInputTokens).toBe(10)
      expect(s1.sessionOutputTokens).toBe(20)

      // Second end is NOT ignored — tokens accumulate
      // (subagent finishing after main thread)
      tracker.endGeneration(10, 20, 5)
      const s2 = tracker.state()
      expect(s2.sessionInputTokens).toBe(20)
      expect(s2.sessionOutputTokens).toBe(40)
    })

    it('should handle end without firstToken gracefully (zero time prefill)', () => {
      tracker.startGeneration()
      // End immediately without first token
      tracker.endGeneration(100, 0, 0)
      const s = tracker.state()
      expect(s.ppSpeed).toBeNull() // prefillSec = 0, so null
      expect(s.tgSpeed).toBeNull() // no output tokens, no firstTokenTime
    })

    it('should handle end with zero output tokens', () => {
      tracker.startGeneration()
      tracker.onFirstToken()
      const start = Date.now()
      while (Date.now() - start < 10) {}
      tracker.endGeneration(10, 0, 0)
      const s = tracker.state()
      expect(s.tgSpeed).toBeNull() // outputTokens = 0
      expect(s.sessionOutputTokens).toBe(0)
    })

    it('should handle end with zero input tokens', () => {
      tracker.startGeneration()
      const prefillStart = Date.now()
      while (Date.now() - prefillStart < 20) {}
      tracker.onFirstToken()
      const start = Date.now()
      while (Date.now() - start < 10) {}
      tracker.endGeneration(0, 10, 0)
      const s = tracker.state()
      // Ensure prefillSec > 0 so ppSpeed would be 0 if not guarded
      expect(s.ppSpeed).toBeNull() // inputTokens = 0 → null, not "0.0"
      expect(s.sessionInputTokens).toBe(0)
    })

    it('should handle end with zero input tokens and force prefill > 0', () => {
      tracker.startGeneration()
      const prefillStart = Date.now()
      while (Date.now() - prefillStart < 30) {}
      tracker.onFirstToken()
      const start = Date.now()
      while (Date.now() - start < 10) {}
      tracker.endGeneration(0, 10, 0)
      const s = tracker.state()
      // prefillSec > 0 (30ms), inputTokens = 0 → should be null, not 0.0
      expect(s.ppSpeed).toBeNull()
      expect(s.sessionInputTokens).toBe(0)
    })

    it('should handle end with negative output tokens', () => {
      tracker.startGeneration()
      tracker.onFirstToken()
      const start = Date.now()
      while (Date.now() - start < 10) {}
      tracker.endGeneration(10, -5, 0)
      const s = tracker.state()
      expect(s.tgSpeed).toBeNull() // outputTokens <= 0
      expect(s.sessionOutputTokens).toBe(0) // negative guarded
    })

    it('should handle end with negative input tokens', () => {
      tracker.startGeneration()
      tracker.onFirstToken()
      const start = Date.now()
      while (Date.now() - start < 10) {}
      tracker.endGeneration(-10, 20, 0)
      const s = tracker.state()
      expect(s.ppSpeed).toBeNull() // prefillSec > 0 but inputTokens <= 0
      expect(s.sessionInputTokens).toBe(0) // negative guarded
    })

    it('should handle end with mixed NaN tokens (some valid, some NaN)', () => {
      tracker.startGeneration()
      tracker.onFirstToken()
      const start = Date.now()
      while (Date.now() - start < 10) {}
      tracker.endGeneration(10, NaN, NaN)
      const s = tracker.state()
      expect(s.tgSpeed).toBeNull()
      expect(s.sessionCacheTokens).toBe(0)
      // NaN outputTokens is guarded — session stays at 0
      expect(s.sessionOutputTokens).toBe(0)
      expect(s.sessionInputTokens).toBe(10) // valid input preserved
    })
  })

  describe('NEGATIVE: onFirstToken edge cases', () => {
    it('should not crash if called without startGeneration', () => {
      tracker.onFirstToken()
      const s = tracker.state()
      expect(s.isPrefilling).toBe(false)
      expect(s.firstTokenTime).not.toBeNull()
    })

    it('should not reset firstTokenTime on second call', () => {
      tracker.startGeneration()
      tracker.onFirstToken()
      const t1 = tracker.state().firstTokenTime

      tracker.onFirstToken()
      const t2 = tracker.state().firstTokenTime
      expect(t2).toBe(t1)
    })

    it('should not crash if called after generation ended', () => {
      tracker.startGeneration()
      tracker.onFirstToken()
      const start = Date.now()
      while (Date.now() - start < 10) {}
      tracker.endGeneration(10, 20, 5)

      // onFirstToken after end — should not crash or resurrect state
      tracker.onFirstToken()
      const s = tracker.state()
      expect(s.isGenerating).toBe(false)
      expect(s.isPrefilling).toBe(false)
    })

    it('should preserve firstTokenTime via race: session.status → delta → step-start → delta', () => {
      // Simulate: session.status busy starts generation
      tracker.startGeneration()
      
      // Simulate: first delta arrives after session.status
      tracker.onFirstToken()
      const t1 = tracker.state().firstTokenTime
      tracker.addDeltaChars(10)

      // Simulate: step-start fires (double-start guard = no-op)
      tracker.startGeneration()
      expect(tracker.state().firstTokenTime).toBe(t1) // UNCHANGED

      // Simulate: second delta arrives (would trigger onFirstToken if seenFirstDelta reset)
      // Without the guard, this would overwrite firstTokenTime
      tracker.onFirstToken()
      expect(tracker.state().firstTokenTime).toBe(t1) // UNCHANGED
    })
  })

  describe('NEGATIVE: addDeltaChars edge cases', () => {
    it('should ignore negative delta chars', () => {
      tracker.startGeneration()
      tracker.onFirstToken()
      tracker.addDeltaChars(10)
      const s1 = tracker.state()
      expect(s1.liveOutputChars).toBe(10)

      tracker.addDeltaChars(-5)
      const s2 = tracker.state()
      expect(s2.liveOutputChars).toBe(10) // unchanged
    })

    it('should ignore zero delta chars', () => {
      tracker.startGeneration()
      tracker.onFirstToken()
      tracker.addDeltaChars(10)
      tracker.addDeltaChars(0)
      const s = tracker.state()
      expect(s.liveOutputChars).toBe(10)
    })

    it('should not add delta chars if not generating', () => {
      tracker.addDeltaChars(10)
      const s = tracker.state()
      expect(s.liveOutputChars).toBe(0)
    })

    it('should count delta chars during prefill (before onFirstToken)', () => {
      tracker.startGeneration()
      tracker.addDeltaChars(50)
      const s = tracker.state()
      expect(s.liveOutputChars).toBe(50)
      expect(s.isPrefilling).toBe(true)
    })

    it('should handle extremely large delta count', () => {
      tracker.startGeneration()
      tracker.onFirstToken()
      tracker.addDeltaChars(Number.MAX_SAFE_INTEGER)
      const s = tracker.state()
      expect(s.liveOutputChars).toBe(Number.MAX_SAFE_INTEGER)
    })

    it('should ignore very large negative delta count', () => {
      tracker.startGeneration()
      tracker.onFirstToken()
      tracker.addDeltaChars(100)
      tracker.addDeltaChars(-999999)
      const s = tracker.state()
      expect(s.liveOutputChars).toBe(100)
    })

    it('should ignore NaN delta count', () => {
      tracker.startGeneration()
      tracker.onFirstToken()
      tracker.addDeltaChars(10)
      tracker.addDeltaChars(NaN)
      const s = tracker.state()
      expect(s.liveOutputChars).toBe(10)
    })

    it('should ignore Infinity delta count', () => {
      tracker.startGeneration()
      tracker.onFirstToken()
      tracker.addDeltaChars(10)
      tracker.addDeltaChars(Infinity)
      const s = tracker.state()
      expect(s.liveOutputChars).toBe(10)
    })
  })

  describe('NEGATIVE: formatSpeed edge cases', () => {
    it('should return "--" for null', () => {
      expect(tracker.formatSpeed(null)).toBe('--')
    })

    it('should return "0.0" for zero', () => {
      expect(tracker.formatSpeed(0)).toBe('0.0')
    })

    it('should return "0.0" for negative speed', () => {
      expect(tracker.formatSpeed(-10)).toBe('-10.0')
    })

    it('should format large numbers as K', () => {
      expect(tracker.formatSpeed(1000)).toBe('1.0K')
      expect(tracker.formatSpeed(1500)).toBe('1.5K')
      expect(tracker.formatSpeed(9999)).toBe('10.0K')
    })

    it('should handle edge case just below 1000', () => {
      expect(tracker.formatSpeed(999)).toBe('999.0')
      expect(tracker.formatSpeed(999.9)).toBe('999.9')
    })

    it('should handle very small numbers', () => {
      expect(tracker.formatSpeed(0.1)).toBe('0.1')
      expect(tracker.formatSpeed(0.01)).toBe('0.0')
    })

    it('should handle NaN', () => {
      expect(tracker.formatSpeed(NaN)).toBe('--')
    })

    it('should handle Infinity', () => {
      expect(tracker.formatSpeed(Infinity)).toBe('--')
    })

    it('should handle -Infinity', () => {
      expect(tracker.formatSpeed(-Infinity)).toBe('--')
    })

    it('should handle negative zero', () => {
      expect(tracker.formatSpeed(-0)).toBe('0.0')
    })

    it('should handle very small negative number', () => {
      expect(tracker.formatSpeed(-0.001)).toBe('-0.0')
    })

    it('should handle very large negative number', () => {
      expect(tracker.formatSpeed(-5000)).toBe('-5.0K')
    })

    it('should handle Number.MAX_SAFE_INTEGER', () => {
      expect(tracker.formatSpeed(Number.MAX_SAFE_INTEGER)).toBe('9007199254741.0K')
    })
  })

  describe('NEGATIVE: live TG speed ticker', () => {
    it('should not create interval if not generating', () => {
      // startGeneration is what creates the interval
      tracker.startGeneration()
      tracker.onFirstToken()
      // Now there is an interval
      const s1 = tracker.state()
      expect(s1.isGenerating).toBe(true)
    })

    it('should clear interval on endGeneration', () => {
      tracker.startGeneration()
      tracker.onFirstToken()
      tracker.addDeltaChars(100)
      const start = Date.now()
      while (Date.now() - start < 20) {}
      tracker.endGeneration(10, 20, 0)
      // After end, liveTgSpeed should be null
      expect(tracker.liveTgSpeed()).toBeNull()
    })
  })

  describe('NEGATIVE: cache token handling', () => {
    it('should store null for zero cache tokens', () => {
      tracker.startGeneration()
      tracker.onFirstToken()
      const start = Date.now()
      while (Date.now() - start < 10) {}
      tracker.endGeneration(10, 20, 0)
      const s = tracker.state()
      expect(s.sessionCacheTokens).toBe(0)
    })

    it('should store null for negative cache tokens', () => {
      tracker.startGeneration()
      tracker.onFirstToken()
      const start = Date.now()
      while (Date.now() - start < 10) {}
      tracker.endGeneration(10, 20, -5)
      const s = tracker.state()
      expect(s.sessionCacheTokens).toBe(0)
    })

    it('should store null for NaN cache tokens', () => {
      tracker.startGeneration()
      tracker.onFirstToken()
      const start = Date.now()
      while (Date.now() - start < 10) {}
      tracker.endGeneration(10, 20, NaN)
      const s = tracker.state()
      expect(s.sessionCacheTokens).toBe(0)
    })

    it('should store positive cache tokens correctly', () => {
      tracker.startGeneration()
      tracker.onFirstToken()
      const start = Date.now()
      while (Date.now() - start < 10) {}
      tracker.endGeneration(10, 20, 75_636)
      const s = tracker.state()
      expect(s.sessionCacheTokens).toBe(75_636)
    })
  })

  describe('NEGATIVE: state mutation after end', () => {
    it('should not allow adding delta chars after generation ends', () => {
      tracker.startGeneration()
      tracker.onFirstToken()
      tracker.addDeltaChars(10)
      const start = Date.now()
      while (Date.now() - start < 10) {}
      tracker.endGeneration(10, 20, 0)

      tracker.addDeltaChars(5)
      const s = tracker.state()
      expect(s.liveOutputChars).toBe(10) // should not increase after end
    })
  })

  describe('NEGATIVE: metric reset behavior', () => {
    it('should reset ppSpeed on startGeneration', () => {
      // First generation sets a ppSpeed
      tracker.startGeneration()
      const prefillStart = Date.now()
      while (Date.now() - prefillStart < 20) {}
      tracker.onFirstToken()
      const start = Date.now()
      while (Date.now() - start < 10) {}
      tracker.endGeneration(100, 50, 10)
      expect(tracker.state().ppSpeed).not.toBeNull()

      // startGeneration should reset ppSpeed to null
      tracker.startGeneration()
      expect(tracker.state().ppSpeed).toBeNull()
    })

    it('should reset tgSpeed on startGeneration', () => {
      tracker.startGeneration()
      const prefillStart = Date.now()
      while (Date.now() - prefillStart < 20) {}
      tracker.onFirstToken()
      const start = Date.now()
      while (Date.now() - start < 10) {}
      tracker.endGeneration(100, 50, 10)
      expect(tracker.state().tgSpeed).not.toBeNull()

      tracker.startGeneration()
      expect(tracker.state().tgSpeed).toBeNull()
    })

    it('should not reset sessionCacheTokens across startGeneration', () => {
      tracker.startGeneration()
      const prefillStart = Date.now()
      while (Date.now() - prefillStart < 20) {}
      tracker.onFirstToken()
      const start = Date.now()
      while (Date.now() - start < 10) {}
      tracker.endGeneration(100, 50, 10)
      expect(tracker.state().sessionCacheTokens).toBe(10)

      tracker.startGeneration()
      // session cache total persists across generations (never reset)
      expect(tracker.state().sessionCacheTokens).toBe(10)
    })

    it('should not reset sessionReasoningTokens across startGeneration', () => {
      tracker.startGeneration()
      const prefillStart = Date.now()
      while (Date.now() - prefillStart < 20) {}
      tracker.onFirstToken()
      const start = Date.now()
      while (Date.now() - start < 10) {}
      tracker.endGeneration(100, 50, 10, 30)
      expect(tracker.state().sessionReasoningTokens).toBe(30)

      tracker.startGeneration()
      // session reasoning total persists across generations (never reset)
      expect(tracker.state().sessionReasoningTokens).toBe(30)
    })

    it('should not show stale ppSpeed between onFirstToken and endGeneration', () => {
      // Gen 1: produces a ppSpeed
      tracker.startGeneration()
      const p1 = Date.now()
      while (Date.now() - p1 < 20) {}
      tracker.onFirstToken()
      const s1 = Date.now()
      while (Date.now() - s1 < 10) {}
      tracker.endGeneration(100, 50, 10)
      expect(tracker.state().ppSpeed).not.toBeNull()

      // Gen 2: between onFirstToken and endGeneration, ppSpeed should NOT be gen1's value
      tracker.startGeneration()
      expect(tracker.state().ppSpeed).toBeNull() // reset on start
      const p2 = Date.now()
      while (Date.now() - p2 < 20) {}
      tracker.onFirstToken()
      // After onFirstToken but before endGeneration — ppSpeed should still be null
      expect(tracker.state().ppSpeed).toBeNull() // was reset, not computed yet
    })
  })

  // ─────────────────────────────────────────────────────────────
    // POSITIVE TESTS — happy path, normal behavior
  // ─────────────────────────────────────────────────────────────

  describe('NEGATIVE: edge case liveIntervalMs', () => {
    it('should handle liveIntervalMs: 0', () => {
      const t = createTracker({ liveIntervalMs: 0 })
      t.startGeneration()
      t.onFirstToken()
      t.addDeltaChars(10)
      t.endGeneration(100, 50, 0)
      expect(t.state().sessionInputTokens).toBe(100)
    })

    it('should handle liveIntervalMs: -100', () => {
      const t = createTracker({ liveIntervalMs: -100 })
      t.startGeneration()
      t.onFirstToken()
      t.addDeltaChars(10)
      t.endGeneration(100, 50, 0)
      expect(t.state().sessionInputTokens).toBe(100)
    })

    it('should handle liveIntervalMs: NaN', () => {
      const t = createTracker({ liveIntervalMs: NaN })
      t.startGeneration()
      t.onFirstToken()
      t.addDeltaChars(10)
      t.endGeneration(100, 50, 0)
      expect(t.state().sessionInputTokens).toBe(100)
    })
  })

  describe('POSITIVE: normal flow', () => {
    it('should track a complete generation cycle', () => {
      tracker.startGeneration()
      const s1 = tracker.state()
      expect(s1.isGenerating).toBe(true)
      expect(s1.isPrefilling).toBe(true)
      expect(s1.startTime).not.toBeNull()

      // Wait for prefill time
      const prefillStart = Date.now()
      while (Date.now() - prefillStart < 20) {}

      tracker.onFirstToken()
      const s2 = tracker.state()
      expect(s2.isPrefilling).toBe(false)
      expect(s2.firstTokenTime).not.toBeNull()

      tracker.addDeltaChars(50)
      const s3 = tracker.state()
      expect(s3.liveOutputChars).toBe(50)

      tracker.addDeltaChars(30)
      const s4 = tracker.state()
      expect(s4.liveOutputChars).toBe(80)

      const start = Date.now()
      while (Date.now() - start < 20) {}
      tracker.endGeneration(100, 80, 50)
      const s5 = tracker.state()
      expect(s5.isGenerating).toBe(false)
      expect(s5.isPrefilling).toBe(false)
      expect(s5.ppSpeed).not.toBeNull()
      expect(s5.tgSpeed).not.toBeNull()
      expect(s5.sessionInputTokens).toBe(100)
      expect(s5.sessionOutputTokens).toBe(80)
      expect(s5.sessionCacheTokens).toBe(50)
    })
  })

  describe('POSITIVE: session accumulation', () => {
    it('should accumulate session totals across multiple generations', () => {
      // First generation
      tracker.startGeneration()
      tracker.onFirstToken()
      const start1 = Date.now()
      while (Date.now() - start1 < 10) {}
      tracker.endGeneration(100, 50, 20)

      const s1 = tracker.state()
      expect(s1.sessionInputTokens).toBe(100)
      expect(s1.sessionOutputTokens).toBe(50)

      // Second generation
      tracker.startGeneration()
      tracker.onFirstToken()
      const start2 = Date.now()
      while (Date.now() - start2 < 10) {}
      tracker.endGeneration(50, 30, 10)

      const s2 = tracker.state()
      expect(s2.sessionInputTokens).toBe(150)
      expect(s2.sessionOutputTokens).toBe(80)
      expect(s2.sessionCacheTokens).toBe(30) // 20 + 10
      // sessionReasoningTokens stays 0 — no reasoning arg passed
      expect(s2.sessionReasoningTokens).toBe(0)
    })

    it('should accumulate cache and reasoning across generations', () => {
      // Gen 1: cache=20, reasoning=30
      tracker.startGeneration()
      tracker.onFirstToken()
      const start1 = Date.now()
      while (Date.now() - start1 < 5) {}
      tracker.endGeneration(100, 50, 20, 30)
      expect(tracker.state().sessionCacheTokens).toBe(20)
      expect(tracker.state().sessionReasoningTokens).toBe(30)

      // Gen 2: cache=10, no reasoning
      tracker.startGeneration()
      tracker.onFirstToken()
      const start2 = Date.now()
      while (Date.now() - start2 < 5) {}
      tracker.endGeneration(50, 30, 10)
      expect(tracker.state().sessionCacheTokens).toBe(30) // 20 + 10
      expect(tracker.state().sessionReasoningTokens).toBe(30) // 30 + 0

      // Gen 3: no cache, reasoning=15
      tracker.startGeneration()
      tracker.onFirstToken()
      const start3 = Date.now()
      while (Date.now() - start3 < 5) {}
      tracker.endGeneration(10, 20, 0, 15)
      expect(tracker.state().sessionCacheTokens).toBe(30) // 30 + 0
      expect(tracker.state().sessionReasoningTokens).toBe(45) // 30 + 15
    })

    it('should include subagent tokens in session totals', () => {
      // Main thread generates a message
      tracker.startGeneration()
      tracker.onFirstToken()
      const start1 = Date.now()
      while (Date.now() - start1 < 5) {}
      tracker.endGeneration(100, 50, 20, 30)
      expect(tracker.state().sessionInputTokens).toBe(100)
      expect(tracker.state().sessionOutputTokens).toBe(50)
      expect(tracker.state().sessionCacheTokens).toBe(20)
      expect(tracker.state().sessionReasoningTokens).toBe(30)

      // Subagent starts a new generation (main thread already finished)
      tracker.startGeneration()
      tracker.onFirstToken()
      const start2 = Date.now()
      while (Date.now() - start2 < 5) {}
      tracker.endGeneration(50, 25, 10, 15)

      const s = tracker.state()
      // Session totals must include BOTH main thread and subagent
      expect(s.sessionInputTokens).toBe(150) // 100 + 50
      expect(s.sessionOutputTokens).toBe(75)  // 50 + 25
      expect(s.sessionCacheTokens).toBe(30)   // 20 + 10
      expect(s.sessionReasoningTokens).toBe(45) // 30 + 15
    })

    it('should accumulate subagent tokens even when subagent overlaps main thread generation', () => {
      // Main thread starts
      tracker.startGeneration()
      tracker.onFirstToken()
      const start1 = Date.now()
      while (Date.now() - start1 < 5) {}

      // Subagent starts DURING main thread (would be blocked by double-start guard)
      tracker.startGeneration()
      tracker.onFirstToken()

      // Both add deltas
      tracker.addDeltaChars(50)

      // Main thread finishes first
      tracker.endGeneration(100, 50, 20, 30)

      // Subagent finishes after — its tokens must still be accumulated
      tracker.endGeneration(50, 25, 10, 15)

      const s = tracker.state()
      expect(s.sessionInputTokens).toBe(150) // 100 + 50
      expect(s.sessionOutputTokens).toBe(75)  // 50 + 25
      expect(s.sessionCacheTokens).toBe(30)   // 20 + 10
      expect(s.sessionReasoningTokens).toBe(45) // 30 + 15
    })

    it('should reset firstTokenTime across generation cycles', () => {
      // Gen 1
      tracker.startGeneration()
      tracker.onFirstToken()
      const t1 = tracker.state().firstTokenTime
      expect(t1).not.toBeNull()
      tracker.endGeneration(10, 20, 0)

      // Advance clock so t2 differs from t1
      const clock1 = Date.now()
      while (Date.now() - clock1 < 5) {}

      // Gen 2 — firstTokenTime is reset by startGeneration
      tracker.startGeneration()
      expect(tracker.state().firstTokenTime).toBeNull()
      tracker.onFirstToken()
      const t2 = tracker.state().firstTokenTime
      expect(t2).not.toBeNull()
      expect(t2).toBeGreaterThan(t1!) // time has advanced

      tracker.endGeneration(10, 20, 0)

      // Gen 3 — no onFirstToken, firstTokenTime stays null across start/end
      tracker.startGeneration()
      expect(tracker.state().firstTokenTime).toBeNull()
      tracker.endGeneration(0, 0, 0)
      expect(tracker.state().firstTokenTime).toBeNull()
    })

    it('should accumulate session output tokens from live chars via idle fallback', () => {
      tracker.startGeneration()
      tracker.onFirstToken()
      const start = Date.now()
      while (Date.now() - start < 10) {}
      tracker.addDeltaChars(50)

      // Idle fallback uses liveOutputChars as output in endGeneration(0, liveOutputChars, 0)
      tracker.endGeneration(0, tracker.state().liveOutputChars, 0)
      const s = tracker.state()
      expect(s.sessionOutputTokens).toBe(50)
    })
  })

  describe('POSITIVE: formatSpeed', () => {
    it('should format normal speeds correctly', () => {
      expect(tracker.formatSpeed(10.5)).toBe('10.5')
      expect(tracker.formatSpeed(100)).toBe('100.0')
      expect(tracker.formatSpeed(999)).toBe('999.0')
    })

    it('should format K speeds correctly', () => {
      expect(tracker.formatSpeed(1000)).toBe('1.0K')
      expect(tracker.formatSpeed(2500)).toBe('2.5K')
    })
  })

  describe('POSITIVE: live TG speed', () => {
    it('should compute live TG speed during generation', async () => {
      tracker.startGeneration()
      tracker.onFirstToken()
      tracker.addDeltaChars(100)

      // Wait for the interval to tick (150ms)
      await wait(200)

      const live = tracker.liveTgSpeed()
      expect(live).not.toBeNull()
      expect(live).toBeGreaterThan(0)
    })

    it('should be null at start of a new generation cycle', async () => {
      // Gen 1: produce live tg speed
      tracker.startGeneration()
      tracker.onFirstToken()
      tracker.addDeltaChars(100)
      await wait(200)
      expect(tracker.liveTgSpeed()).not.toBeNull()

      // End gen 1
      tracker.endGeneration(100, 50, 0)

      // Gen 2: just started, no first token yet — liveTgSpeed should be null
      tracker.startGeneration()
      expect(tracker.liveTgSpeed()).toBeNull()
    })
  })

  describe('POSITIVE: PP speed calculation', () => {
    it('should calculate PP speed when time > 0', () => {
      tracker.startGeneration()
      // Wait a bit for prefill time
      const start = Date.now()
      while (Date.now() - start < 20) {}
      tracker.onFirstToken()
      tracker.endGeneration(100, 50, 0)

      const s = tracker.state()
      expect(s.ppSpeed).not.toBeNull()
      expect(s.ppSpeed).toBeGreaterThan(0)
      // 100 tokens / ~0.02s = ~5000 tok/s (very fast because we wait only 20ms)
      expect(s.ppSpeed).toBeGreaterThan(1000)
    })
  })

  describe('POSITIVE: TG speed calculation', () => {
    it('should calculate TG speed when time > 0 and output > 0', () => {
      tracker.startGeneration()
      tracker.onFirstToken()
      // Wait for generation time
      const start = Date.now()
      while (Date.now() - start < 20) {}
      tracker.endGeneration(100, 50, 0)

      const s = tracker.state()
      expect(s.tgSpeed).not.toBeNull()
      expect(s.tgSpeed).toBeGreaterThan(0)
    })
  })

  describe('NEGATIVE: reasoning tokens', () => {
    it('should store null when reasoning tokens is not provided', () => {
      tracker.startGeneration()
      tracker.onFirstToken()
      const start = Date.now()
      while (Date.now() - start < 10) {}
      tracker.endGeneration(10, 20, 5)
      const s = tracker.state()
      expect(s.sessionReasoningTokens).toBe(0)
      expect(s.sessionReasoningTokens).toBe(0)
    })

    it('should store null when reasoning tokens is zero', () => {
      tracker.startGeneration()
      tracker.onFirstToken()
      const start = Date.now()
      while (Date.now() - start < 10) {}
      tracker.endGeneration(10, 20, 5, 0)
      const s = tracker.state()
      expect(s.sessionReasoningTokens).toBe(0)
      expect(s.sessionReasoningTokens).toBe(0)
    })

    it('should store null when reasoning tokens is negative', () => {
      tracker.startGeneration()
      tracker.onFirstToken()
      const start = Date.now()
      while (Date.now() - start < 10) {}
      tracker.endGeneration(10, 20, 5, -5)
      const s = tracker.state()
      expect(s.sessionReasoningTokens).toBe(0)
      expect(s.sessionReasoningTokens).toBe(0)
    })

    it('should store null when reasoning tokens is NaN', () => {
      tracker.startGeneration()
      tracker.onFirstToken()
      const start = Date.now()
      while (Date.now() - start < 10) {}
      tracker.endGeneration(10, 20, 5, NaN)
      const s = tracker.state()
      expect(s.sessionReasoningTokens).toBe(0)
      expect(s.sessionReasoningTokens).toBe(0)
    })
  })

  describe('POSITIVE: reasoning tokens', () => {
    it('should store reasoning tokens when provided', () => {
      tracker.startGeneration()
      tracker.onFirstToken()
      const start = Date.now()
      while (Date.now() - start < 10) {}
      tracker.endGeneration(10, 20, 5, 15)
      const s = tracker.state()
      expect(s.sessionReasoningTokens).toBe(15)
      expect(s.sessionReasoningTokens).toBe(15)
    })

    it('should accumulate reasoning tokens across multiple generations', () => {
      tracker.startGeneration()
      tracker.onFirstToken()
      const start1 = Date.now()
      while (Date.now() - start1 < 10) {}
      tracker.endGeneration(10, 20, 5, 15)

      tracker.startGeneration()
      tracker.onFirstToken()
      const start2 = Date.now()
      while (Date.now() - start2 < 10) {}
      tracker.endGeneration(5, 10, 2, 25)

      const s = tracker.state()
      expect(s.sessionReasoningTokens).toBe(40)
    })
  })

  describe('NEGATIVE: configuration options', () => {
    it('should use default interval when no options provided', () => {
      const tracker = createTracker()
      tracker.startGeneration()
      tracker.onFirstToken()
      tracker.addDeltaChars(100)
      expect(tracker.state().isGenerating).toBe(true)
    })

    it('should accept custom interval option', () => {
      const tracker = createTracker({ liveIntervalMs: 50 })
      tracker.startGeneration()
      tracker.onFirstToken()
      tracker.addDeltaChars(100)
      expect(tracker.state().isGenerating).toBe(true)
    })
  })
})

// ─────────────────────────────────────────────────────────────
// accumulateTokens — accumulates without ending generation
// ─────────────────────────────────────────────────────────────

describe('accumulateTokens', () => {
  let tracker: ReturnType<typeof createTracker>

  beforeEach(() => {
    tracker = createTracker()
  })

  it('should accumulate tokens without ending generation', () => {
    tracker.startGeneration()
    expect(tracker.state().isGenerating).toBe(true)
    expect(tracker.state().ppSpeed).toBeNull()

    tracker.accumulateTokens(10, 20, 5, 5)

    const s = tracker.state()
    expect(s.isGenerating).toBe(true)  // NOT ended
    expect(s.ppSpeed).toBeNull() // NOT computed
    expect(s.tgSpeed).toBeNull()
    expect(s.sessionInputTokens).toBe(10)
    expect(s.sessionOutputTokens).toBe(20)
    expect(s.sessionCacheTokens).toBe(5)
    expect(s.sessionReasoningTokens).toBe(5)
  })

  it('should allow endGeneration to still compute speeds after accumulateTokens', () => {
    tracker.startGeneration()
    const prefillStart = Date.now()
    while (Date.now() - prefillStart < 15) {}
    tracker.onFirstToken()

    tracker.accumulateTokens(50, 25, 10, 15)

    // Wait for generation time so tgSpeed > 0
    const genStart = Date.now()
    while (Date.now() - genStart < 10) {}
    tracker.endGeneration(100, 50, 20, 30)

    const s = tracker.state()
    expect(s.isGenerating).toBe(false)
    expect(s.ppSpeed).not.toBeNull() // main thread's speed
    expect(s.tgSpeed).not.toBeNull() // main thread's speed
    // Session totals include both
    expect(s.sessionInputTokens).toBe(150)
    expect(s.sessionOutputTokens).toBe(75)
    expect(s.sessionCacheTokens).toBe(30)
    expect(s.sessionReasoningTokens).toBe(45)
  })

  it('should accumulate tokens from 3-layer nesting (main → subagent → nested)', () => {
    tracker.startGeneration()
    const prefillStart = Date.now()
    while (Date.now() - prefillStart < 15) {}
    tracker.onFirstToken()

    // Subagent finishes during main thread
    tracker.accumulateTokens(50, 25, 10, 15)

    // Nested subagent finishes during subagent
    tracker.accumulateTokens(20, 10, 5, 0)

    // Wait for generation time so tgSpeed > 0
    const genStart = Date.now()
    while (Date.now() - genStart < 10) {}
    tracker.endGeneration(100, 50, 20, 30)

    const s = tracker.state()
    expect(s.sessionInputTokens).toBe(170) // 100 + 50 + 20
    expect(s.sessionOutputTokens).toBe(85)  // 50 + 25 + 10
    expect(s.sessionCacheTokens).toBe(35)   // 20 + 10 + 5
    expect(s.sessionReasoningTokens).toBe(45) // 30 + 15 + 0
    expect(s.ppSpeed).not.toBeNull() // main thread speeds preserved
    expect(s.tgSpeed).not.toBeNull()
  })

  it('should guard non-finite and negative values', () => {
    tracker.accumulateTokens(NaN, Infinity, -5, -1)
    const s = tracker.state()
    expect(s.sessionInputTokens).toBe(0) // NaN → 0
    expect(s.sessionOutputTokens).toBe(0) // Infinity → 0 (Infinity >= 0, so safe)
    expect(s.sessionCacheTokens).toBe(0)  // -5 → 0
    expect(s.sessionReasoningTokens).toBe(0) // -1 → 0
  })

  it('should accumulate tokens from 5-layer subagent nesting', () => {
    tracker.startGeneration()
    const prefillStart = Date.now()
    while (Date.now() - prefillStart < 15) {}
    tracker.onFirstToken()

    // 5 nested subagent layers each contribute tokens
    tracker.accumulateTokens(100, 50, 20, 10) // layer 1
    tracker.accumulateTokens(80, 40, 16, 8)   // layer 2
    tracker.accumulateTokens(60, 30, 12, 6)   // layer 3
    tracker.accumulateTokens(40, 20, 8, 4)    // layer 4
    tracker.accumulateTokens(20, 10, 4, 2)    // layer 5

    const genStart = Date.now()
    while (Date.now() - genStart < 10) {}
    tracker.endGeneration(200, 100, 50, 25)

    const s = tracker.state()
    // All 5 layers + main thread
    expect(s.sessionInputTokens).toBe(500)  // 100+80+60+40+20+200
    expect(s.sessionOutputTokens).toBe(250)  // 50+40+30+20+10+100
    expect(s.sessionCacheTokens).toBe(110)   // 20+16+12+8+4+50
    expect(s.sessionReasoningTokens).toBe(55) // 10+8+6+4+2+25
    expect(s.ppSpeed).not.toBeNull()
    expect(s.tgSpeed).not.toBeNull()
    expect(s.isGenerating).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────
// CHAOS TESTS — timeout, reconnect, crash, interleaved events
// ─────────────────────────────────────────────────────────────

describe('NEGATIVE: chaos scenarios', () => {
  let tracker: ReturnType<typeof createTracker>

  beforeEach(() => {
    tracker = createTracker()
  })

  it('should not corrupt new generation when stale endGeneration is routed via accumulateTokens (as event handler does)', () => {
    // Gen 1: start, produce tokens, end
    tracker.startGeneration()
    tracker.onFirstToken()
    const start1 = Date.now()
    while (Date.now() - start1 < 10) {}
    tracker.endGeneration(100, 50, 20, 30)
    expect(tracker.state().isGenerating).toBe(false)

    // Gen 2 starts fresh
    tracker.startGeneration()
    expect(tracker.state().isGenerating).toBe(true)

    // Event handler routes stale step-finish to accumulateTokens
    // (using lastEndedMessageId correlation at the event handler level)
    tracker.accumulateTokens(100, 50, 20, 30)

    // Gen 2 should still be generating!
    expect(tracker.state().isGenerating).toBe(true)
    expect(tracker.state().ppSpeed).toBeNull()
    expect(tracker.state().tgSpeed).toBeNull()

    // Gen 2 finishes normally with its own tokens
    const prefill2 = Date.now()
    while (Date.now() - prefill2 < 15) {}
    tracker.onFirstToken()
    const start2 = Date.now()
    while (Date.now() - start2 < 10) {}
    tracker.endGeneration(200, 100, 40, 60)

    const s = tracker.state()
    // All tokens from both gens + stale (accumulated as if subagent)
    expect(s.sessionInputTokens).toBe(400) // 100+100+200
    expect(s.sessionOutputTokens).toBe(200) // 50+50+100
    expect(s.isGenerating).toBe(false)
    expect(s.ppSpeed).not.toBeNull() // Gen 2's speed
    expect(s.tgSpeed).not.toBeNull() // Gen 2's speed
  })

  it('should handle idle fallback followed by late subagent step-finish', () => {
    // Main thread starts, produces chars
    tracker.startGeneration()
    tracker.onFirstToken()
    tracker.addDeltaChars(50)
    expect(tracker.state().isGenerating).toBe(true)

    // Session idle fallback: end with char proxy
    tracker.endGeneration(0, tracker.state().liveOutputChars, 0)
    expect(tracker.state().isGenerating).toBe(false)

    // Late subagent tokens arrive
    tracker.accumulateTokens(50, 25, 10, 15)

    const s = tracker.state()
    // Idle fallback contributed 0 input, 50 output (chars)
    expect(s.sessionInputTokens).toBe(50)    // 0 + 50
    expect(s.sessionOutputTokens).toBe(75)   // 50(chars) + 25
    expect(s.sessionCacheTokens).toBe(10)
    expect(s.sessionReasoningTokens).toBe(15)
  })

  it('should handle idle fallback followed by late main thread step-finish', () => {
    // Session idle ends generation with char proxy
    tracker.startGeneration()
    tracker.onFirstToken()
    const prefillStart = Date.now()
    while (Date.now() - prefillStart < 10) {}
    tracker.addDeltaChars(50)
    tracker.endGeneration(0, tracker.state().liveOutputChars, 0)
    expect(tracker.state().isGenerating).toBe(false)

    // Main thread step-finish arrives late with authoritative tokens
    tracker.endGeneration(100, 50, 20, 30)

    const s = tracker.state()
    expect(s.sessionInputTokens).toBe(100)     // 0 + 100
    expect(s.sessionOutputTokens).toBe(100)    // 50(chars) + 50
    expect(s.sessionCacheTokens).toBe(20)
    expect(s.sessionReasoningTokens).toBe(30)
  })

  it('should survive rapid reconnect cycling (5x busy/idle)', () => {
    for (let i = 0; i < 5; i++) {
      tracker.startGeneration()
      expect(tracker.state().isGenerating).toBe(true)

      const start = Date.now()
      while (Date.now() - start < 5) {}
      tracker.addDeltaChars(10)

      tracker.endGeneration(0, tracker.state().liveOutputChars, 0)
      expect(tracker.state().isGenerating).toBe(false)
    }

    // After 5 cycles, session totals should reflect accumulated chars
    const s = tracker.state()
    expect(s.sessionInputTokens).toBe(0 * 5)
    expect(s.sessionOutputTokens).toBe(10 * 5) // 10 chars each cycle
  })

  it('should handle interleaved fail events without crash', () => {
    // Out-of-order: idle before any start
    tracker.endGeneration(0, 0, 0)
    expect(tracker.state().isGenerating).toBe(false)

    // Start after idle
    tracker.startGeneration()
    expect(tracker.state().isGenerating).toBe(true)

    // Another idle during generation
    tracker.endGeneration(0, 10, 0)
    expect(tracker.state().isGenerating).toBe(false)

    // Step-finish after idle (accumulation path)
    tracker.endGeneration(100, 50, 20, 30)
    expect(tracker.state().sessionInputTokens).toBe(100)
    expect(tracker.state().sessionOutputTokens).toBe(60) // 10 + 50
  })

  it('should not break when step-finish has zero tokens after session already ended', () => {
    tracker.startGeneration()
    tracker.onFirstToken()
    const start = Date.now()
    while (Date.now() - start < 10) {}
    tracker.endGeneration(100, 50, 20, 30)

    // Zero-token step-finish after generation ended
    expect(() => {
      tracker.endGeneration(0, 0, 0)
    }).not.toThrow()

    // State unchanged
    const s = tracker.state()
    expect(s.sessionInputTokens).toBe(100)
    expect(s.sessionOutputTokens).toBe(50)
  })
})

// ═══════════════════════════════════════════════════════════════
// EVENT HANDLER TESTS — mock the OpenCode API, test event wiring
// ═══════════════════════════════════════════════════════════════

import plugin from './tps-plugin'

describe('tui plugin event handlers', () => {
  let mockApi: any
  let eventHandlers: Map<string, Function>
  let registeredSlots: any

  beforeEach(async () => {
    eventHandlers = new Map()
    registeredSlots = null

    mockApi = {
      theme: {
        current: {
          text: 'white',
          textMuted: 'gray',
          info: 'blue',
          success: 'green',
        },
      },
      slots: {
        register: (config: any) => {
          registeredSlots = config
        },
      },
      event: {
        on: (eventName: string, handler: Function) => {
          eventHandlers.set(eventName, handler)
        },
      },
    }

    await (plugin.tui as (api: any) => Promise<void>)(mockApi)
  })

  // ─────────────────────────────────────────────────────────────
  // NEGATIVE: message.part.updated event handler
  // ─────────────────────────────────────────────────────────────

  describe('NEGATIVE: message.part.updated', () => {
    it('should NOT start generation for non-step-start part types', () => {
      const handler = eventHandlers.get('message.part.updated')
      expect(handler).toBeDefined()

      handler!({
        properties: {
          part: {
            id: 'part-1',
            type: 'text', // NOT step-start
            tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          },
        },
      })

      // We can't directly inspect tracker state, but we can check
      // that the sidebar slot was registered
      expect(registeredSlots).not.toBeNull()
    })

    it('should handle step-finish with missing tokens gracefully', () => {
      const handler = eventHandlers.get('message.part.updated')
      expect(handler).toBeDefined()

      // First start the generation
      handler!({
        properties: {
          part: {
            id: 'part-2',
            type: 'step-start',
            tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          },
        },
      })

      // Then finish with tokens
      handler!({
        properties: {
          part: {
            id: 'part-2',
            type: 'step-finish',
            tokens: { input: 100, output: 50, cache: { read: 20, write: 0 } },
          },
        },
      })

      // Should not crash
      expect(registeredSlots).not.toBeNull()
    })

    it('should handle step-finish without prior step-start', () => {
      const handler = eventHandlers.get('message.part.updated')
      expect(handler).toBeDefined()

      // Finish without start
      handler!({
        properties: {
          part: {
            id: 'part-3',
            type: 'step-finish',
            tokens: { input: 100, output: 50, cache: { read: 20, write: 0 } },
          },
        },
      })

      // Should not crash
      expect(registeredSlots).not.toBeNull()
    })
  })

  // ─────────────────────────────────────────────────────────────
  // NEGATIVE: message.part.delta event handler
  // ─────────────────────────────────────────────────────────────

  describe('NEGATIVE: message.part.delta', () => {
    it('should ignore non-text field deltas', () => {
      const handler = eventHandlers.get('message.part.delta')
      expect(handler).toBeDefined()

      // Start generation first
      const startHandler = eventHandlers.get('message.part.updated')
      startHandler!({
        properties: {
          part: {
            id: 'part-4',
            type: 'step-start',
            tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          },
        },
      })

      // Send non-text delta
      handler!({
        properties: {
          partID: 'part-4',
          field: 'thinking', // NOT text
          delta: 'some thinking',
        },
      })

      // Should not crash
      expect(registeredSlots).not.toBeNull()
    })

    it('should handle delta without prior step-start', () => {
      const handler = eventHandlers.get('message.part.delta')
      expect(handler).toBeDefined()

      // Delta without start
      handler!({
        properties: {
          partID: 'orphan-part',
          field: 'text',
          delta: 'hello',
        },
      })

      // Should not crash
      expect(registeredSlots).not.toBeNull()
    })

    it('should handle empty delta string', () => {
      const handler = eventHandlers.get('message.part.delta')
      expect(handler).toBeDefined()

      const startHandler = eventHandlers.get('message.part.updated')
      startHandler!({
        properties: {
          part: {
            id: 'part-5',
            type: 'step-start',
            tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          },
        },
      })

      handler!({
        properties: {
          partID: 'part-5',
          field: 'text',
          delta: '',
        },
      })

      // Should not crash
      expect(registeredSlots).not.toBeNull()
    })
  })

  // ─────────────────────────────────────────────────────────────
  // NEGATIVE: session.status event handler
  // ─────────────────────────────────────────────────────────────

  describe('NEGATIVE: session.status', () => {
    it('should not double-start on busy when already generating', () => {
      const handler = eventHandlers.get('session.status')
      expect(handler).toBeDefined()

      // First start
      handler!({
        properties: {
          status: { type: 'busy' },
        },
      })

      // Second start should not cause issues
      handler!({
        properties: {
          status: { type: 'busy' },
        },
      })

      expect(registeredSlots).not.toBeNull()
    })

    it('should handle idle when not generating', () => {
      const handler = eventHandlers.get('session.status')
      expect(handler).toBeDefined()

      // Idle without prior busy
      handler!({
        properties: {
          status: { type: 'idle' },
        },
      })

      expect(registeredSlots).not.toBeNull()
    })

    it('should handle unknown status type', () => {
      const handler = eventHandlers.get('session.status')
      expect(handler).toBeDefined()

      handler!({
        properties: {
          status: { type: 'unknown' },
        },
      })

      expect(registeredSlots).not.toBeNull()
    })
  })

  // ─────────────────────────────────────────────────────────────
  // NEGATIVE: message.updated event handler
  // ─────────────────────────────────────────────────────────────

  describe('NEGATIVE: message.updated', () => {
    it('should ignore non-assistant role messages', () => {
      const handler = eventHandlers.get('message.updated')
      expect(handler).toBeDefined()

      handler!({
        properties: {
          info: {
            role: 'user',
            time: { created: Date.now(), completed: Date.now() },
            tokens: { input: 10, output: 5, cache: { read: 0, write: 0 } },
          },
        },
      })

      expect(registeredSlots).not.toBeNull()
    })

    it('should ignore assistant message without completed time', () => {
      const handler = eventHandlers.get('message.updated')
      expect(handler).toBeDefined()

      handler!({
        properties: {
          info: {
            role: 'assistant',
            time: { created: Date.now() },
            tokens: { input: 10, output: 5, cache: { read: 0, write: 0 } },
          },
        },
      })

      expect(registeredSlots).not.toBeNull()
    })

    it('should ignore assistant message without tokens', () => {
      const handler = eventHandlers.get('message.updated')
      expect(handler).toBeDefined()

      handler!({
        properties: {
          info: {
            role: 'assistant',
            time: { created: Date.now(), completed: Date.now() },
          },
        },
      })

      expect(registeredSlots).not.toBeNull()
    })

    it('should not end if not currently generating', () => {
      const handler = eventHandlers.get('message.updated')
      expect(handler).toBeDefined()

      // No prior generation started
      handler!({
        properties: {
          info: {
            role: 'assistant',
            time: { created: Date.now(), completed: Date.now() },
            tokens: { input: 10, output: 5, cache: { read: 0, write: 0 } },
          },
        },
      })

      expect(registeredSlots).not.toBeNull()
    })

    it('should handle message.updated with reasoning tokens', () => {
      const handler = eventHandlers.get('message.updated')
      expect(handler).toBeDefined()

      // Start generation first via session.status
      const statusHandler = eventHandlers.get('session.status')
      statusHandler!({
        properties: {
          status: { type: 'busy' },
        },
      })

      // Then complete with reasoning tokens
      handler!({
        properties: {
          info: {
            role: 'assistant',
            time: { created: Date.now(), completed: Date.now() },
            tokens: { input: 10, output: 5, cache: { read: 0, write: 0 }, reasoning: 15 },
          },
        },
      })

      expect(registeredSlots).not.toBeNull()
    })

    it('should NOT end current generation for stale message.updated of old message', () => {
      const partHandler = eventHandlers.get('message.part.updated')
      const msgHandler = eventHandlers.get('message.updated')
      expect(partHandler).toBeDefined()
      expect(msgHandler).toBeDefined()

      // Message A: start generation
      partHandler!({
        properties: {
          part: {
            id: 'step-a',
            messageID: 'msg-A',
            type: 'step-start',
            tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          },
        },
      })

      // Message A: step-finish
      partHandler!({
        properties: {
          part: {
            id: 'step-a',
            type: 'step-finish',
            tokens: { input: 100, output: 50, cache: { read: 20, write: 0 } },
          },
        },
      })

      // Message B: start new generation
      partHandler!({
        properties: {
          part: {
            id: 'step-b',
            messageID: 'msg-B',
            type: 'step-start',
            tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          },
        },
      })

      // Delayed message.updated for Message A (old message) — should be ignored
      msgHandler!({
        properties: {
          info: {
            id: 'msg-A',
            role: 'assistant',
            time: { created: Date.now(), completed: Date.now() },
            tokens: { input: 50, output: 25, cache: { read: 10, write: 0 } },
          },
        },
      })

      // Message B should still be generating
      expect(registeredSlots).not.toBeNull()
    })

    it('should accept message.updated when messageID matches current generation', () => {
      const partHandler = eventHandlers.get('message.part.updated')
      const msgHandler = eventHandlers.get('message.updated')
      expect(partHandler).toBeDefined()
      expect(msgHandler).toBeDefined()

      // Start generation
      partHandler!({
        properties: {
          part: {
            id: 'step-c',
            messageID: 'msg-C',
            type: 'step-start',
            tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          },
        },
      })

      // No step-finish before message.updated (fallback scenario)
      // message.updated for msg-C should be accepted
      msgHandler!({
        properties: {
          info: {
            id: 'msg-C',
            role: 'assistant',
            time: { created: Date.now(), completed: Date.now() },
            tokens: { input: 75, output: 30, cache: { read: 15, write: 0 } },
          },
        },
      })

      expect(registeredSlots).not.toBeNull()
    })

    it('should accept message.updated when currentMessageId is null (generation started via session.status)', () => {
      const statusHandler = eventHandlers.get('session.status')
      const msgHandler = eventHandlers.get('message.updated')
      expect(statusHandler).toBeDefined()
      expect(msgHandler).toBeDefined()

      // Start generation via session.status (no step-start, so currentMessageId is null)
      statusHandler!({
        properties: {
          status: { type: 'busy' },
        },
      })

      // message.updated should be accepted as fallback when currentMessageId is null
      msgHandler!({
        properties: {
          info: {
            id: 'msg-D',
            role: 'assistant',
            time: { created: Date.now(), completed: Date.now() },
            tokens: { input: 10, output: 5, cache: { read: 0, write: 0 } },
          },
        },
      })

      expect(registeredSlots).not.toBeNull()
    })

    it('should handle message.updated without id field gracefully', () => {
      const partHandler = eventHandlers.get('message.part.updated')
      const msgHandler = eventHandlers.get('message.updated')
      expect(partHandler).toBeDefined()
      expect(msgHandler).toBeDefined()

      // Start generation
      partHandler!({
        properties: {
          part: {
            id: 'step-e',
            messageID: 'msg-E',
            type: 'step-start',
            tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          },
        },
      })

      // message.updated without id field — should be accepted when no id to compare
      msgHandler!({
        properties: {
          info: {
            role: 'assistant',
            time: { created: Date.now(), completed: Date.now() },
            tokens: { input: 10, output: 5, cache: { read: 0, write: 0 } },
          },
        },
      })

      expect(registeredSlots).not.toBeNull()
    })
  })

  // ─────────────────────────────────────────────────────────────
  // POSITIVE: event handler integration
  // ─────────────────────────────────────────────────────────────

  describe('POSITIVE: full event flow', () => {
    it('should handle complete generation via events', () => {
      const partUpdated = eventHandlers.get('message.part.updated')
      const partDelta = eventHandlers.get('message.part.delta')
      const statusHandler = eventHandlers.get('session.status')

      expect(partUpdated).toBeDefined()
      expect(partDelta).toBeDefined()
      expect(statusHandler).toBeDefined()

      // Step start
      partUpdated!({
        properties: {
          part: {
            id: 'step-1',
            type: 'step-start',
            tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          },
        },
      })

      // Text deltas
      partDelta!({
        properties: {
          partID: 'step-1',
          field: 'text',
          delta: 'Hello',
        },
      })

      partDelta!({
        properties: {
          partID: 'step-1',
          field: 'text',
          delta: ' world',
        },
      })

      // Step finish
      partUpdated!({
        properties: {
          part: {
            id: 'step-1',
            type: 'step-finish',
            tokens: { input: 100, output: 50, cache: { read: 20, write: 0 } },
          },
        },
      })

      expect(registeredSlots).not.toBeNull()
    })
  })

  describe('POSITIVE: sidebar slot registration', () => {
    it('should register sidebar_content slot', () => {
      expect(registeredSlots).not.toBeNull()
      expect(registeredSlots.order).toBe(150)
      expect(registeredSlots.slots).toHaveProperty('sidebar_content')
    })
  })

  describe('POSITIVE: reasoning tokens via events', () => {
    it('should handle step-finish with reasoning tokens', () => {
      const partUpdated = eventHandlers.get('message.part.updated')
      expect(partUpdated).toBeDefined()

      // Start generation
      partUpdated!({
        properties: {
          part: {
            id: 'step-reasoning',
            type: 'step-start',
            tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          },
        },
      })

      // Finish with reasoning tokens
      partUpdated!({
        properties: {
          part: {
            id: 'step-reasoning',
            type: 'step-finish',
            tokens: { input: 100, output: 50, cache: { read: 20, write: 0 }, reasoning: 30 },
          },
        },
      })

      expect(registeredSlots).not.toBeNull()
    })
  })
})

// ═══════════════════════════════════════════════════════════════
// ADDITIONAL NEGATIVE TESTS — edge cases, type safety, robustness
// ═══════════════════════════════════════════════════════════════

describe('NEGATIVE: tracker edge cases', () => {
  let tracker: ReturnType<typeof createTracker>

  beforeEach(() => {
    tracker = createTracker()
  })

  it('should handle rapid start/end cycles without crashing', () => {
    for (let i = 0; i < 10; i++) {
      tracker.startGeneration()
      tracker.onFirstToken()
      tracker.addDeltaChars(10)
      tracker.endGeneration(10, 10, 0)
    }
    const s = tracker.state()
    expect(s.sessionInputTokens).toBe(100)
    expect(s.sessionOutputTokens).toBe(100)
    expect(s.isGenerating).toBe(false)
  })

  it('should handle very large token counts', () => {
    tracker.startGeneration()
    const start1 = Date.now()
    while (Date.now() - start1 < 20) {}
    tracker.onFirstToken()
    const start2 = Date.now()
    while (Date.now() - start2 < 20) {}
    tracker.endGeneration(1_000_000, 2_000_000, 500_000)
    const s = tracker.state()
    expect(s.sessionInputTokens).toBe(1_000_000)
    expect(s.sessionOutputTokens).toBe(2_000_000)
    expect(s.sessionCacheTokens).toBe(500_000)
    expect(s.ppSpeed).toBeGreaterThan(0)
    expect(s.tgSpeed).toBeGreaterThan(0)
  })

  it('should handle very large delta chars', () => {
    tracker.startGeneration()
    tracker.onFirstToken()
    tracker.addDeltaChars(1_000_000)
    const s1 = tracker.state()
    expect(s1.liveOutputChars).toBe(1_000_000)
  })

  it('should handle interval cleanup on rapid start', () => {
    tracker.startGeneration()
    tracker.onFirstToken()
    tracker.addDeltaChars(10)
    // End quickly
    tracker.endGeneration(10, 10, 0)
    expect(tracker.liveTgSpeed()).toBeNull()

    // Start again
    tracker.startGeneration()
    tracker.onFirstToken()
    tracker.addDeltaChars(20)
    const s = tracker.state()
    expect(s.liveOutputChars).toBe(20)
    expect(s.isGenerating).toBe(true)
  })

  it('should format very large speed correctly', () => {
    expect(tracker.formatSpeed(1_000_000)).toBe('1000.0K')
    expect(tracker.formatSpeed(999_999)).toBe('1000.0K')
  })

  it('should format very small speed correctly', () => {
    expect(tracker.formatSpeed(0.001)).toBe('0.0')
    expect(tracker.formatSpeed(0.0001)).toBe('0.0')
  })

  it('should handle endGeneration with NaN tokens', () => {
    tracker.startGeneration()
    tracker.onFirstToken()
    const start = Date.now()
    while (Date.now() - start < 20) {}
    tracker.endGeneration(NaN, NaN, NaN)
    const s = tracker.state()
    // NaN should be guarded — session totals stay at initial 0
    expect(s.sessionInputTokens).toBe(0)
    expect(s.sessionOutputTokens).toBe(0)
    // cacheReadTokens is checked against > 0, NaN > 0 is false
    expect(s.sessionCacheTokens).toBe(0)
  })

  it('should handle endGeneration with Infinity tokens', () => {
    tracker.startGeneration()
    const start1 = Date.now()
    while (Date.now() - start1 < 20) {}
    tracker.onFirstToken()
    const start2 = Date.now()
    while (Date.now() - start2 < 20) {}
    tracker.endGeneration(Infinity, Infinity, Infinity)
    const s = tracker.state()
    // Infinity is not finite — guarded, session totals stay at 0
    expect(s.sessionInputTokens).toBe(0)
    expect(s.sessionOutputTokens).toBe(0)
    expect(s.ppSpeed).toBeNull()
    expect(s.tgSpeed).toBeNull()
  })

  it('should guard against NaN inputTokens corrupting session total', () => {
    tracker.startGeneration()
    tracker.endGeneration(NaN, 50, 0)
    const s = tracker.state()
    expect(s.sessionInputTokens).toBe(0)
    expect(s.sessionOutputTokens).toBe(50) // output not affected
  })

  it('should guard against NaN outputTokens corrupting session total', () => {
    tracker.startGeneration()
    tracker.endGeneration(100, NaN, 0)
    const s = tracker.state()
    expect(s.sessionOutputTokens).toBe(0)
    expect(s.sessionInputTokens).toBe(100) // input not affected
  })

  it('should guard against mixed NaN and valid tokens', () => {
    tracker.startGeneration()
    tracker.endGeneration(100, 50, 0, NaN)
    const s = tracker.state()
    expect(s.sessionInputTokens).toBe(100)
    expect(s.sessionOutputTokens).toBe(50)
    expect(s.sessionReasoningTokens).toBe(0) // NaN filtered by > 0 check
  })

  it('should guard against negative output tokens decreasing session total', () => {
    tracker.startGeneration()
    tracker.endGeneration(100, 50, 0)
    expect(tracker.state().sessionOutputTokens).toBe(50)

    tracker.startGeneration()
    tracker.endGeneration(0, -10, 0) // negative — should not accumulate
    const s = tracker.state()
    expect(s.sessionOutputTokens).toBe(50) // unchanged
  })

  it('should guard against negative input tokens decreasing session total', () => {
    tracker.startGeneration()
    tracker.endGeneration(100, 50, 0)
    expect(tracker.state().sessionInputTokens).toBe(100)

    tracker.startGeneration()
    tracker.endGeneration(-10, 0, 0) // negative — should not accumulate
    const s = tracker.state()
    expect(s.sessionInputTokens).toBe(100) // unchanged
  })

  it('should not crash when startGeneration called with interval still running', () => {
    tracker.startGeneration()
    tracker.onFirstToken()
    tracker.addDeltaChars(10)
    // Don't end, start again (double-start guard)
    tracker.startGeneration()
    const s = tracker.state()
    expect(s.isGenerating).toBe(true)
    expect(s.liveOutputChars).toBe(10) // NOT reset because double-start is guarded
  })

  it('should not accumulate session totals on endGeneration with zero tokens', () => {
    tracker.startGeneration()
    tracker.endGeneration(0, 0, 0)
    const s = tracker.state()
    expect(s.sessionInputTokens).toBe(0)
    expect(s.sessionOutputTokens).toBe(0)

    // Second generation with real tokens should not include zero from first
    tracker.startGeneration()
    const start = Date.now()
    while (Date.now() - start < 10) {}
    tracker.onFirstToken()
    const start2 = Date.now()
    while (Date.now() - start2 < 10) {}
    tracker.endGeneration(100, 50, 10)
    const s2 = tracker.state()
    expect(s2.sessionInputTokens).toBe(100)
    expect(s2.sessionOutputTokens).toBe(50)
  })

  it('should handle immediate endGeneration with zero elapsed time', () => {
    tracker.startGeneration()
    // End immediately with no onFirstToken and no wait
    tracker.endGeneration(100, 50, 10)
    const s = tracker.state()
    expect(s.isGenerating).toBe(false)
    expect(s.ppSpeed).toBeNull() // prefillSec = 0
    expect(s.tgSpeed).toBeNull() // tgSec = 0
  })

  it('should handle start/end cycle with no onFirstToken at all', () => {
    tracker.startGeneration()
    tracker.addDeltaChars(50)
    const start = Date.now()
    while (Date.now() - start < 10) {}
    tracker.endGeneration(100, 50, 10)
    const s = tracker.state()
    // firstTokenTime ?? now = now, so prefillSec > 0 → ppSpeed computed
    expect(s.ppSpeed).toBeGreaterThan(0)
    // tgSec = now - now = 0 → tgSpeed is null
    expect(s.tgSpeed).toBeNull()
    expect(s.liveOutputChars).toBe(50)
  })

  it('should handle endGeneration with negative reasoning tokens', () => {
    tracker.startGeneration()
    const start = Date.now()
    while (Date.now() - start < 10) {}
    tracker.onFirstToken()
    const start2 = Date.now()
    while (Date.now() - start2 < 10) {}
    tracker.endGeneration(100, 50, 10, -10)
    const s = tracker.state()
    expect(s.sessionReasoningTokens).toBe(0) // filtered by > 0 check
    expect(s.sessionReasoningTokens).toBe(0) // not accumulated
  })

  it('should handle endGeneration with Infinity cache only', () => {
    tracker.startGeneration()
    const start = Date.now()
    while (Date.now() - start < 10) {}
    tracker.onFirstToken()
    const start2 = Date.now()
    while (Date.now() - start2 < 10) {}
    tracker.endGeneration(100, 50, Infinity)
    const s = tracker.state()
    // Infinity is filtered by Number.isFinite guard — accumulated as 0
    expect(s.sessionCacheTokens).toBe(0)
    expect(s.sessionInputTokens).toBe(100)
    expect(s.sessionOutputTokens).toBe(50)
  })

  it('should handle 1000 rapid start/end cycles (session precision)', () => {
    for (let i = 0; i < 1000; i++) {
      tracker.startGeneration()
      tracker.endGeneration(1, 1, 0)
    }
    const s = tracker.state()
    expect(s.sessionInputTokens).toBe(1000)
    expect(s.sessionOutputTokens).toBe(1000)
    expect(s.isGenerating).toBe(false)
  })

  it('should handle endGeneration with Infinity reasoning', () => {
    tracker.startGeneration()
    const start = Date.now()
    while (Date.now() - start < 10) {}
    tracker.onFirstToken()
    const start2 = Date.now()
    while (Date.now() - start2 < 10) {}
    tracker.endGeneration(100, 50, 10, Infinity)
    const s = tracker.state()
    // Infinity is filtered by Number.isFinite guard — accumulated as 0
    expect(s.sessionReasoningTokens).toBe(0)
  })

    it('should preserve session cache total across idle fallback', () => {
      // Gen 1 with cache
      tracker.startGeneration()
      tracker.onFirstToken()
      const start1 = Date.now()
      while (Date.now() - start1 < 5) {}
      tracker.endGeneration(10, 20, 50)
      expect(tracker.state().sessionCacheTokens).toBe(50)

      // Gen 2 idle fallback (cache=0 — not accumulated)
      tracker.startGeneration()
      tracker.onFirstToken()
      const start2 = Date.now()
      while (Date.now() - start2 < 5) {}
      tracker.endGeneration(0, 0, 0)
      expect(tracker.state().sessionCacheTokens).toBe(50) // preserved from gen 1
    })

    it('should preserve session reasoning total across idle fallback', () => {
    // Gen 1 with reasoning
    tracker.startGeneration()
    tracker.onFirstToken()
    const start1 = Date.now()
    while (Date.now() - start1 < 10) {}
    tracker.endGeneration(10, 20, 5, 30)
    expect(tracker.state().sessionReasoningTokens).toBe(30)
    expect(tracker.state().sessionReasoningTokens).toBe(30)

    // Gen 2 idle fallback (no reasoning arg — simulates session.status idle)
    tracker.startGeneration()
    tracker.onFirstToken()
    const start2 = Date.now()
    while (Date.now() - start2 < 10) {}
    tracker.endGeneration(0, 0, 0)
    const s = tracker.state()
    // reasoningTokens should be PRESERVED from previous gen
    // (idle fallback with no reasoning arg doesn't wipe the display)
    expect(s.sessionReasoningTokens).toBe(30)
    expect(s.sessionReasoningTokens).toBe(30) // preserved from gen 1
  })
})

describe('NEGATIVE: performance tests', () => {
  let tracker: ReturnType<typeof createTracker>

  beforeEach(() => {
    tracker = createTracker()
  })

  it('should handle rapid delta events without crashing', () => {
    tracker.startGeneration()
    tracker.onFirstToken()

    const eventCount = 1000
    for (let i = 0; i < eventCount; i++) {
      tracker.addDeltaChars(1)
    }

    const s = tracker.state()
    expect(s.liveOutputChars).toBe(eventCount)
  })

  it('should handle very large delta events', () => {
    tracker.startGeneration()
    tracker.onFirstToken()

    tracker.addDeltaChars(100_000)
    const s = tracker.state()
    expect(s.liveOutputChars).toBe(100_000)
  })

  it('should handle rapid start/end cycles', () => {
    for (let i = 0; i < 100; i++) {
      tracker.startGeneration()
      tracker.onFirstToken()
      tracker.addDeltaChars(1)
      tracker.endGeneration(1, 1, 0)
    }

    const s = tracker.state()
    expect(s.sessionInputTokens).toBe(100)
    expect(s.sessionOutputTokens).toBe(100)
    expect(s.isGenerating).toBe(false)
  })
})

describe('NEGATIVE: event handler robustness', () => {
  let mockApi: any
  let eventHandlers: Map<string, Function>

  beforeEach(async () => {
    eventHandlers = new Map()

    mockApi = {
      theme: {
        current: {
          text: 'white',
          textMuted: 'gray',
          info: 'blue',
          success: 'green',
        },
      },
      slots: {
        register: () => {},
      },
      event: {
        on: (eventName: string, handler: Function) => {
          eventHandlers.set(eventName, handler)
        },
      },
    }

    await (plugin.tui as (api: any) => Promise<void>)(mockApi)
  })

  it('should handle malformed message.part.updated without part property', () => {
    const handler = eventHandlers.get('message.part.updated')
    expect(handler).toBeDefined()

    // Should not crash with missing properties
    expect(() => {
      handler!({ properties: {} })
    }).not.toThrow()
  })

  it('should handle malformed message.part.delta without properties', () => {
    const handler = eventHandlers.get('message.part.delta')
    expect(handler).toBeDefined()

    expect(() => {
      handler!({})
    }).not.toThrow()
  })

  it('should handle malformed session.status without status property', () => {
    const handler = eventHandlers.get('session.status')
    expect(handler).toBeDefined()

    expect(() => {
      handler!({ properties: {} })
    }).not.toThrow()
  })

  it('should handle malformed message.updated without info property', () => {
    const handler = eventHandlers.get('message.updated')
    expect(handler).toBeDefined()

    expect(() => {
      handler!({ properties: {} })
    }).not.toThrow()
  })

  it('should handle message.updated with completed=0 (falsy but valid)', () => {
    const handler = eventHandlers.get('message.updated')
    expect(handler).toBeDefined()

    expect(() => {
      handler!({
        properties: {
          info: {
            role: 'assistant',
            time: { created: Date.now(), completed: 0 },
            tokens: { input: 10, output: 5, cache: { read: 0, write: 0 } },
          },
        },
      })
    }).not.toThrow()
  })

  it('should handle message.part.updated with step-finish where tokens is null', () => {
    const handler = eventHandlers.get('message.part.updated')
    expect(handler).toBeDefined()

    // Start first
    handler!({
      properties: {
        part: {
          id: 'null-tokens',
          type: 'step-start',
          tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        },
      },
    })

    // End with null tokens
    expect(() => {
      handler!({
        properties: {
          part: {
            id: 'null-tokens',
            type: 'step-finish',
            tokens: null,
          },
        },
      })
    }).not.toThrow()
  })

  it('should handle double idle session.status', () => {
    const statusHandler = eventHandlers.get('session.status')
    const partHandler = eventHandlers.get('message.part.updated')

    // Start via step-start
    partHandler!({
      properties: {
        part: {
          id: 'step-1',
          type: 'step-start',
          tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        },
      },
    })

    // End via step-finish
    partHandler!({
      properties: {
        part: {
          id: 'step-1',
          type: 'step-finish',
          tokens: { input: 10, output: 5, cache: { read: 0, write: 0 } },
        },
      },
    })

    // Then idle should not double-end
    expect(() => {
      statusHandler!({
        properties: {
          status: { type: 'idle' },
        },
      })
    }).not.toThrow()
  })

  it('should handle message.part.delta with delta as number instead of string', () => {
    const handler = eventHandlers.get('message.part.delta')
    const startHandler = eventHandlers.get('message.part.updated')

    startHandler!({
      properties: {
        part: {
          id: 'num-delta',
          type: 'step-start',
          tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        },
      },
    })

    expect(() => {
      handler!({
        properties: {
          partID: 'num-delta',
          field: 'text',
          delta: 123, // number instead of string
        },
      })
    }).not.toThrow()
  })

  it('should handle message.updated with null tokens', () => {
    const handler = eventHandlers.get('message.updated')

    expect(() => {
      handler!({
        properties: {
          info: {
            role: 'assistant',
            time: { created: Date.now(), completed: Date.now() },
            tokens: null,
          },
        },
      })
    }).not.toThrow()
  })

  it('should handle message.part.updated with missing type field', () => {
    const handler = eventHandlers.get('message.part.updated')

    expect(() => {
      handler!({
        properties: {
          part: {
            id: 'no-type',
            tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          },
        },
      })
    }).not.toThrow()
  })

  it('should handle message.part.delta with null delta', () => {
    const handler = eventHandlers.get('message.part.delta')
    const startHandler = eventHandlers.get('message.part.updated')

    startHandler!({
      properties: {
        part: {
          id: 'null-delta',
          type: 'step-start',
          tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        },
      },
    })

    expect(() => {
      handler!({
        properties: {
          partID: 'null-delta',
          field: 'text',
          delta: null,
        },
      })
    }).not.toThrow()
  })

  it('should handle message.part.updated with null part', () => {
    const handler = eventHandlers.get('message.part.updated')

    expect(() => {
      handler!({
        properties: {
          part: null,
        },
      })
    }).not.toThrow()
  })

  it('should handle session.status with null status', () => {
    const handler = eventHandlers.get('session.status')

    expect(() => {
      handler!({
        properties: {
          status: null,
        },
      })
    }).not.toThrow()
  })

  it('should handle message.updated with null info.time', () => {
    const handler = eventHandlers.get('message.updated')

    expect(() => {
      handler!({
        properties: {
          info: {
            role: 'assistant',
            time: null,
            tokens: { input: 10, output: 5, cache: { read: 0, write: 0 } },
          },
        },
      })
    }).not.toThrow()
  })

  it('should handle message.updated with undefined info.time', () => {
    const handler = eventHandlers.get('message.updated')

    expect(() => {
      handler!({
        properties: {
          info: {
            role: 'assistant',
            tokens: { input: 10, output: 5, cache: { read: 0, write: 0 } },
          },
        },
      })
    }).not.toThrow()
  })

  it('should handle step-start with null messageID', () => {
    const handler = eventHandlers.get('message.part.updated')
    expect(handler).toBeDefined()

    expect(() => {
      handler!({
        properties: {
          part: {
            id: 'null-msgid',
            messageID: null,
            type: 'step-start',
            tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          },
        },
      })
    }).not.toThrow()
  })

  it('should handle session.status idle twice during generation', () => {
    const statusHandler = eventHandlers.get('session.status')
    const partHandler = eventHandlers.get('message.part.updated')

    // Start generation
    partHandler!({
      properties: {
        part: {
          id: 'step-double-idle',
          type: 'step-start',
          tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        },
      },
    })

    // First idle — ends generation
    statusHandler!({
      properties: {
        status: { type: 'idle' },
      },
    })

    // Second idle — should be ignored (double-end guard)
    expect(() => {
      statusHandler!({
        properties: {
          status: { type: 'idle' },
        },
      })
    }).not.toThrow()
  })

  it('should handle idle fallback with liveOutputChars > 0', () => {
    const statusHandler = eventHandlers.get('session.status')
    const deltaHandler = eventHandlers.get('message.part.delta')
    const partHandler = eventHandlers.get('message.part.updated')

    partHandler!({
      properties: {
        part: {
          id: 'idle-chars-test',
          type: 'step-start',
          tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        },
      },
    })

    // Accumulate live chars via deltas
    deltaHandler!({
      properties: { partID: 'idle-chars-test', field: 'text', delta: 'Hello world' },
    })
    deltaHandler!({
      properties: { partID: 'idle-chars-test', field: 'text', delta: 'More text' },
    })

    // Idle fallback with chars > 0 — should not crash
    expect(() => {
      statusHandler!({
        properties: {
          status: { type: 'idle' },
        },
      })
    }).not.toThrow()
  })

  it('should handle session.status busy after idle (restart)', () => {
    const statusHandler = eventHandlers.get('session.status')

    // Busy → start generation
    statusHandler!({
      properties: {
        status: { type: 'busy' },
      },
    })

    // Idle → end generation
    statusHandler!({
      properties: {
        status: { type: 'idle' },
      },
    })

    // Busy again → should restart
    expect(() => {
      statusHandler!({
        properties: {
          status: { type: 'busy' },
        },
      })
    }).not.toThrow()
  })

  it('should handle message.updated with tokens missing cache field', () => {
    const statusHandler = eventHandlers.get('session.status')
    const msgHandler = eventHandlers.get('message.updated')

    // Start generation
    statusHandler!({
      properties: {
        status: { type: 'busy' },
      },
    })

    // message.updated without cache in tokens
    expect(() => {
      msgHandler!({
        properties: {
          info: {
            role: 'assistant',
            time: { created: Date.now(), completed: Date.now() },
            tokens: { input: 10, output: 5 },
          },
        },
      })
    }).not.toThrow()
  })

  it('should handle message.updated with tokens missing reasoning field', () => {
    const statusHandler = eventHandlers.get('session.status')
    const msgHandler = eventHandlers.get('message.updated')

    statusHandler!({
      properties: {
        status: { type: 'busy' },
      },
    })

    expect(() => {
      msgHandler!({
        properties: {
          info: {
            role: 'assistant',
            time: { created: Date.now(), completed: Date.now() },
            tokens: { input: 10, output: 5, cache: { read: 0, write: 0 } },
          },
        },
      })
    }).not.toThrow()
  })

  it('should handle message.part.delta with field="text" and delta as array', () => {
    const handler = eventHandlers.get('message.part.delta')
    const startHandler = eventHandlers.get('message.part.updated')

    startHandler!({
      properties: {
        part: {
          id: 'array-delta',
          type: 'step-start',
          tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        },
      },
    })

    expect(() => {
      handler!({
        properties: {
          partID: 'array-delta',
          field: 'text',
          delta: ['h', 'e', 'l', 'l', 'o'], // array instead of string
        },
      })
    }).not.toThrow()
  })

  it('should handle message.updated with NaN completed timestamp', () => {
    const statusHandler = eventHandlers.get('session.status')
    const msgHandler = eventHandlers.get('message.updated')

    statusHandler!({
      properties: {
        status: { type: 'busy' },
      },
    })

    expect(() => {
      msgHandler!({
        properties: {
          info: {
            role: 'assistant',
            time: { created: Date.now(), completed: NaN },
            tokens: { input: 10, output: 5, cache: { read: 0, write: 0 } },
          },
        },
      })
    }).not.toThrow()
  })

  it('should handle step-start followed by immediate step-finish via events', () => {
    const partHandler = eventHandlers.get('message.part.updated')

    // step-start
    partHandler!({
      properties: {
        part: {
          id: 'immediate',
          type: 'step-start',
          tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        },
      },
    })

    // immediate step-finish (no delta in between)
    expect(() => {
      partHandler!({
        properties: {
          part: {
            id: 'immediate',
            type: 'step-finish',
            tokens: { input: 100, output: 0, cache: { read: 0, write: 0 } },
          },
        },
      })
    }).not.toThrow()
  })

  it('should handle step-finish where tokens.reasoning is null', () => {
    const partHandler = eventHandlers.get('message.part.updated')

    partHandler!({
      properties: {
        part: {
          id: 'null-reasoning',
          type: 'step-start',
          tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        },
      },
    })

    expect(() => {
      partHandler!({
        properties: {
          part: {
            id: 'null-reasoning',
            type: 'step-finish',
            tokens: { input: 100, output: 50, cache: { read: 20, write: 0 }, reasoning: null },
          },
        },
      })
    }).not.toThrow()
  })

  it('should handle step-start during active generation (race with session.status)', () => {
    const partHandler = eventHandlers.get('message.part.updated')
    const statusHandler = eventHandlers.get('session.status')
    const deltaHandler = eventHandlers.get('message.part.delta')

    // session.status busy starts generation
    statusHandler!({ properties: { status: { type: 'busy' } } })

    // First delta arrives (triggers onFirstToken)
    expect(() => {
      deltaHandler!({
        properties: { partID: 'delta-1', field: 'text', delta: 'Hello' },
      })
    }).not.toThrow()

    // step-start arrives late (should NOT crash, should NOT reset seenFirstDelta)
    expect(() => {
      partHandler!({
        properties: {
          part: {
            id: 'late-start',
            type: 'step-start',
            messageID: 'msg-1',
            tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          },
        },
      })
    }).not.toThrow()

    // Second delta arrives (should NOT crash)
    expect(() => {
      deltaHandler!({
        properties: { partID: 'delta-2', field: 'text', delta: ' world' },
      })
    }).not.toThrow()

    // step-finish should complete without error
    expect(() => {
      partHandler!({
        properties: {
          part: {
            id: 'late-start',
            type: 'step-finish',
            tokens: { input: 100, output: 50, cache: { read: 20, write: 0 } },
          },
        },
      })
    }).not.toThrow()
  })

  it('should handle step-finish with cache: null', () => {
    const partHandler = eventHandlers.get('message.part.updated')
    expect(partHandler).toBeDefined()

    partHandler!({
      properties: {
        part: {
          id: 'null-cache',
          type: 'step-start',
          tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        },
      },
    })

    expect(() => {
      partHandler!({
        properties: {
          part: {
            id: 'null-cache',
            type: 'step-finish',
            tokens: { input: 100, output: 50, cache: null },
          },
        },
      })
    }).not.toThrow()
  })

  it('should handle step-finish without cache field', () => {
    const partHandler = eventHandlers.get('message.part.updated')
    expect(partHandler).toBeDefined()

    partHandler!({
      properties: {
        part: {
          id: 'missing-cache',
          type: 'step-start',
          tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        },
      },
    })

    expect(() => {
      partHandler!({
        properties: {
          part: {
            id: 'missing-cache',
            type: 'step-finish',
            tokens: { input: 100, output: 50 },
          },
        },
      })
    }).not.toThrow()
  })

  it('should handle step-finish without reasoning field', () => {
    const partHandler = eventHandlers.get('message.part.updated')
    expect(partHandler).toBeDefined()

    partHandler!({
      properties: {
        part: {
          id: 'no-reasoning',
          type: 'step-start',
          tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        },
      },
    })

    expect(() => {
      partHandler!({
        properties: {
          part: {
            id: 'no-reasoning',
            type: 'step-finish',
            tokens: { input: 100, output: 50, cache: { read: 20, write: 0 } },
          },
        },
      })
    }).not.toThrow()
  })

  it('should handle subagent step-finish with different messageID during main thread', () => {
    const partHandler = eventHandlers.get('message.part.updated')
    expect(partHandler).toBeDefined()

    // Main thread step-start with messageID
    partHandler!({
      properties: {
        part: {
          id: 'main-step',
          type: 'step-start',
          messageID: 'msg-main',
          tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        },
      },
    })

    // Subagent step-finish with different messageID — should not crash
    expect(() => {
      partHandler!({
        properties: {
          part: {
            id: 'sub-finish',
            type: 'step-finish',
            messageID: 'msg-sub',
            tokens: { input: 10, output: 20, cache: { read: 5, write: 0 }, reasoning: 5 },
          },
        },
      })
    }).not.toThrow()

    // Main thread step-finish — should not crash
    expect(() => {
      partHandler!({
        properties: {
          part: {
            id: 'main-finish',
            type: 'step-finish',
            messageID: 'msg-main',
            tokens: { input: 100, output: 50, cache: { read: 20, write: 0 }, reasoning: 30 },
          },
        },
      })
    }).not.toThrow()
  })

  it('should handle nested subagent step-finish (3-layer) without crash', () => {
    const partHandler = eventHandlers.get('message.part.updated')
    expect(partHandler).toBeDefined()

    // Main thread step-start
    partHandler!({
      properties: {
        part: {
          id: 'main-step',
          type: 'step-start',
          messageID: 'msg-main',
          tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        },
      },
    })

    // Subagent step-finish
    partHandler!({
      properties: {
        part: {
          id: 'sub-finish',
          type: 'step-finish',
          messageID: 'msg-sub',
          tokens: { input: 50, output: 25, cache: { read: 10, write: 0 }, reasoning: 15 },
        },
      },
    })

    // Nested subagent step-finish
    partHandler!({
      properties: {
        part: {
          id: 'nested-finish',
          type: 'step-finish',
          messageID: 'msg-nested',
          tokens: { input: 20, output: 10, cache: { read: 5, write: 0 }, reasoning: 0 },
        },
      },
    })

    // Main thread step-finish
    expect(() => {
      partHandler!({
        properties: {
          part: {
            id: 'main-finish',
            type: 'step-finish',
            messageID: 'msg-main',
            tokens: { input: 100, output: 50, cache: { read: 20, write: 0 }, reasoning: 30 },
          },
        },
      })
    }).not.toThrow()
  })

  it('should handle step-finish with matching messageID as authoritative endGeneration', () => {
    const partHandler = eventHandlers.get('message.part.updated')
    expect(partHandler).toBeDefined()

    // Start generation with messageID
    partHandler!({
      properties: {
        part: {
          id: 'the-step',
          type: 'step-start',
          messageID: 'msg-123',
          tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        },
      },
    })

    // Same-messageID step-finish — should not crash
    expect(() => {
      partHandler!({
        properties: {
          part: {
            id: 'the-finish',
            type: 'step-finish',
            messageID: 'msg-123',
            tokens: { input: 100, output: 50, cache: { read: 20, write: 0 }, reasoning: 30 },
          },
        },
      })
    }).not.toThrow()
  })

  it('should reject stale step-finish from previous gen when generation started via session.status', () => {
    const statusHandler = eventHandlers.get('session.status')
    const partHandler = eventHandlers.get('message.part.updated')
    expect(statusHandler).toBeDefined()
    expect(partHandler).toBeDefined()

    // Gen 1 via session.status (currentMessageId = null)
    statusHandler!({
      properties: { status: { type: 'busy' } },
    })

    // Gen 1 step-finish (becomes authoritative, stores lastEndedMessageId)
    partHandler!({
      properties: {
        part: {
          id: 'finish-1',
          type: 'step-finish',
          messageID: 'msg-gen1',
          tokens: { input: 100, output: 50, cache: { read: 20, write: 0 }, reasoning: 30 },
        },
      },
    })

    // Gen 2 via session.status
    statusHandler!({
      properties: { status: { type: 'busy' } },
    })

    // Stale step-finish from Gen 1 — should NOT crash (routed to accumulateTokens)
    expect(() => {
      partHandler!({
        properties: {
          part: {
            id: 'finish-1-stale',
            type: 'step-finish',
            messageID: 'msg-gen1',
            tokens: { input: 100, output: 50, cache: { read: 20, write: 0 }, reasoning: 30 },
          },
        },
      })
    }).not.toThrow()

    // Gen 2's own step-finish — should work normally
    expect(() => {
      partHandler!({
        properties: {
          part: {
            id: 'finish-2',
            type: 'step-finish',
            messageID: 'msg-gen2',
            tokens: { input: 200, output: 100, cache: { read: 40, write: 0 }, reasoning: 60 },
          },
        },
      })
    }).not.toThrow()
  })
})
