/** Read-only model selection shared by preview and carrier recovery checks. */
export interface RedlineModelSelection {
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: string
}

export interface RedlineModelAgent {
  readonly options?: RedlineModelSelection & { readonly maxTokens?: number }
  readonly model?: { current(): RedlineModelSelection | undefined }
}

export function currentModelSelection(agent: RedlineModelAgent): RedlineModelSelection | undefined {
  // DSH records Session-local choices independently of startup options. An
  // unknown current choice must stay unknown; omitted effort means default,
  // not the effort left in startup options. Legacy adapters lack this face.
  return agent.model === undefined ? agent.options : agent.model.current()
}
