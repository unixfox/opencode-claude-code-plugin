/**
 * Auto-continue heuristic evaluation corpus.
 *
 * Throws 30 crafted snapshots at `shouldAutoContinueIncompleteTurn` to
 * surface false-positive / false-negative patterns before tightening the
 * heuristic for v0.4.10.
 *
 * Run: npx tsx sim/eval-corpus.ts
 */

import { shouldAutoContinueIncompleteTurn } from "../src/claude-code-language-model.js"

type State = Parameters<typeof shouldAutoContinueIncompleteTurn>[0]
type Snapshot = Parameters<typeof shouldAutoContinueIncompleteTurn>[1]
type Decision = ReturnType<typeof shouldAutoContinueIncompleteTurn>

interface Case {
  id: string
  category: string
  label: string
  state?: Partial<State>
  snapshot: Partial<Snapshot>
  expected: "continue" | "stop"
  rationale: string
}

function mkState(overrides: Partial<State> = {}): State {
  return {
    enabled: "smart" as const,
    attempts: 0,
    startedAt: 1_000,
    noProgressCount: 0,
    ...overrides,
  } as State
}

function mkSnap(overrides: Partial<Snapshot> = {}): Snapshot {
  const base: any = {
    text: "",
    lastVisibleText: "",
    hadReasoning: false,
    hadToolActivity: false,
    hadProxyActivity: false,
    now: 1_500,
    ...overrides,
  }
  if (overrides.text !== undefined && overrides.lastVisibleText === undefined) {
    base.lastVisibleText = overrides.text
  }
  return base as Snapshot
}

const cases: Case[] = [
  // ─── Category A: should CONTINUE (real work in progress) ────────────────
  {
    id: "A01", category: "should-continue", label: "tool activity only, no text",
    snapshot: { hadToolActivity: true },
    expected: "continue",
    rationale: "Pure tool work mid-task; opencode UI shows the call, model just hasn't narrated yet",
  },
  {
    id: "A02", category: "should-continue", label: "short mid-task narration",
    snapshot: { text: "Let me check the next file.", hadToolActivity: true },
    expected: "continue",
    rationale: "Sub-40 chars, mid-step intent statement, clearly more work coming",
  },
  {
    id: "A03", category: "should-continue", label: "step announcement",
    snapshot: { text: "Running tests now.", hadProxyActivity: true },
    expected: "continue",
    rationale: "Tool just kicked off; next turn should report results",
  },
  {
    id: "A04", category: "should-continue", label: "reasoning only, brief text",
    snapshot: { text: "Working on it.", hadReasoning: true },
    expected: "continue",
    rationale: "Reasoning happened but no tool yet; not at a stopping point",
  },
  {
    id: "A05", category: "should-continue", label: "multi-step plan narration",
    snapshot: {
      text: "Now I'll read the file. Then I'll diff against previous. Then summarize.",
      hadReasoning: true,
    },
    expected: "continue",
    rationale: "Explicit plan-state; no completion keywords",
  },

  // ─── Category B: should STOP (final answer) ─────────────────────────────
  {
    id: "B01", category: "should-stop-final", label: "explicit completion",
    snapshot: {
      text: "Done — published v0.4.9. Restart opencode to verify the new behavior.",
      hadReasoning: true, hadToolActivity: true,
    },
    expected: "stop",
    rationale: "Classic completion phrase + restart instruction = end-of-turn",
  },
  {
    id: "B02", category: "should-stop-final", label: "verification summary",
    snapshot: {
      text: "Verified end-to-end. 63 tests passed. Build clean. Restart to load.",
      hadToolActivity: true,
    },
    expected: "stop",
    rationale: "Multiple completion signals: verified + tests passed",
  },
  {
    id: "B03", category: "should-stop-final", label: "markdown summary section",
    snapshot: {
      text: "## Summary\n- Fixed the import bug\n- Tests pass\n- Published 0.4.9",
      hadReasoning: true, hadToolActivity: true,
    },
    expected: "stop",
    rationale: "Has 'summary', 'fixed', 'tests pass', 'published' — extremely final-shaped",
  },

  // ─── Category C: should STOP (question) ─────────────────────────────────
  {
    id: "C01", category: "should-stop-question", label: "literal question mark",
    snapshot: {
      text: "I see two paths. Should I proceed with option A or option B?",
      hadReasoning: true,
    },
    expected: "stop",
    rationale: "Ends with '?', explicit ask",
  },
  {
    id: "C02", category: "should-stop-question", label: "which/choose phrasing",
    snapshot: {
      text: "Which approach do you prefer: the broker fix or the heuristic fix?",
      hadReasoning: true,
    },
    expected: "stop",
    rationale: "'which' + '?' both trip the regex",
  },
  {
    id: "C03", category: "should-stop-question", label: "indirect offer (no '?')",
    snapshot: {
      text: "Let me know if you'd like me to proceed with the cleanup phase or stop here.",
      hadReasoning: true,
    },
    expected: "stop",
    rationale: "Optional follow-up phrased as a statement — heuristic likely misses this",
  },

  // ─── Category D: should STOP (blocker) ──────────────────────────────────
  {
    id: "D01", category: "should-stop-blocker", label: "explicit cannot proceed",
    snapshot: {
      text: "I can't proceed without you setting the API key first.",
      hadReasoning: true,
    },
    expected: "stop",
    rationale: "'can't proceed' is the canonical blocker phrase",
  },
  {
    id: "D02", category: "should-stop-blocker", label: "permission + manual step",
    snapshot: {
      text: "Permission denied on /etc/foo. This is a manual step you'll need to handle.",
      hadToolActivity: true,
    },
    expected: "stop",
    rationale: "Two blocker keywords",
  },
  {
    id: "D03", category: "should-stop-blocker", label: "indirect approval needed",
    snapshot: {
      text: "Needs your approval before I push the tag — auto-push is not enabled.",
      hadReasoning: true,
    },
    expected: "stop",
    rationale: "'Needs your' is intent-equivalent to 'requires your', but heuristic looks for the latter literal",
  },

  // ─── Category E: should STOP (no activity) ──────────────────────────────
  {
    id: "E01", category: "should-stop-noactivity", label: "completely empty",
    snapshot: {},
    expected: "stop",
    rationale: "Nothing happened; no reason to continue",
  },

  // ─── Category F: real fire reproductions ────────────────────────────────
  {
    id: "F01", category: "real-fire-repro", label: "02:19:14 over-eager continue",
    snapshot: {
      text: "Let me check the plugin log and opencode log right after the last turn ended to see what warning surfaced. " +
            "I'll look at the most recent NOTICE events and correlate with timing. " +
            "After that I'll inspect the logger code path to find where the leak originates. " +
            "The hypothesis is that log.notice writes to console.error which opencode promotes to a UI warning bubble.",
      hadToolActivity: true,
    },
    expected: "continue",
    rationale: "Logged-real fire that was over-eager from user POV; matches 'mid-investigation, more work coming' but no question/blocker — heuristic correctly fires CONTINUE per its design, the question is whether design is right",
  },
  {
    id: "F02", category: "real-fire-repro", label: "02:48:11 long answer ending in recommendation",
    snapshot: {
      text: ("Here's the full picture. DEBUG was introduced by this plugin (initial commit b03fa8e). " +
            "opencode itself has no logging convention — plugins use raw console.* and opencode promotes any stderr to UI warnings. " +
            "Three other installed plugins I sampled all log via plain console.error with no gating. " +
            "We're the only one in your setup with structured logging or a DEBUG flag. " +
            "Recommendation: leave DEBUG off (current state); ").repeat(3) +
            "consider option C if you want to re-enable DEBUG without UI noise.",
      hadReasoning: true, hadToolActivity: true,
    },
    expected: "stop",
    rationale: "Real 02:48:11 over-eager fire; long analysis ending in concrete recommendation = user expected stop",
  },
  {
    id: "F03", category: "real-fire-repro", label: "01:10:43 long answer that correctly stopped",
    snapshot: {
      text: "## Diagnosis complete\n\nThe root cause is clear: the proxy broker holds one pending call per session. " +
            "I've fixed it. Updated `proxy-broker.ts` with a 10-min timeout and changed the rejection direction. " +
            "Tests added; 51/51 passing. Verified end-to-end with three scenarios.",
      hadReasoning: true, hadToolActivity: true,
    },
    expected: "stop",
    rationale: "Real 01:10:43 fire; clear completion narrative — heuristic correctly stopped",
  },

  // ─── Category G: mid-task keyword false-positives (CRITICAL CLASS) ──────
  {
    id: "G01", category: "midtask-keyword-fp", label: "'updated' mid-task",
    snapshot: {
      text: "Updated the cache, now checking for stale entries before the next sync.",
      hadToolActivity: true,
    },
    expected: "continue",
    rationale: "'updated' + 'now checking' = mid-task progress, not completion",
  },
  {
    id: "G02", category: "midtask-keyword-fp", label: "'implemented' mid-task",
    snapshot: {
      text: "Implemented the new branch logic. Now writing the test cases before committing.",
      hadReasoning: true, hadToolActivity: true,
    },
    expected: "continue",
    rationale: "'implemented' triggers final-answer but 'now writing' clearly signals more work",
  },
  {
    id: "G03", category: "midtask-keyword-fp", label: "'fixed' mid-task",
    snapshot: {
      text: "Fixed the import path. Running tests next to confirm nothing else broke.",
      hadToolActivity: true,
    },
    expected: "continue",
    rationale: "'fixed' triggers but 'Running tests next' = more work",
  },
  {
    id: "G04", category: "midtask-keyword-fp", label: "'done' as step marker",
    snapshot: {
      text: "Done with file 1, moving on to file 2 of 5.",
      hadProxyActivity: true,
    },
    expected: "continue",
    rationale: "'done' as a progress marker, not a turn-end signal",
  },

  // ─── Category H: state-machine ──────────────────────────────────────────
  {
    id: "H01", category: "state-machine", label: "max attempts",
    state: { attempts: 8 },
    snapshot: { text: "Still working on it.", hadToolActivity: true },
    expected: "stop",
    rationale: "Hit AUTO_CONTINUE_MAX_ATTEMPTS=8",
  },
  {
    id: "H02", category: "state-machine", label: "max elapsed (10 min budget)",
    state: { startedAt: 1_000 },
    snapshot: { text: "Still working.", hadToolActivity: true, now: 1_000 + 11 * 60 * 1000 },
    expected: "stop",
    rationale: "11 minutes since start; exceeds 10-min budget",
  },
  {
    id: "H03", category: "state-machine", label: "aborted",
    state: { aborted: true },
    snapshot: { text: "Mid-step text", hadToolActivity: true },
    expected: "stop",
    rationale: "Abort signal active",
  },
  {
    id: "H04", category: "state-machine", label: "isError",
    snapshot: { text: "Working...", hadToolActivity: true, isError: true },
    expected: "stop",
    rationale: "Claude CLI signaled error",
  },
  {
    id: "H05", category: "state-machine", label: "user-disabled",
    state: { enabled: false },
    snapshot: { text: "Mid-step.", hadToolActivity: true },
    expected: "stop",
    rationale: "User opted out via config",
  },
  {
    id: "H06", category: "state-machine", label: "no-progress loop",
    // Signature matches the snapshot below (computed from continuationSignature internals)
    state: {
      noProgressCount: 1,
      lastSignature: JSON.stringify({ text: "", reasoning: false, tools: false, proxy: true }),
    },
    snapshot: { hadToolActivity: false, hadReasoning: false, hadProxyActivity: true },
    expected: "stop",
    rationale: "Same signature as previous attempt; loop detection should fire when noProgressCount+1 >= 2",
  },

  // ─── Category I: boundary cases ─────────────────────────────────────────
  {
    id: "I01", category: "boundary", label: "39 chars with 'done' (under threshold)",
    snapshot: {
      text: "Task is now completely done. Pushed.",  // 36 chars
      hadToolActivity: true,
    },
    expected: "stop",
    rationale: "Human reads as complete; heuristic's 40-char floor likely says CONTINUE",
  },
  {
    id: "I02", category: "boundary", label: "last-block has no keyword, accumulated does",
    snapshot: {
      text: "Implemented the change. Now running tests. (... 1.2k chars of output ...) Initial output looks clean.",
      lastVisibleText: "Initial output looks clean.",
      hadToolActivity: true,
    },
    expected: "continue",
    rationale: "v0.4.6 last-block fix should isolate; only last block evaluated for final-answer",
  },
]

// ───────────────────────────────────────────────────────────────────────────

function runCorpus(): void {
  let matched = 0
  let falsePositives = 0  // heuristic said continue, expected stop
  let falseNegatives = 0  // heuristic said stop, expected continue
  const fpCases: Array<{ id: string; reason: string }> = []
  const fnCases: Array<{ id: string; reason: string }> = []

  const lines: string[] = []
  lines.push("# Auto-Continue Heuristic Eval Report")
  lines.push("")
  lines.push(`Plugin: opencode-claude-code-plugin@0.4.9`)
  lines.push(`Helper: shouldAutoContinueIncompleteTurn`)
  lines.push(`Cases: ${cases.length}`)
  lines.push("")
  lines.push("| ID | Category | Label | Expected | Actual | Reason | Match |")
  lines.push("|---|---|---|---|---|---|---|")

  for (const c of cases) {
    const state = mkState(c.state)
    const snap = mkSnap(c.snapshot)
    const decision: Decision = shouldAutoContinueIncompleteTurn(state, snap)
    const actual = decision.continue ? "continue" : "stop"
    const ok = actual === c.expected
    if (ok) matched++
    else if (c.expected === "stop" && actual === "continue") {
      falsePositives++
      fpCases.push({ id: c.id, reason: decision.reason })
    } else {
      falseNegatives++
      fnCases.push({ id: c.id, reason: decision.reason })
    }
    const flag = ok ? "✓" : actual === "continue" ? "**FP**" : "**FN**"
    lines.push(
      `| ${c.id} | ${c.category} | ${c.label} | ${c.expected} | ${actual} | \`${decision.reason}\` | ${flag} |`,
    )
  }

  lines.push("")
  lines.push("## Summary")
  lines.push("")
  lines.push(`- Total cases:       **${cases.length}**`)
  lines.push(`- Matched expected:  **${matched}** (${((matched / cases.length) * 100).toFixed(0)}%)`)
  lines.push(`- False positives:   **${falsePositives}** (continued when should stop)`)
  lines.push(`- False negatives:   **${falseNegatives}** (stopped when should continue)`)
  lines.push("")

  if (fpCases.length) {
    lines.push("## False Positives (over-eager continues)")
    lines.push("")
    lines.push("These are the cases where users perceive the assistant as not stopping when it should.")
    lines.push("")
    for (const fp of fpCases) {
      const c = cases.find((x) => x.id === fp.id)!
      lines.push(`- **${fp.id}** ${c.label} → heuristic continued with reason \`${fp.reason}\``)
      lines.push(`  - Rationale: ${c.rationale}`)
    }
    lines.push("")
  }

  if (fnCases.length) {
    lines.push("## False Negatives (over-eager stops)")
    lines.push("")
    lines.push("These cases cause unnecessary 'continue' presses by the user — heuristic should have kept going.")
    lines.push("")
    for (const fn of fnCases) {
      const c = cases.find((x) => x.id === fn.id)!
      lines.push(`- **${fn.id}** ${c.label} → heuristic stopped with reason \`${fn.reason}\``)
      lines.push(`  - Rationale: ${c.rationale}`)
    }
    lines.push("")
  }

  console.log(lines.join("\n"))
}

runCorpus()
