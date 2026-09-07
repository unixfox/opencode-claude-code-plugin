import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"
import { claudeCodeProviders } from "./src/index.js"
import { resolveSpawnCwdFrom } from "./src/runtime-status.js"
import {
  collectStartupDiagnostics,
  describeSpawnCwd,
  detectOpencodeVersion,
  pickOpencodeVersion,
  pluginVersion,
  resetOpencodeVersionProbe,
} from "./src/startup-diagnostics.js"

test("pluginVersion reads the real package manifest", () => {
  const version = pluginVersion()
  assert.match(version, /^\d+\.\d+\.\d+/)
})

test("describeSpawnCwd reports which branch resolveSpawnCwd would take", () => {
  assert.deepEqual(describeSpawnCwd("/pinned", "/live", "/captured"), {
    resolved: "/pinned",
    source: "configured",
  })
  assert.deepEqual(describeSpawnCwd(undefined, "/live/dir", "/captured"), {
    resolved: "/live/dir",
    source: "process",
  })
  // The macOS GUI-launch fingerprint from issue #4: process.cwd() is "/".
  assert.deepEqual(describeSpawnCwd(undefined, "/", "/captured/dir"), {
    resolved: "/captured/dir",
    source: "captured",
  })
  assert.deepEqual(describeSpawnCwd(undefined, "/", undefined), {
    resolved: "/",
    source: "unresolved",
  })
})

test("describeSpawnCwd never disagrees with resolveSpawnCwd", () => {
  const cases: Array<[string | undefined, string, string | undefined]> = [
    ["/pinned", "/live", "/captured"],
    [undefined, "/live/dir", "/captured"],
    [undefined, "/", "/captured/dir"],
    [undefined, "/", undefined],
  ]
  for (const [configured, live, captured] of cases) {
    assert.equal(
      describeSpawnCwd(configured, live, captured).resolved,
      resolveSpawnCwdFrom(configured, live, captured),
    )
  }
})

test("pickOpencodeVersion probes known shapes and degrades to undefined", () => {
  assert.equal(pickOpencodeVersion({ app: { version: "1.17.0" } }), "1.17.0")
  assert.equal(pickOpencodeVersion({ version: "1.17.0" }), "1.17.0")
  assert.equal(pickOpencodeVersion({ app: {} }), undefined)
  assert.equal(pickOpencodeVersion({ app: { version: "" } }), undefined)
  assert.equal(pickOpencodeVersion(undefined), undefined)
  assert.equal(pickOpencodeVersion("nope"), undefined)
})

test("claudeCodeProviders keeps only this plugin's providers", () => {
  const providers = claudeCodeProviders({
    "claude-code": { options: { cliPath: "claude" } },
    "claude-code-work": { options: { account: "work" } },
    anthropic: { options: { cliPath: "not-ours" } },
    "github-copilot": {},
  })
  assert.deepEqual(Object.keys(providers).sort(), [
    "claude-code",
    "claude-code-work",
  ])
})

test("collectStartupDiagnostics summarizes account providers", () => {
  const diagnostics = collectStartupDiagnostics(
    {
      "claude-code-work": {
        options: {
          account: "work",
          cliPath: "/tmp/claude-work",
          cwd: "/pinned/dir",
          proxyTools: ["Bash", "Task"],
        },
      },
      "claude-code-personal": {
        options: { account: "personal", cliPath: "/tmp/claude-personal" },
      },
    },
    "1.17.0",
  )

  assert.equal(diagnostics.opencode, "1.17.0")
  assert.equal(diagnostics.claudeCliPath, "/tmp/claude-work")
  assert.deepEqual(diagnostics.accounts, ["work", "personal"])
  assert.deepEqual(diagnostics.proxyTools, ["Bash", "Task"])
  assert.deepEqual(diagnostics.cwd, {
    resolved: "/pinned/dir",
    source: "configured",
  })
  assert.deepEqual(diagnostics.providers, [
    "claude-code-work",
    "claude-code-personal",
  ])
  assert.ok(Array.isArray(diagnostics.mcpServers))
})

test("collectStartupDiagnostics falls back when options are absent", () => {
  const diagnostics = collectStartupDiagnostics({ "claude-code": {} })

  assert.equal(diagnostics.claudeCliPath, "claude")
  assert.deepEqual(diagnostics.accounts, [])
  assert.deepEqual(diagnostics.proxyTools, [])
  assert.equal(diagnostics.cwd.source, "process")
  // No opencode version handed in and none in the env → explicit "unknown",
  // never a fabricated number.
  if (!process.env.OPENCODE_VERSION) {
    assert.equal(diagnostics.opencode, "unknown")
  }
})

test("collectStartupDiagnostics reports interactive transport from env", () => {
  const previous = process.env.CLAUDE_CODE_INTERACTIVE_TRANSPORT
  try {
    delete process.env.CLAUDE_CODE_INTERACTIVE_TRANSPORT
    assert.equal(
      collectStartupDiagnostics({ "claude-code": {} }).interactiveTransport,
      false,
    )
    assert.equal(
      collectStartupDiagnostics({
        "claude-code": { options: { interactive: true } },
      }).interactiveTransport,
      true,
    )
    process.env.CLAUDE_CODE_INTERACTIVE_TRANSPORT = "1"
    assert.equal(
      collectStartupDiagnostics({ "claude-code": {} }).interactiveTransport,
      true,
    )
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_INTERACTIVE_TRANSPORT
    else process.env.CLAUDE_CODE_INTERACTIVE_TRANSPORT = previous
  }
})

test("detectOpencodeVersion reads the version from the opencode binary", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-version-probe-"))
  const fake = path.join(dir, "opencode")
  fs.writeFileSync(fake, '#!/bin/sh\necho "1.18.5"\n')
  fs.chmodSync(fake, 0o755)
  try {
    resetOpencodeVersionProbe()
    assert.equal(await detectOpencodeVersion(fake), "1.18.5")
    // Cached: a second call with a different path reuses the first probe.
    assert.equal(await detectOpencodeVersion("/nonexistent/opencode"), "1.18.5")
  } finally {
    resetOpencodeVersionProbe()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("detectOpencodeVersion refuses to report a non-opencode execPath", async () => {
  try {
    // Running from source means execPath is Bun; reporting Bun's version as
    // opencode's would be actively misleading, so the probe declines.
    resetOpencodeVersionProbe()
    assert.equal(await detectOpencodeVersion("/opt/homebrew/bin/bun"), undefined)
  } finally {
    resetOpencodeVersionProbe()
  }
})

test("detectOpencodeVersion returns undefined when the binary fails", async () => {
  try {
    resetOpencodeVersionProbe()
    assert.equal(await detectOpencodeVersion("/nonexistent/dir/opencode"), undefined)
  } finally {
    resetOpencodeVersionProbe()
  }
})
