import type { LanguageModelV2, ProviderV2 } from "@ai-sdk/provider"
import { ClaudeCodeLanguageModel } from "./claude-code-language-model.js"
import type { ClaudeCodeProviderSettings } from "./types.js"

export interface ClaudeCodeProvider extends ProviderV2 {
  (modelId: string): LanguageModelV2
  languageModel(modelId: string): LanguageModelV2
}

export function createClaudeCode(
  settings: ClaudeCodeProviderSettings = {},
): ClaudeCodeProvider {
  const cliPath =
    settings.cliPath ?? process.env.CLAUDE_CLI_PATH ?? "claude"
  const providerName = settings.name ?? "claude-code"

  const createModel = (modelId: string): LanguageModelV2 => {
    return new ClaudeCodeLanguageModel(modelId, {
      provider: providerName,
      cliPath,
      // Keep undefined unless explicitly configured.
      // The model resolves cwd lazily per request so it tracks the active
      // OpenCode project directory instead of provider init-time process cwd.
      cwd: settings.cwd,
      skipPermissions: settings.skipPermissions ?? true,
    })
  }

  const provider = function (modelId: string) {
    return createModel(modelId)
  } as ClaudeCodeProvider

  provider.languageModel = createModel

  return provider
}

export { ClaudeCodeLanguageModel } from "./claude-code-language-model.js"
export type {
  ClaudeCodeConfig,
  ClaudeCodeProviderSettings,
  ClaudeStreamMessage,
} from "./types.js"
