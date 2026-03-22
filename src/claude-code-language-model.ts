import type {
  LanguageModelV2,
  LanguageModelV2CallWarning,
  LanguageModelV2Content,
  LanguageModelV2FinishReason,
  LanguageModelV2StreamPart,
  LanguageModelV2Usage,
} from "@ai-sdk/provider"
import { generateId } from "@ai-sdk/provider-utils"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import type { ClaudeCodeConfig, ClaudeStreamMessage } from "./types.js"
import { mapTool } from "./tool-mapping.js"
import { getClaudeUserMessage } from "./message-builder.js"
import {
  getActiveProcess,
  spawnClaudeProcess,
  buildCliArgs,
  setClaudeSessionId,
  getClaudeSessionId,
  deleteClaudeSessionId,
  deleteActiveProcess,
  sessionKey,
} from "./session-manager.js"
import { log } from "./logger.js"

export class ClaudeCodeLanguageModel implements LanguageModelV2 {
  readonly specificationVersion = "v2"
  readonly modelId: string
  private readonly config: ClaudeCodeConfig

  constructor(modelId: string, config: ClaudeCodeConfig) {
    this.modelId = modelId
    this.config = config
  }

  readonly supportedUrls: Record<string, RegExp[]> = {}

  get provider(): string {
    return this.config.provider
  }

  private resolveCwd(options?: { providerOptions?: Record<string, unknown> }): string {
    // If user explicitly configured a cwd, respect it.
    if (this.config.cwd && this.config.cwd.trim().length > 0) {
      return this.config.cwd
    }

    // If OpenCode passed provider-level cwd explicitly, use it.
    const providerOpts = options?.providerOptions as
      | Record<string, Record<string, unknown>>
      | undefined
    const claudeCodeOpts = providerOpts?.["claude-code"]
    const explicitCwd = claudeCodeOpts?.["cwd"]
    if (typeof explicitCwd === "string" && explicitCwd.trim().length > 0) {
      return explicitCwd
    }

    // Desktop app can run with process cwd="/". If a sessionID is present,
    // resolve the actual OpenCode session directory from its SQLite DB.
    const sessionID = claudeCodeOpts?.["sessionID"]
    if (typeof sessionID === "string" && /^[A-Za-z0-9_-]+$/.test(sessionID)) {
      try {
        const home = process.env.HOME
        if (home) {
          const dbPath = join(home, ".local", "share", "opencode", "opencode.db")
          if (existsSync(dbPath)) {
            const sql = `select directory from session where id='${sessionID}' limit 1;`
            const res = spawnSync("sqlite3", [dbPath, sql], {
              encoding: "utf8",
              timeout: 1500,
            })
            const dbCwd = (res.stdout ?? "").trim()
            if (dbCwd.length > 0) return dbCwd
          }
        }
      } catch {
        // Fallback below.
      }
    }

    // External providers on some OpenCode builds do not receive sessionID/cwd.
    // In desktop mode process.cwd() may be "/" even when a project session is open.
    // Use the most recently updated non-root session directory as a best-effort
    // fallback when cwd is root.
    const runtimeCwd = process.cwd()
    if (runtimeCwd === "/") {
      try {
        const home = process.env.HOME
        if (home) {
          const dbPath = join(home, ".local", "share", "opencode", "opencode.db")
          if (existsSync(dbPath)) {
            const nowMs = Date.now()
            const fiveMinAgo = nowMs - 5 * 60 * 1000
            const sql =
              "select directory from session " +
              "where directory != '/' and time_updated >= " +
              `${fiveMinAgo} ` +
              "order by time_updated desc limit 1;"
            const res = spawnSync("sqlite3", [dbPath, sql], {
              encoding: "utf8",
              timeout: 1500,
            })
            const recentDir = (res.stdout ?? "").trim()
            if (recentDir.length > 0) return recentDir
          }
        }
      } catch {
        // Fall through to runtime cwd.
      }
    }

    // Default: runtime cwd at call time.
    return runtimeCwd
  }

  async doGenerate(
    options: Parameters<LanguageModelV2["doGenerate"]>[0],
  ): Promise<Awaited<ReturnType<LanguageModelV2["doGenerate"]>>> {
    const warnings: LanguageModelV2CallWarning[] = []
    const cwd = this.resolveCwd(options as any)
    const sk = sessionKey(cwd, this.modelId)

    const hasPriorConversation =
      options.prompt.filter((m) => m.role === "user" || m.role === "assistant")
        .length > 1

    // New session — clear any stale state from a previous session
    if (!hasPriorConversation) {
      deleteClaudeSessionId(sk)
      deleteActiveProcess(sk)
    }

    const hasExistingSession = !!getClaudeSessionId(sk)
    const includeHistoryContext = !hasExistingSession && hasPriorConversation

    const userMsg = getClaudeUserMessage(options.prompt, includeHistoryContext)

    // doGenerate always spawns a fresh process, never reuse session ID
    const cliArgs = buildCliArgs({
      sessionKey: sk,
      skipPermissions: this.config.skipPermissions !== false,
      includeSessionId: false,
      model: this.modelId,
    })

    log.info("doGenerate starting", {
      cwd,
      model: this.modelId,
      textLength: userMsg.length,
      includeHistoryContext,
    })

    const { spawn } = await import("node:child_process")
    const { createInterface } = await import("node:readline")

    const proc = spawn(this.config.cliPath, cliArgs, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, TERM: "xterm-256color" },
    })

    const rl = createInterface({ input: proc.stdout! })

    let responseText = ""
    let thinkingText = ""
    let resultMeta: {
      sessionId?: string
      costUsd?: number
      durationMs?: number
      usage?: ClaudeStreamMessage["usage"]
    } = {}
    const toolCalls: Array<{ id: string; name: string; args: unknown }> = []

    const result = await new Promise<
      typeof resultMeta & {
        text: string
        thinking: string
        toolCalls: typeof toolCalls
      }
    >((resolve, reject) => {
      rl.on("line", (line) => {
        if (!line.trim()) return
        try {
          const msg: ClaudeStreamMessage = JSON.parse(line)

          if (msg.type === "system" && msg.subtype === "init") {
            if (msg.session_id) {
              setClaudeSessionId(sk, msg.session_id)
            }
          }

          if (msg.type === "assistant" && msg.message?.content) {
            for (const block of msg.message.content) {
              if (block.type === "text" && block.text) {
                responseText += block.text
              }
              if (block.type === "thinking" && block.thinking) {
                thinkingText += block.thinking
              }
              if (block.type === "tool_use" && block.id && block.name) {
                if (
                  block.name === "AskUserQuestion" ||
                  block.name === "ask_user_question"
                ) {
                  // Emit question as text
                  const parsedInput = (block.input ?? {}) as Record<
                    string,
                    unknown
                  >
                  const question =
                    (parsedInput?.question as string) || "Question?"
                  responseText += `\n\n_Asking: ${question}_\n\n`
                  continue
                }

                if (block.name === "ExitPlanMode") {
                  const parsedInput = (block.input ?? {}) as Record<
                    string,
                    unknown
                  >
                  const plan = (parsedInput?.plan as string) || ""
                  responseText += `\n\n${plan}\n\n---\n**Do you want to proceed with this plan?** (yes/no)\n`
                  continue
                }

                toolCalls.push({
                  id: block.id,
                  name: block.name,
                  args: block.input ?? {},
                })
              }
            }
          }

          if (msg.type === "content_block_start" && msg.content_block) {
            if (
              msg.content_block.type === "tool_use" &&
              msg.content_block.id &&
              msg.content_block.name
            ) {
              toolCalls.push({
                id: msg.content_block.id,
                name: msg.content_block.name,
                args: {},
              })
            }
          }

          if (msg.type === "content_block_delta" && msg.delta) {
            if (msg.delta.type === "text_delta" && msg.delta.text) {
              responseText += msg.delta.text
            }
            if (msg.delta.type === "thinking_delta" && msg.delta.thinking) {
              thinkingText += msg.delta.thinking
            }
            if (
              msg.delta.type === "input_json_delta" &&
              msg.delta.partial_json &&
              msg.index !== undefined
            ) {
              const tc = toolCalls[msg.index]
              if (tc) {
                try {
                  tc.args = JSON.parse(msg.delta.partial_json)
                } catch {
                  // Partial JSON, accumulate
                }
              }
            }
          }

          if (msg.type === "result") {
            if (msg.session_id) {
              setClaudeSessionId(sk, msg.session_id)
            }
            resultMeta = {
              sessionId: msg.session_id,
              costUsd: msg.total_cost_usd,
              durationMs: msg.duration_ms,
              usage: msg.usage,
            }
            resolve({
              ...resultMeta,
              text: responseText,
              thinking: thinkingText,
              toolCalls,
            })
          }
        } catch {
          // Ignore non-JSON lines
        }
      })

      rl.on("close", () => {
        resolve({
          ...resultMeta,
          text: responseText,
          thinking: thinkingText,
          toolCalls,
        })
      })

      proc.on("error", (err) => {
        log.error("process error", { error: err.message })
        reject(err)
      })

      proc.stderr?.on("data", (data: Buffer) => {
        log.debug("stderr", { data: data.toString().slice(0, 200) })
      })

      proc.stdin?.write(userMsg + "\n")
    })

    const content: LanguageModelV2Content[] = []

    if (result.thinking) {
      content.push({
        type: "reasoning",
        text: result.thinking,
      } as any)
    }

    if (result.text) {
      content.push({
        type: "text",
        text: result.text,
        providerMetadata: {
          "claude-code": {
            sessionId: result.sessionId ?? null,
            costUsd: result.costUsd ?? null,
            durationMs: result.durationMs ?? null,
          },
        },
      })
    }

    for (const tc of result.toolCalls) {
      const {
        name: mappedName,
        input: mappedInput,
        executed,
        skip,
      } = mapTool(tc.name, tc.args)
      if (skip) continue
      content.push({
        type: "tool-call",
        toolCallId: tc.id,
        toolName: mappedName,
        input: JSON.stringify(mappedInput),
        providerExecuted: executed,
      } as any)
    }

    const usage: LanguageModelV2Usage = {
      inputTokens: result.usage?.input_tokens,
      outputTokens: result.usage?.output_tokens,
      totalTokens:
        result.usage?.input_tokens && result.usage?.output_tokens
          ? result.usage.input_tokens + result.usage.output_tokens
          : undefined,
    }

    return {
      content,
      finishReason: (result.toolCalls.length > 0
        ? "tool-calls"
        : "stop") as LanguageModelV2FinishReason,
      usage,
      request: { body: { text: userMsg } },
      response: {
        id: result.sessionId ?? generateId(),
        timestamp: new Date(),
        modelId: this.modelId,
      },
      providerMetadata: {
        "claude-code": {
          sessionId: result.sessionId ?? null,
          costUsd: result.costUsd ?? null,
          durationMs: result.durationMs ?? null,
        },
      },
      warnings,
    }
  }

  async doStream(
    options: Parameters<LanguageModelV2["doStream"]>[0],
  ): Promise<Awaited<ReturnType<LanguageModelV2["doStream"]>>> {
    const warnings: LanguageModelV2CallWarning[] = []
    const cwd = this.resolveCwd(options as any)
    const cliPath = this.config.cliPath
    const skipPermissions = this.config.skipPermissions !== false
    const sk = sessionKey(cwd, this.modelId)

    const hasPriorConversation =
      options.prompt.filter((m) => m.role === "user" || m.role === "assistant")
        .length > 1

    // New session — clear any stale state from a previous session
    if (!hasPriorConversation) {
      deleteClaudeSessionId(sk)
      deleteActiveProcess(sk)
    }

    const hasExistingSession = !!getClaudeSessionId(sk)
    const hasActiveProcess = !!getActiveProcess(sk)
    const includeHistoryContext =
      !hasExistingSession && !hasActiveProcess && hasPriorConversation

    const userMsg = getClaudeUserMessage(options.prompt, includeHistoryContext)

    log.info("doStream starting", {
      cwd,
      model: this.modelId,
      textLength: userMsg.length,
      includeHistoryContext,
      hasActiveProcess,
      maxOutputTokens: (options as any)?.maxOutputTokens ?? null,
    })

    const cliArgs = buildCliArgs({
      sessionKey: sk,
      skipPermissions,
      model: this.modelId,
    })

    const stream = new ReadableStream<LanguageModelV2StreamPart>({
      start(controller) {
        let activeProcess = getActiveProcess(sk)
        let proc: import("child_process").ChildProcess
        let lineEmitter: import("events").EventEmitter

        if (activeProcess) {
          proc = activeProcess.proc
          lineEmitter = activeProcess.lineEmitter
          log.debug("reusing active process", { sk })
        } else {
          const ap = spawnClaudeProcess(cliPath, cliArgs, cwd, sk)
          proc = ap.proc
          lineEmitter = ap.lineEmitter
        }

        controller.enqueue({ type: "stream-start", warnings })

        const textId = generateId()
        let textStarted = false

        const reasoningIds = new Map<number, string>()
        const reasoningStarted = new Map<number, boolean>()

        let turnCompleted = false
        let controllerClosed = false

        const toolCallMap = new Map<
          number,
          { id: string; name: string; inputJson: string }
        >()
        const toolCallsById = new Map<
          string,
          { id: string; name: string; input: unknown }
        >()

        let resultMeta: {
          sessionId?: string
          costUsd?: number
          durationMs?: number
          usage?: ClaudeStreamMessage["usage"]
        } = {}

        const lineHandler = (line: string) => {
          if (!line.trim()) return
          if (controllerClosed) return

          try {
            const msg: ClaudeStreamMessage = JSON.parse(line)

            log.debug("stream message", {
              type: msg.type,
              subtype: msg.subtype,
            })

            // Handle system init
            if (msg.type === "system" && msg.subtype === "init") {
              if (msg.session_id) {
                setClaudeSessionId(sk, msg.session_id)
                log.info("session initialized", {
                  claudeSessionId: msg.session_id,
                })
              }
            }

            // content_block_start
            if (
              msg.type === "content_block_start" &&
              msg.content_block &&
              msg.index !== undefined
            ) {
              const block = msg.content_block
              const idx = msg.index

              if (block.type === "thinking") {
                const reasoningId = generateId()
                reasoningIds.set(idx, reasoningId)
                controller.enqueue({
                  type: "reasoning-start",
                  id: reasoningId,
                } as any)
                reasoningStarted.set(idx, true)
              }

              if (block.type === "text") {
                if (!textStarted) {
                  controller.enqueue({
                    type: "text-start",
                    id: textId,
                  } as any)
                  textStarted = true
                }
              }

              if (block.type === "tool_use" && block.id && block.name) {
                toolCallMap.set(idx, {
                  id: block.id,
                  name: block.name,
                  inputJson: "",
                })

                if (
                  block.name !== "AskUserQuestion" &&
                  block.name !== "ask_user_question" &&
                  block.name !== "ExitPlanMode"
                ) {
                  const { name: mappedName, skip } = mapTool(block.name)
                  if (!skip) {
                    controller.enqueue({
                      type: "tool-input-start",
                      id: block.id,
                      toolName: mappedName,
                    } as any)
                    log.info("tool started", {
                      name: block.name,
                      mappedName,
                      id: block.id,
                    })
                  }
                }
              }
            }

            // content_block_delta
            if (
              msg.type === "content_block_delta" &&
              msg.delta &&
              msg.index !== undefined
            ) {
              const delta = msg.delta
              const idx = msg.index

              if (delta.type === "thinking_delta" && delta.thinking) {
                const reasoningId = reasoningIds.get(idx)
                if (reasoningId) {
                  controller.enqueue({
                    type: "reasoning-delta",
                    id: reasoningId,
                    delta: delta.thinking,
                  } as any)
                }
              }

              if (delta.type === "text_delta" && delta.text) {
                if (!textStarted) {
                  controller.enqueue({
                    type: "text-start",
                    id: textId,
                  } as any)
                  textStarted = true
                }
                controller.enqueue({
                  type: "text-delta",
                  id: textId,
                  delta: delta.text,
                })
              }

              if (delta.type === "input_json_delta" && delta.partial_json) {
                const tc = toolCallMap.get(idx)
                if (tc) {
                  tc.inputJson += delta.partial_json
                  controller.enqueue({
                    type: "tool-input-delta",
                    id: tc.id,
                    delta: delta.partial_json,
                  } as any)
                }
              }
            }

            // content_block_stop
            if (
              msg.type === "content_block_stop" &&
              msg.index !== undefined
            ) {
              const idx = msg.index

              const reasoningId = reasoningIds.get(idx)
              if (reasoningId && reasoningStarted.get(idx)) {
                controller.enqueue({
                  type: "reasoning-end",
                  id: reasoningId,
                } as any)
                reasoningStarted.delete(idx)
              }

              const tc = toolCallMap.get(idx)
              if (tc) {
                let parsedInput: any = {}
                try {
                  parsedInput = JSON.parse(tc.inputJson || "{}")
                } catch {}

                if (
                  tc.name === "AskUserQuestion" ||
                  tc.name === "ask_user_question"
                ) {
                  // Emit question as text
                  let question = "Question?"
                  if (
                    parsedInput?.questions &&
                    Array.isArray(parsedInput.questions) &&
                    parsedInput.questions.length > 0
                  ) {
                    question =
                      parsedInput.questions[0].question ||
                      parsedInput.questions[0].text ||
                      "Question?"
                  } else {
                    question =
                      parsedInput?.question ||
                      parsedInput?.text ||
                      "Question?"
                  }

                  if (!textStarted) {
                    controller.enqueue({
                      type: "text-start",
                      id: textId,
                    } as any)
                    textStarted = true
                  }
                  controller.enqueue({
                    type: "text-delta",
                    id: textId,
                    delta: `\n\n_Asking: ${question}_\n\n`,
                  })
                } else if (tc.name === "ExitPlanMode") {
                  // Emit plan as text and ask user to accept/refuse
                  const plan = (parsedInput?.plan as string) || ""

                  if (!textStarted) {
                    controller.enqueue({
                      type: "text-start",
                      id: textId,
                    } as any)
                    textStarted = true
                  }
                  controller.enqueue({
                    type: "text-delta",
                    id: textId,
                    delta: `\n\n${plan}\n\n---\n**Do you want to proceed with this plan?** (yes/no)\n`,
                  })
                } else {
                  const {
                    name: mappedName,
                    input: mappedInput,
                    executed,
                    skip,
                  } = mapTool(tc.name, parsedInput)

                  if (!skip) {
                    toolCallsById.set(tc.id, {
                      id: tc.id,
                      name: tc.name,
                      input: parsedInput,
                    })

                    controller.enqueue({
                      type: "tool-call",
                      toolCallId: tc.id,
                      toolName: mappedName,
                      input: JSON.stringify(mappedInput),
                      providerExecuted: executed,
                    } as any)
                  }
                  log.info("tool call complete", {
                    name: tc.name,
                    mappedName,
                    id: tc.id,
                    executed,
                  })
                }
              }
            }

            // assistant message (complete, not streaming)
            if (msg.type === "assistant" && msg.message?.content) {
              for (const block of msg.message.content) {
                if (block.type === "text" && block.text) {
                  if (!textStarted) {
                    controller.enqueue({
                      type: "text-start",
                      id: textId,
                    } as any)
                    textStarted = true
                  }
                  controller.enqueue({
                    type: "text-delta",
                    id: textId,
                    delta: block.text,
                  })
                }

                if (block.type === "thinking" && block.thinking) {
                  const thinkingId = generateId()
                  controller.enqueue({
                    type: "reasoning-start",
                    id: thinkingId,
                  } as any)
                  controller.enqueue({
                    type: "reasoning-delta",
                    id: thinkingId,
                    delta: block.thinking,
                  } as any)
                  controller.enqueue({
                    type: "reasoning-end",
                    id: thinkingId,
                  } as any)
                }

                if (block.type === "tool_use" && block.id && block.name) {
                  const parsedInput = (block.input ?? {}) as Record<
                    string,
                    unknown
                  >
                  toolCallsById.set(block.id, {
                    id: block.id,
                    name: block.name,
                    input: parsedInput,
                  })

                  if (
                    block.name === "AskUserQuestion" ||
                    block.name === "ask_user_question"
                  ) {
                    let question = "Question?"
                    if (
                      parsedInput?.questions &&
                      Array.isArray(parsedInput.questions) &&
                      parsedInput.questions.length > 0
                    ) {
                      const q = parsedInput.questions[0] as any
                      question = q.question || q.text || "Question?"
                    } else {
                      question =
                        (parsedInput?.question as string) ||
                        (parsedInput?.text as string) ||
                        "Question?"
                    }

                    if (!textStarted) {
                      controller.enqueue({
                        type: "text-start",
                        id: textId,
                      } as any)
                      textStarted = true
                    }
                    controller.enqueue({
                      type: "text-delta",
                      id: textId,
                      delta: `\n\n_Asking: ${question}_\n\n`,
                    })
                  } else if (block.name === "ExitPlanMode") {
                    // Emit plan as text and ask user to accept/refuse
                    const plan = (parsedInput?.plan as string) || ""

                    if (!textStarted) {
                      controller.enqueue({
                        type: "text-start",
                        id: textId,
                      } as any)
                      textStarted = true
                    }
                    controller.enqueue({
                      type: "text-delta",
                      id: textId,
                      delta: `\n\n${plan}\n\n---\n**Do you want to proceed with this plan?** (yes/no)\n`,
                    })
                  } else {
                    const {
                      name: mappedName,
                      input: mappedInput,
                      executed,
                      skip,
                    } = mapTool(block.name, parsedInput)

                    if (!skip) {
                      controller.enqueue({
                        type: "tool-input-start",
                        id: block.id,
                        toolName: mappedName,
                      } as any)
                      controller.enqueue({
                        type: "tool-call",
                        toolCallId: block.id,
                        toolName: mappedName,
                        input: JSON.stringify(mappedInput),
                        providerExecuted: executed,
                      } as any)
                    }
                    log.info("tool_use from assistant message", {
                      name: block.name,
                      mappedName,
                      id: block.id,
                      executed,
                    })
                  }
                }

                if (block.type === "tool_result") {
                  log.debug("tool_result", {
                    toolUseId: block.tool_use_id,
                  })
                }
              }
            }

            // user message (tool results from Claude CLI)
            if (msg.type === "user" && msg.message?.content) {
              for (const block of msg.message.content) {
                if (block.type === "tool_result" && block.tool_use_id) {
                  const toolCall = toolCallsById.get(block.tool_use_id)
                  if (toolCall) {
                    let resultText = ""
                    if (typeof block.content === "string") {
                      resultText = block.content
                    } else if (Array.isArray(block.content)) {
                      resultText = block.content
                        .filter(
                          (
                            c,
                          ): c is { type: string; text: string } =>
                            c.type === "text" &&
                            typeof c.text === "string",
                        )
                        .map((c) => c.text)
                        .join("\n")
                    }

                    controller.enqueue({
                      type: "tool-result",
                      toolCallId: block.tool_use_id,
                      toolName: toolCall.name,
                      result: {
                        output: resultText,
                        title: toolCall.name,
                        metadata: {},
                      },
                      providerExecuted: true,
                    } as any)
                    log.info("tool result emitted", {
                      toolUseId: block.tool_use_id,
                      name: toolCall.name,
                    })
                    toolCallsById.delete(block.tool_use_id)
                  }
                }
              }
            }

            // result - end of conversation turn
            if (msg.type === "result") {
              if (msg.session_id) {
                setClaudeSessionId(sk, msg.session_id)
              }
              resultMeta = {
                sessionId: msg.session_id,
                costUsd: msg.total_cost_usd,
                durationMs: msg.duration_ms,
                usage: msg.usage,
              }

              log.info("conversation result", {
                sessionId: msg.session_id,
                durationMs: msg.duration_ms,
                numTurns: msg.num_turns,
                isError: msg.is_error,
              })

              turnCompleted = true

              if (textStarted) {
                controller.enqueue({ type: "text-end", id: textId })
              }

              for (const [idx, reasoningId] of reasoningIds) {
                if (reasoningStarted.get(idx)) {
                  controller.enqueue({
                    type: "reasoning-end",
                    id: reasoningId,
                  } as any)
                }
              }

              controller.enqueue({
                type: "finish",
                finishReason:
                  toolCallMap.size > 0 ? "tool-calls" : "stop",
                usage: {
                  inputTokens: msg.usage?.input_tokens,
                  outputTokens: msg.usage?.output_tokens,
                  totalTokens:
                    msg.usage?.input_tokens &&
                    msg.usage?.output_tokens
                      ? msg.usage.input_tokens +
                        msg.usage.output_tokens
                      : undefined,
                },
                providerMetadata: {
                  "claude-code": resultMeta,
                },
              })

              controllerClosed = true
              lineEmitter.off("line", lineHandler)
              lineEmitter.off("close", closeHandler)

              try {
                controller.close()
              } catch {}
            }
          } catch (e) {
            log.debug("failed to parse line", {
              error:
                e instanceof Error ? e.message : String(e),
            })
          }
        }

        const closeHandler = () => {
          log.debug("readline closed")
          if (controllerClosed) return
          controllerClosed = true
          lineEmitter.off("line", lineHandler)
          lineEmitter.off("close", closeHandler)
          if (textStarted) {
            controller.enqueue({ type: "text-end", id: textId })
          }
          controller.enqueue({
            type: "finish",
            finishReason: "stop",
            usage: {
              inputTokens: undefined,
              outputTokens: undefined,
              totalTokens: undefined,
            },
            providerMetadata: {
              "claude-code": resultMeta,
            },
          })
          try {
            controller.close()
          } catch {}
        }

        lineEmitter.on("line", lineHandler)
        lineEmitter.on("close", closeHandler)

        proc.on("error", (err: Error) => {
          log.error("process error", { error: err.message })
          if (controllerClosed) return
          controllerClosed = true
          controller.enqueue({ type: "error", error: err })
          try {
            controller.close()
          } catch {}
        })

        // On abort, keep process alive for next message
        if (options.abortSignal) {
          options.abortSignal.addEventListener("abort", () => {
            if (!turnCompleted) {
              log.info(
                "abort signal received mid-turn, keeping process alive",
                { cwd },
              )
            }
            if (!controllerClosed) {
              controllerClosed = true
              lineEmitter.off("line", lineHandler)
              lineEmitter.off("close", closeHandler)
              try {
                controller.close()
              } catch {}
            }
          })
        }

        // Send the user message
        proc.stdin?.write(userMsg + "\n")
        log.debug("sent user message", { textLength: userMsg.length })
      },
      cancel() {
        // Consumer cancelled the stream
      },
    })

    return {
      stream,
      request: { body: { text: userMsg } },
      response: { headers: {} },
    }
  }
}
