/**
 * Candidate heuristic, evaluated against the same corpus as
 * `eval-corpus.ts` to compare projected improvement vs shipped behavior.
 *
 * v0.4.10 SHIPPED changes vs 0.4.9 (all push toward STOP — safe direction):
 *   Tweak 2 — Question regex extended with indirect-offer phrases
 *             ("let me know if", "if you'd like", "tell me if", etc.).
 *   Tweak 3 — Blocker regex extended with intent-equivalents to
 *             "requires your" ("needs your", "needs you to", "action required").
 *   Tweak 4 — Final-answer length floor lowered 40 → 30 so short clean
 *             completions ("Task is now completely done. Pushed.") match.
 *   Tweak 5 — '?' anywhere in last block (was: endsWith only) + soft-proceed
 *             phrases ("say go", "push back", "your call", "if you want to",
 *             "sounds good", "ready to ship", etc.) treated as questions.
 *             Catches F02-shape over-eager fires observed in real plugin.log.
 *
 * v0.4.11 SHIPPED additions (also push toward STOP):
 *   Tweak 6 — Question regex picks up "ready when/whenever/once/if you" /
 *             "standing by" / "i'll stand by" / "let me know when".
 *             Triggered by 04:00:41 real fire on "Ready when you are."
 *             — and the meta-irony that "standing by" is the exact stub
 *             commit 49345e3 fought against at the CLI-stub layer.
 *
 * v0.4.12 SHIPPED additions (defensive — user-requested preemptive):
 *   Tweak 7 — Question regex picks up "over to you" / "your turn" /
 *             "all yours" / "let me know how" / "i'm here".
 *             User-requested defensive coverage of soft-proceed idioms.
 *             "i'm here" is FP-prone on conversational openers — accepted
 *             since cost of FP is one extra continue press.
 *
 * v0.4.15 SHIPPED additions (also push toward STOP):
 *   Tweak 8 — Final-answer keyword regex picks up "shipped|deployed|
 *             merged|tagged|live|pinned". Driven by 03:31 real fire on
 *             "v0.4.13 on npm" — completion verbs the model uses at
 *             turn end that weren't in the original v0.4.5 keyword list.
 *   Tweak 9 — Strong-completion phrases ("we're done", "we are done",
 *             "all done", "all set") bypass the 30-char length floor.
 *             User-requested. These are unambiguous end-of-turn signals
 *             at any text length.
 *
 * EXPERIMENTAL — NOT SHIPPED:
 *   Tweak 1 — `looksLikeMidTaskContinuation` override of completion-keyword
 *             detection. Defined below for documentation/future reference
 *             but its call site in `looksLikeFinalAnswer` is commented out.
 *             Rationale for not shipping: would widen auto-continue (the
 *             unsafe direction), and there are zero observed G-class fires
 *             in real plugin.log. Keep around in case organic G-class fires
 *             appear later — corpus G01-G04 are the regression bench.
 *
 * Run: npx tsx sim/eval-candidate.ts
 */

type State = {
  enabled: boolean | "smart" | undefined
  attempts: number
  startedAt: number
  noProgressCount: number
  lastSignature?: string
  aborted?: boolean
}
type Snapshot = {
  text: string
  lastVisibleText: string
  hadReasoning: boolean
  hadToolActivity: boolean
  hadProxyActivity: boolean
  isError?: boolean
  now?: number
}
type Decision = { continue: boolean; reason: string }

const AUTO_CONTINUE_MAX_ATTEMPTS = 8
const AUTO_CONTINUE_MAX_ELAPSED_MS = 10 * 60 * 1000
const AUTO_CONTINUE_NO_PROGRESS_LIMIT = 2

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

function looksLikeQuestion(text: string): boolean {
  const t = normalize(text).toLowerCase()
  if (!t) return false
  // Tweak 5a: '?' anywhere in the last block, not just trailing. Catches
  // long answers that ask a question mid-text then list options after,
  // ending in a period. FP risk on inline code (`result?.value`) — accepted;
  // the cost is one extra "continue" press if it hits.
  if (t.includes("?")) return true
  // v0.4.11: "ready when you are" / "standing by" / "let me know when".
  // v0.4.12: "over to you" / "your turn" / "all yours" / "let me know how" / "i'm here".
  return /\b(please confirm|can you confirm|should i|would you like|do you want|which option|choose|pick one|need your|need you to|what would you like|let me know if|let me know whether|let me know what|let me know when|let me know how|if you'?d like|if you want to|tell me if|tell me which|tell me whether|say (?:go|yes|no)|push back|sign off|sounds? (?:good|right)|your call|your move|your turn|over to you|all yours|up to you|ready to (?:ship|go|proceed|merge)|ready (?:when|whenever|once|if) you|standing by|i'?ll stand ?by|i'?m here|happy to (?:ship|go|proceed|merge))\b/.test(t)
}

function looksLikeBlocker(text: string): boolean {
  const t = normalize(text).toLowerCase()
  if (!t) return false
  return /\b(blocked|blocker|cannot proceed|can't proceed|unable to proceed|need clarification|need more information|permission denied|failed and needs|requires your|needs your|needs you to|action required|manual step|required from you)\b/.test(t)
}

/**
 * Candidate addition: detect explicit forward-motion phrases that prove
 * the model is mid-task even if a completion verb is in the same sentence.
 * If this fires, looksLikeFinalAnswer is suppressed.
 */
function looksLikeMidTaskContinuation(text: string): boolean {
  const t = normalize(text).toLowerCase()
  if (!t) return false
  return /\b(now [a-z]+ing\b|now i'll|now i will|next i'll|next i will|next [a-z]+ing\b|next to (?:confirm|verify|check|test|ensure|validate|run|see)|moving on|moving to|before i\b|then i'll|then i will|after that|let me also|let's also|i'll also|i will now|i'm going to|going to [a-z]+|kicking off|on to (?:file|step|task|the next))\b/.test(t)
}

function looksLikeFinalAnswer(text: string): boolean {
  const t = normalize(text).toLowerCase()
  if (looksLikeQuestion(t) || looksLikeBlocker(t)) return false
  // v0.4.15 strong-completion phrases (bypass length floor):
  if (/\b(we'?re done|we are done|all done|all set)\b/.test(t)) {
    return true
  }
  // Tweak 4: floor lowered 40 → 30. Catches "Task is now completely done.
  // Pushed." (36 chars) without going so low that ambiguous short text
  // ("Done with phase 1.") could match.
  if (t.length < 30) return false
  // Tweak 1 (experimental, NOT shipped in v0.4.10):
  //   if (looksLikeMidTaskContinuation(t)) return false
  // The mid-task-continuation override widens auto-continue, opposite of
  // safe failure direction. No real-world G-class fires observed. Kept
  // available below for future evaluation.
  // v0.4.15: keyword list extended with shipped|deployed|merged|tagged|
  // live|pinned (deploy/ship verbs at turn end). Also "tests pass"
  // present tense (was past-tense-only) — fixes real fire 03:31 that
  // ended in "78/78 tests pass".
  return /\b(done|completed|fixed|implemented|verified|published|released|sent|delivered|updated|shipped|deployed|merged|tagged|live|pinned)\b/.test(t) ||
    /\b(checks?|tests?) (?:pass|passes|passed)\b/.test(t) ||
    /\b(summary|what changed|verification)\b/.test(t)
}

function continuationSignature(s: Snapshot): string {
  const text = normalize(s.text).slice(-500)
  return JSON.stringify({
    text,
    reasoning: s.hadReasoning,
    tools: s.hadToolActivity,
    proxy: s.hadProxyActivity,
  })
}

function shouldAutoContinueCandidate(state: State, snapshot: Snapshot): Decision {
  if (state.enabled === false) return { continue: false, reason: "disabled" }
  if (snapshot.isError) return { continue: false, reason: "error" }
  if (state.aborted) return { continue: false, reason: "aborted" }
  if (state.attempts >= AUTO_CONTINUE_MAX_ATTEMPTS) {
    return { continue: false, reason: "max-attempts" }
  }
  const now = snapshot.now ?? Date.now()
  if (now - state.startedAt > AUTO_CONTINUE_MAX_ELAPSED_MS) {
    return { continue: false, reason: "max-elapsed" }
  }

  const text = normalize(snapshot.text)
  const lastText = normalize(snapshot.lastVisibleText)
  if (looksLikeQuestion(text)) return { continue: false, reason: "question" }
  if (looksLikeBlocker(text)) return { continue: false, reason: "blocker" }
  if (looksLikeFinalAnswer(lastText)) {
    return { continue: false, reason: "final-answer" }
  }

  const hadActivity =
    snapshot.hadReasoning || snapshot.hadToolActivity || snapshot.hadProxyActivity
  if (!hadActivity) return { continue: false, reason: "no-activity" }

  const signature = continuationSignature(snapshot)
  const noProgress = signature === state.lastSignature
  if (noProgress && state.noProgressCount + 1 >= AUTO_CONTINUE_NO_PROGRESS_LIMIT) {
    return { continue: false, reason: "no-progress" }
  }

  if (!text) {
    return { continue: true, reason: "activity-without-visible-answer" }
  }

  return { continue: true, reason: "non-final-progress" }
}

// ───────────────────────────────────────────────────────────────────────────
// Re-import the same cases as the baseline corpus and run both.
// ───────────────────────────────────────────────────────────────────────────

import { shouldAutoContinueIncompleteTurn as baseline } from "../src/claude-code-language-model.js"

interface Case {
  id: string
  category: string
  label: string
  state?: Partial<State>
  snapshot: Partial<Snapshot>
  expected: "continue" | "stop"
  rationale: string
}

function mkState(o: Partial<State> = {}): State {
  return { enabled: "smart", attempts: 0, startedAt: 1_000, noProgressCount: 0, ...o } as State
}
function mkSnap(o: Partial<Snapshot> = {}): Snapshot {
  const base: any = {
    text: "", lastVisibleText: "",
    hadReasoning: false, hadToolActivity: false, hadProxyActivity: false,
    now: 1_500, ...o,
  }
  if (o.text !== undefined && o.lastVisibleText === undefined) base.lastVisibleText = o.text
  return base
}

const cases: Case[] = [
  { id: "A01", category: "should-continue", label: "tool activity only, no text",
    snapshot: { hadToolActivity: true }, expected: "continue", rationale: "" },
  { id: "A02", category: "should-continue", label: "short mid-task narration",
    snapshot: { text: "Let me check the next file.", hadToolActivity: true }, expected: "continue", rationale: "" },
  { id: "A03", category: "should-continue", label: "step announcement",
    snapshot: { text: "Running tests now.", hadProxyActivity: true }, expected: "continue", rationale: "" },
  { id: "A04", category: "should-continue", label: "reasoning only, brief text",
    snapshot: { text: "Working on it.", hadReasoning: true }, expected: "continue", rationale: "" },
  { id: "A05", category: "should-continue", label: "multi-step plan narration",
    snapshot: { text: "Now I'll read the file. Then I'll diff against previous. Then summarize.", hadReasoning: true }, expected: "continue", rationale: "" },

  { id: "B01", category: "should-stop-final", label: "explicit completion",
    snapshot: { text: "Done — published v0.4.9. Restart opencode to verify the new behavior.", hadReasoning: true, hadToolActivity: true }, expected: "stop", rationale: "" },
  { id: "B02", category: "should-stop-final", label: "verification summary",
    snapshot: { text: "Verified end-to-end. 63 tests passed. Build clean. Restart to load.", hadToolActivity: true }, expected: "stop", rationale: "" },
  { id: "B03", category: "should-stop-final", label: "markdown summary section",
    snapshot: { text: "## Summary\n- Fixed the import bug\n- Tests pass\n- Published 0.4.9", hadReasoning: true, hadToolActivity: true }, expected: "stop", rationale: "" },

  { id: "C01", category: "should-stop-question", label: "literal question mark",
    snapshot: { text: "I see two paths. Should I proceed with option A or option B?", hadReasoning: true }, expected: "stop", rationale: "" },
  { id: "C02", category: "should-stop-question", label: "which/choose phrasing",
    snapshot: { text: "Which approach do you prefer: the broker fix or the heuristic fix?", hadReasoning: true }, expected: "stop", rationale: "" },
  { id: "C03", category: "should-stop-question", label: "indirect offer (no '?')",
    snapshot: { text: "Let me know if you'd like me to proceed with the cleanup phase or stop here.", hadReasoning: true }, expected: "stop", rationale: "" },

  { id: "D01", category: "should-stop-blocker", label: "explicit cannot proceed",
    snapshot: { text: "I can't proceed without you setting the API key first.", hadReasoning: true }, expected: "stop", rationale: "" },
  { id: "D02", category: "should-stop-blocker", label: "permission + manual step",
    snapshot: { text: "Permission denied on /etc/foo. This is a manual step you'll need to handle.", hadToolActivity: true }, expected: "stop", rationale: "" },
  { id: "D03", category: "should-stop-blocker", label: "indirect approval needed",
    snapshot: { text: "Needs your approval before I push the tag — auto-push is not enabled.", hadReasoning: true }, expected: "stop", rationale: "" },

  { id: "E01", category: "should-stop-noactivity", label: "completely empty",
    snapshot: {}, expected: "stop", rationale: "" },

  { id: "F01", category: "real-fire-repro", label: "02:19:14 over-eager continue",
    snapshot: {
      text: "Let me check the plugin log and opencode log right after the last turn ended to see what warning surfaced. I'll look at the most recent NOTICE events and correlate with timing. After that I'll inspect the logger code path to find where the leak originates. The hypothesis is that log.notice writes to console.error which opencode promotes to a UI warning bubble.",
      hadToolActivity: true,
    },
    expected: "continue", rationale: "" },
  { id: "F02", category: "real-fire-repro", label: "02:48:11 long answer ending in recommendation",
    snapshot: {
      text: ("Here's the full picture. DEBUG was introduced by this plugin (initial commit b03fa8e). opencode itself has no logging convention — plugins use raw console.* and opencode promotes any stderr to UI warnings. Three other installed plugins I sampled all log via plain console.error with no gating. We're the only one in your setup with structured logging or a DEBUG flag. Recommendation: leave DEBUG off (current state); ").repeat(3) +
            "consider option C if you want to re-enable DEBUG without UI noise.",
      hadReasoning: true, hadToolActivity: true,
    },
    expected: "stop", rationale: "" },
  { id: "F03", category: "real-fire-repro", label: "01:10:43 long answer that correctly stopped",
    snapshot: {
      text: "## Diagnosis complete\n\nThe root cause is clear: the proxy broker holds one pending call per session. I've fixed it. Updated `proxy-broker.ts` with a 10-min timeout and changed the rejection direction. Tests added; 51/51 passing. Verified end-to-end with three scenarios.",
      hadReasoning: true, hadToolActivity: true,
    },
    expected: "stop", rationale: "" },
  { id: "F04", category: "real-fire-repro", label: "03:31:16 'say go or push back' (today's fire)",
    snapshot: {
      text: "My recommendation is the conservative path. Here's the projected match rate. Want me to proceed with that? Concretely: 1. Apply 3 surgical changes. 2. Add regression tests. 3. Add header note. 4. Commit sim files. 5. Bump 0.4.9 to 0.4.10. 6. Update opencode.jsonc. Say 'go' or push back on any step.",
      hadReasoning: true,
    },
    expected: "stop", rationale: "Has '?' mid-text + 'say go' + 'push back' — clear awaiting-input signal" },
  { id: "F05", category: "real-fire-repro", label: "02:48:11 'consider if you want to' (no '?')",
    snapshot: {
      text: ("Here's the picture. DEBUG was introduced by this plugin. opencode itself has no logging convention. Plugins use raw console.* and opencode promotes stderr to UI warnings. We're the only one with structured logging. Recommendation: leave DEBUG off (current state); ").repeat(3) +
            "consider option C if you want to re-enable DEBUG without UI noise.",
      hadReasoning: true, hadToolActivity: true,
    },
    expected: "stop", rationale: "Reconstruction of 02:48:11 over-eager fire — 'if you want to' is the awaiting-input signal" },
  { id: "F06", category: "real-fire-repro", label: "04:00:41 'Ready when you are' (today's v0.4.11 fire)",
    snapshot: {
      text: "Yes — real idiom, 'ready and waiting.' But you caught the irony. It's the exact stub Claude CLI used to emit on empty turns. The habit lives in training, not just in Claude CLI's empty-turn behavior. Ready when you are.",
      hadReasoning: true,
    },
    expected: "stop", rationale: "Real fire from 04:00:41 — 'Ready when you are' is the canonical 'your move' phrase; v0.4.11 adds it explicitly" },
  { id: "F07", category: "real-fire-repro", label: "'Standing by' — the meta-irony stub",
    snapshot: {
      text: "All done on my side; the rest is on you. Standing by.",
      hadReasoning: true, hadToolActivity: true,
    },
    expected: "stop", rationale: "Self-referential — the exact stub commit 49345e3 was designed to suppress at the CLI layer; v0.4.11 adds it at the model-output layer too" },
  { id: "F08", category: "real-fire-repro", label: "v0.4.12 'over to you'",
    snapshot: {
      text: "I've prepared the patch and tests are green. Over to you.",
      hadReasoning: true, hadToolActivity: true,
    },
    expected: "stop", rationale: "Defensive add; canonical handoff phrase" },
  { id: "F09", category: "real-fire-repro", label: "v0.4.12 'your turn'",
    snapshot: {
      text: "Reviewed the diff and flagged three concerns. Your turn to pick a direction.",
      hadReasoning: true,
    },
    expected: "stop", rationale: "Defensive add; explicit 'your move' variant" },
  { id: "F10", category: "real-fire-repro", label: "v0.4.12 'all yours'",
    snapshot: {
      text: "Branch is rebased and the PR template filled. The rest is all yours.",
      hadReasoning: true, hadToolActivity: true,
    },
    expected: "stop", rationale: "Defensive add; handoff idiom" },
  { id: "F11", category: "real-fire-repro", label: "v0.4.12 'let me know how'",
    snapshot: {
      text: "Three viable paths surfaced. Let me know how you'd like to proceed.",
      hadReasoning: true,
    },
    expected: "stop", rationale: "Defensive add; sibling of let-me-know-if/whether/what/when" },
  { id: "F12", category: "real-fire-repro", label: "v0.4.12 'i'm here'",
    snapshot: {
      text: "All staged for the release. I'm here when you're ready to ship.",
      hadReasoning: true,
    },
    expected: "stop", rationale: "Defensive add; FP risk on conversational openers — accepted, safe direction" },
  { id: "F13", category: "real-fire-repro", label: "v0.4.15 'shipped' as keyword (real fire 03:31)",
    snapshot: {
      text: "v0.4.13 on npm, pin matches, 78/78 tests pass, sim corpus + regression bench preserved as future leverage.",
      hadReasoning: true,
    },
    expected: "stop", rationale: "Real fire shape — 'shipped' completion verb wasn't in v0.4.14 keyword list" },
  { id: "F14", category: "real-fire-repro", label: "v0.4.15 'deployed/merged/tagged'",
    snapshot: {
      text: "Patch merged to master, tagged v0.4.15, deployed via CI. Restart at your convenience.",
      hadReasoning: true, hadToolActivity: true,
    },
    expected: "stop", rationale: "Multiple v0.4.15 keywords in one sentence" },
  { id: "F15", category: "real-fire-repro", label: "v0.4.15 'pinned' as keyword",
    snapshot: {
      text: "Plugin pinned at @0.4.15 in opencode.jsonc. Restart loads it.",
      hadReasoning: true,
    },
    expected: "stop", rationale: "'pinned' added as completion verb in v0.4.15" },
  { id: "F16", category: "real-fire-repro", label: "v0.4.15 'we're done' short message bypasses length floor",
    snapshot: {
      text: "We're done.",  // 11 chars — below 30-char threshold
      hadReasoning: true,
    },
    expected: "stop", rationale: "Strong-completion phrase should bypass length floor" },
  { id: "F17", category: "real-fire-repro", label: "v0.4.15 'all set' short message",
    snapshot: {
      text: "All set.",  // 8 chars
      hadReasoning: true, hadToolActivity: true,
    },
    expected: "stop", rationale: "Strong-completion phrase at minimal length" },

  { id: "G01", category: "midtask-keyword-fp", label: "'updated' mid-task",
    snapshot: { text: "Updated the cache, now checking for stale entries before the next sync.", hadToolActivity: true }, expected: "continue", rationale: "" },
  { id: "G02", category: "midtask-keyword-fp", label: "'implemented' mid-task",
    snapshot: { text: "Implemented the new branch logic. Now writing the test cases before committing.", hadReasoning: true, hadToolActivity: true }, expected: "continue", rationale: "" },
  { id: "G03", category: "midtask-keyword-fp", label: "'fixed' mid-task",
    snapshot: { text: "Fixed the import path. Running tests next to confirm nothing else broke.", hadToolActivity: true }, expected: "continue", rationale: "" },
  { id: "G04", category: "midtask-keyword-fp", label: "'done' as step marker",
    snapshot: { text: "Done with file 1, moving on to file 2 of 5.", hadProxyActivity: true }, expected: "continue", rationale: "" },

  { id: "H01", category: "state-machine", label: "max attempts",
    state: { attempts: 8 }, snapshot: { text: "Still working on it.", hadToolActivity: true }, expected: "stop", rationale: "" },
  { id: "H02", category: "state-machine", label: "max elapsed",
    state: { startedAt: 1_000 }, snapshot: { text: "Still working.", hadToolActivity: true, now: 1_000 + 11 * 60 * 1000 }, expected: "stop", rationale: "" },
  { id: "H03", category: "state-machine", label: "aborted",
    state: { aborted: true }, snapshot: { text: "Mid-step text", hadToolActivity: true }, expected: "stop", rationale: "" },
  { id: "H04", category: "state-machine", label: "isError",
    snapshot: { text: "Working...", hadToolActivity: true, isError: true }, expected: "stop", rationale: "" },
  { id: "H05", category: "state-machine", label: "user-disabled",
    state: { enabled: false }, snapshot: { text: "Mid-step.", hadToolActivity: true }, expected: "stop", rationale: "" },
  { id: "H06", category: "state-machine", label: "no-progress loop",
    state: { noProgressCount: 1, lastSignature: JSON.stringify({ text: "", reasoning: false, tools: false, proxy: true }) },
    snapshot: { hadToolActivity: false, hadReasoning: false, hadProxyActivity: true }, expected: "stop", rationale: "" },

  { id: "I01", category: "boundary", label: "39 chars with 'done'",
    snapshot: { text: "Task is now completely done. Pushed.", hadToolActivity: true }, expected: "stop", rationale: "" },
  { id: "I02", category: "boundary", label: "last-block clean, accumulated dirty",
    snapshot: {
      text: "Implemented the change. Now running tests. ... Initial output looks clean.",
      lastVisibleText: "Initial output looks clean.",
      hadToolActivity: true,
    },
    expected: "continue", rationale: "" },
]

function runOne(decider: (s: State, ss: Snapshot) => Decision, label: string): {
  matched: number; fp: number; fn: number; rows: string[]
} {
  let matched = 0, fp = 0, fn = 0
  const rows: string[] = []
  for (const c of cases) {
    const decision = decider(mkState(c.state), mkSnap(c.snapshot))
    const actual = decision.continue ? "continue" : "stop"
    const ok = actual === c.expected
    if (ok) matched++
    else if (c.expected === "stop" && actual === "continue") fp++
    else fn++
    const flag = ok ? "✓" : actual === "continue" ? "FP" : "FN"
    rows.push(`${c.id}\t${flag}\t${decision.reason}`)
  }
  return { matched, fp, fn, rows }
}

const baselineRun = runOne((s, ss) => baseline(s, ss), "baseline (0.4.9)")
const candidateRun = runOne((s, ss) => shouldAutoContinueCandidate(s, ss), "candidate")

console.log("\n# Heuristic Comparison: v0.4.9 baseline vs candidate v0.4.10\n")
console.log(`Cases: ${cases.length}\n`)
console.log("## Per-case comparison\n")
console.log("| ID | Expected | Baseline | Cand. | Δ |")
console.log("|---|---|---|---|---|")
for (let i = 0; i < cases.length; i++) {
  const [bid, bflag, breason] = baselineRun.rows[i].split("\t")
  const [, cflag, creason] = candidateRun.rows[i].split("\t")
  const changed = bflag !== cflag ? "**Δ**" : ""
  const c = cases.find((x) => x.id === bid)!
  console.log(`| ${bid} | ${c.expected} | ${bflag} \`${breason}\` | ${cflag} \`${creason}\` | ${changed} |`)
}
console.log("\n## Summary\n")
console.log("| Heuristic | Matched | FP | FN | Match rate |")
console.log("|---|---|---|---|---|")
for (const [name, r] of [
  ["baseline v0.4.9", baselineRun],
  ["candidate v0.4.10", candidateRun],
] as const) {
  console.log(`| ${name} | ${r.matched}/${cases.length} | ${r.fp} | ${r.fn} | ${((r.matched / cases.length) * 100).toFixed(0)}% |`)
}
const delta = candidateRun.matched - baselineRun.matched
console.log(`\nNet improvement: **${delta >= 0 ? "+" : ""}${delta}** cases matched.\n`)
