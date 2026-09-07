import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

/**
 * Per-process scratch directory for plugin tmp files (bridged MCP config,
 * proxy server config, etc.). Created lazily on first use and rm'd on
 * normal process exit so we don't leak across runs. PID-isolated so two
 * concurrent opencode processes don't race on the same files.
 *
 * Caveat: `process.on("exit")` does not fire for SIGKILL or unhandled
 * external signals, so abnormal terminations still leak. OS-level tmpdir
 * cleanup (`systemd-tmpfiles`, macOS periodic) handles those eventually.
 */
const PLUGIN_TMP_DIR = path.join(
  os.tmpdir(),
  `opencode-claude-code-${process.pid}`,
)

let registered = false

export function pluginTmpDir(): string {
  if (!fs.existsSync(PLUGIN_TMP_DIR)) {
    fs.mkdirSync(PLUGIN_TMP_DIR, { recursive: true })
  }
  if (!registered) {
    registered = true
    process.on("exit", () => {
      try {
        fs.rmSync(PLUGIN_TMP_DIR, { recursive: true, force: true })
      } catch {}
    })
  }
  return PLUGIN_TMP_DIR
}
