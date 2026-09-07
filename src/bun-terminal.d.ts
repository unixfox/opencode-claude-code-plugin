// Minimal ambient types for the subset of Bun's native PTY API used by
// claude-session-bun.ts. Kept local on purpose: pulling full `bun-types`
// conflicts with `@types/node` in this repo, and we only need a few members.
export {}

declare global {
  interface BunTerminal {
    write(data: string | Uint8Array): number
    close(): void
    resize(cols: number, rows: number): void
  }

  interface BunSubprocess {
    readonly terminal: BunTerminal
    readonly exited: Promise<number>
    readonly pid: number
    kill(signal?: number | string): void
  }

  interface BunSpawnTerminalOptions {
    cwd?: string
    env?: Record<string, string | undefined>
    terminal?: {
      cols?: number
      rows?: number
      data?: (terminal: BunTerminal, data: Uint8Array) => void
    }
  }

  const Bun: {
    version: string
    which(command: string, options?: { PATH?: string; cwd?: string }): string | null
    spawn(command: string[], options?: BunSpawnTerminalOptions): BunSubprocess
  }
}
