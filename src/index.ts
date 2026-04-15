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
  const cwd = settings.cwd ?? process.cwd()
  const providerName = settings.name ?? "claude-code"

  // Class uses specificationVersion "v3" at runtime but implements V2 interface for type compat.
  // AI SDK detects V3 at runtime and skips the V2->V3 conversion layer.
  const createModel = (modelId: string): LanguageModelV2 => {
    return new ClaudeCodeLanguageModel(modelId, {
      provider: providerName,
      cliPath,
      cwd,
      skipPermissions: settings.skipPermissions ?? true,
    }) as unknown as LanguageModelV2
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
