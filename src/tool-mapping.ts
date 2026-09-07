import { log } from "./logger.js"
import { applyTaskCreateToolUse, applyTaskUpdate, type TodoEntry } from "./todo-ledger.js"
import type { WebSearchRouting } from "./types.js"

export interface MapToolOptions {
  webSearch?: WebSearchRouting
  sessionId?: string
  toolUseId?: string
}

/** Claude CLI's built-in web search tool (name varies by CLI version). */
export function isWebSearchTool(name: string): boolean {
  return name === "WebSearch" || name === "web_search"
}

/**
 * True when WebSearch runs inside Claude CLI (default) rather than being
 * forwarded to an opencode tool. In that case the tool-call part must not
 * reach opencode — "WebSearch" has no registry entry there and renders as
 * an invalid tool row. Callers show the query as a text line instead.
 */
export function isWebSearchHandledByCli(route?: WebSearchRouting): boolean {
  return !route || route === "claude" || route === "disabled"
}

/**
 * Map Claude CLI tool input (snake_case) to OpenCode tool input (camelCase)
 */
function mapToolInput(name: string, input: any): any {
  if (!input) return input

  switch (name) {
    case "Write":
      return {
        filePath: input.file_path ?? input.filePath,
        content: input.content,
      }
    case "Edit":
      return {
        filePath: input.file_path ?? input.filePath,
        oldString: input.old_string ?? input.oldString,
        newString: input.new_string ?? input.newString,
        replaceAll: input.replace_all ?? input.replaceAll,
      }
    case "Read":
      return {
        filePath: input.file_path ?? input.filePath,
        offset: input.offset,
        limit: input.limit,
      }
    case "Bash":
      return {
        command: input.command,
        description:
          input.description ||
          `Execute: ${String(input.command || "").slice(0, 50)}${String(input.command || "").length > 50 ? "..." : ""}`,
        timeout: input.timeout,
      }
    case "NotebookEdit":
      return {
        notebookPath: input.notebook_path ?? input.notebookPath,
        cellNumber: input.cell_number ?? input.cellNumber,
        newSource: input.new_source ?? input.newSource,
        cellType: input.cell_type ?? input.cellType,
        editMode: input.edit_mode ?? input.editMode,
      }
    case "Glob":
      return {
        pattern: input.pattern,
        path: input.path,
      }
    case "Grep":
      return {
        pattern: input.pattern,
        path: input.path,
        include: input.include,
      }
    case "TodoWrite":
      if (Array.isArray(input.todos)) {
        const mappedTodos = input.todos.map((todo: any, index: number) => ({
          content: todo.content,
          status: todo.status || "pending",
          priority: todo.priority || "medium",
          id: todo.id || `todo_${Date.now()}_${index}`,
        }))
        return { todos: mappedTodos }
      }
      return input
    default:
      return input
  }
}

// Tools that Claude CLI executes internally but we report to opencode for UI display
const OPENCODE_HANDLED_TOOLS = new Set([
  "Edit",
  "Write",
  "Bash",
  "NotebookEdit",
  "Read",
  "Glob",
  "Grep",
])

// Claude CLI internal tools that should not be forwarded to opencode.
// These are part of Claude Code's own system and have no opencode equivalent.
// Tools the Claude CLI emits for its own internal bookkeeping (sub-agents,
// task tracking, search). opencode has no matching tool registry entry, so
// forwarding them surfaces as `⚙ invalid` rows in the UI. Skip them.
// TaskOutput is intentionally NOT here — it has an explicit bash-echo mapping
// below so the result stays visible.
const CLAUDE_INTERNAL_TOOLS = new Set([
  "ToolSearch",
  "Agent",
  "AskFollowupQuestion",
  "TaskList",
  "TaskGet",
  "TaskStop",
])

/**
 * Wrap model-controlled text as one shell single-quoted word.
 *
 * `TaskOutput` is displayed by running a real `bash` call, so its payload
 * reaches a shell. Double quotes are not enough: inside them `$(…)`,
 * backticks and `${…}` still expand, so `TaskOutput({content: "X$(id -u)Y"})`
 * executed `id` while the operator saw a command that read like a print
 * (issue #27). Single quotes suppress every expansion; the only character
 * needing care is `'` itself, closed and reopened around an escaped one.
 */
export function singleQuoteForShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function emitTodoWrite(todos: TodoEntry[]) {
  return {
    name: "todowrite",
    input: {
      todos: todos.map((todo) => ({
        id: todo.id,
        content: todo.content,
        status: todo.status,
        priority: "medium",
      })),
    },
    executed: false,
  }
}

export function mapTool(
  name: string,
  input?: any,
  opts?: MapToolOptions,
): { name: string; input?: any; executed: boolean; skip?: boolean } {
  // Claude CLI internal tools — skip entirely
  if (CLAUDE_INTERNAL_TOOLS.has(name)) {
    log.debug("skipping Claude CLI internal tool", { name })
    return { name, input, executed: true, skip: true }
  }

  // TaskCreate: stash subject keyed by tool_use_id; emission happens on tool_result.
  // Without sessionId+toolUseId we cannot maintain the ledger, so fall back to skip
  // (preserves old behavior for callers that haven't been threaded yet).
  if (name === "TaskCreate") {
    if (opts?.sessionId && opts?.toolUseId) {
      applyTaskCreateToolUse(opts.sessionId, opts.toolUseId, input)
    }
    return { name, input, executed: true, skip: true }
  }

  // TaskUpdate: mutate ledger and emit full list as opencode todowrite. Without
  // sessionId, fall back to skip. Unknown task ids return null from the ledger
  // and we drop the event.
  if (name === "TaskUpdate") {
    if (opts?.sessionId) {
      const list = applyTaskUpdate(opts.sessionId, input)
      if (list !== null) return emitTodoWrite(list)
    }
    return { name, input, executed: true, skip: true }
  }

  // Plan mode tools
  if (name === "EnterPlanMode") return { name: "plan_enter", input: {}, executed: false }
  if (name === "ExitPlanMode") return { name: "plan_exit", input, executed: false }

  // TodoWrite needs opencode to run it locally so Todo.Service (and the UI
  // widget backed by it) gets populated. Reporting as provider-executed would
  // short-circuit opencode's own execute and leave the todo panel empty.
  if (name === "TodoWrite") {
    const mappedInput = mapToolInput(name, input)
    return { name: "todowrite", input: mappedInput, executed: false }
  }

  // WebSearch — routing controlled by config.webSearch
  if (isWebSearchTool(name)) {
    const mappedInput = input?.query ? { query: input.query } : input
    const route = opts?.webSearch
    if (route && route !== "claude" && route !== "disabled") {
      log.debug("routing WebSearch to opencode tool", { target: route, mappedInput })
      return { name: route, input: mappedInput, executed: false }
    }
    // Claude CLI runs WebSearch internally; "WebSearch" has no opencode
    // registry entry, so forwarding the tool-call part surfaces a
    // "Model tried to call unavailable tool" invalid row in opencode.
    // Skip the part — callers render the query as a text line instead.
    log.debug("WebSearch executed by Claude CLI", { mappedInput })
    return { name: "WebSearch", input: mappedInput, executed: true, skip: true }
  }

  // TaskOutput -> bash printf
  if (name === "TaskOutput") {
    if (!input) return { name: "bash", executed: false }
    const output = input?.content || input?.output || JSON.stringify(input)
    return {
      name: "bash",
      input: {
        command: `printf '%s\\n' ${singleQuoteForShell(`TASK OUTPUT: ${String(output)}`)}`,
        description: "Displaying task output",
      },
      executed: false,
    }
  }

  // Third-party MCP tools: mcp__<server>__<tool> -> <server>_<tool>.
  // Marked provider-executed because Claude CLI runs these internally via
  // its own --mcp-config; the tool-result is already in the stream. If we
  // reported executed:false, opencode would look up the tool in its own
  // registry, fail to find it, and emit an `invalid` tool error that
  // shadows the real result.
  //
  // Our own proxy tools (`mcp__opencode_proxy__*`) are filtered out by
  // callers before reaching here, so this branch only ever sees user MCP
  // servers configured in Claude CLI's settings.
  if (name.startsWith("mcp__")) {
    const parts = name.slice(5).split("__")
    if (parts.length >= 2) {
      const serverName = parts[0]
      const toolName = parts.slice(1).join("_")
      const openCodeName = `${serverName}_${toolName}`
      log.debug("mapping MCP tool", { original: name, mapped: openCodeName })
      return { name: openCodeName, input, executed: true }
    }
  }

  // Tools executed by Claude CLI internally - map to lowercase for opencode
  if (OPENCODE_HANDLED_TOOLS.has(name)) {
    const mappedInput = mapToolInput(name, input)
    const openCodeName = name.toLowerCase()
    log.debug("mapping CLI-executed tool", { name, openCodeName })
    return { name: openCodeName, input: mappedInput, executed: true }
  }

  // Unknown tools - treated as provider-executed
  return { name, input, executed: true }
}
