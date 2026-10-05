import type { CatalogFailure, CatalogGroup, CatalogModel, Choice, ModelParams, Pane, Selection } from './types.ts'

const PARAMS_SEP = '@@'

export function compositeKey(providerId: string, modelId: string): string {
  return `${providerId}:${modelId}`
}

export function encodeModelId(baseModelId: string, params: ModelParams = {}): string {
  const parts: string[] = []
  if (params.contextWindow !== undefined && !Number.isNaN(params.contextWindow)) {
    parts.push(`ctx=${params.contextWindow}`)
  }
  if (params.reasoningEffort !== undefined && params.reasoningEffort !== '') {
    parts.push(`effort=${encodeURIComponent(params.reasoningEffort)}`)
  }
  if (params.maxTokens !== undefined && !Number.isNaN(params.maxTokens)) {
    parts.push(`max=${params.maxTokens}`)
  }
  if (parts.length === 0) return baseModelId
  return `${baseModelId}${PARAMS_SEP}${parts.join('&')}`
}

export function decodeModelId(compositeId: string): { baseModelId: string; params: ModelParams } {
  const idx = compositeId.indexOf(PARAMS_SEP)
  if (idx < 0) return { baseModelId: compositeId, params: {} }
  const baseModelId = compositeId.slice(0, idx)
  const params: ModelParams = {}
  const query = compositeId.slice(idx + PARAMS_SEP.length)
  for (const part of query.split('&')) {
    const [key, value] = part.split('=')
    if (value === undefined) continue
    const decoded = decodeURIComponent(value)
    if (key === 'ctx') params.contextWindow = Number(decoded)
    if (key === 'effort') params.reasoningEffort = decoded
    if (key === 'max') params.maxTokens = Number(decoded)
  }
  return { baseModelId, params }
}

export function selectionFor(group: CatalogGroup, model: CatalogModel, params: ModelParams = {}): Selection {
  const supported = model.reasoning?.efforts ?? []
  const chosen = params.reasoningEffort ?? model.reasoning?.defaultEffort
  const reasoningEffort = supported.some((effort) => effort.id === chosen)
    ? chosen
    : model.reasoning?.defaultEffort
  return {
    provider: group.id,
    model: model.id,
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
  }
}

export function sortGroupsForCurrent(groups: CatalogGroup[], currentId: string | undefined): CatalogGroup[] {
  if (currentId === undefined) return groups
  return [...groups].sort((a, b) => {
    if (a.id === currentId) return -1
    if (b.id === currentId) return 1
    return 0
  })
}

export function findCurrentChoice(choices: Choice[], current: { provider: string; model: string } | null): Choice | undefined {
  if (current === null) return undefined
  const decoded = decodeModelId(current.model)
  return choices.find((choice) => {
    const choiceBase = decodeModelId(choice.selection.model).baseModelId
    return (
      choice.selection.provider === current.provider && choiceBase === decoded.baseModelId
    )
  })
}

export function isCurrentSelected(
  current: { provider: string; model: string } | null,
  providerId: string,
  modelId: string,
): boolean {
  if (current === null) return false
  const decoded = decodeModelId(current.model)
  return current.provider === providerId && decoded.baseModelId === modelId
}

export function matchesQuery(text: string | undefined, query: string): boolean {
  const q = query.trim().toLowerCase()
  return q === '' || (text !== undefined && text.toLowerCase().includes(q))
}

export function filterGroupsByQuery(groups: CatalogGroup[], query: string): CatalogGroup[] {
  return groups.filter((group) => matchesQuery(group.name, query) || matchesQuery(group.id, query))
}

export function filterModelsByQuery(models: CatalogModel[], query: string): CatalogModel[] {
  return models.filter(
    (model) =>
      matchesQuery(model.name, query) || matchesQuery(model.id, query) || matchesQuery(model.description, query),
  )
}

export function filterFailuresByQuery(failures: CatalogFailure[], query: string): CatalogFailure[] {
  return failures.filter((failure) => matchesQuery(failure.name, query) || matchesQuery(failure.id, query))
}

export function nextPaneOnEscape(pane: Pane): Pane | 'close' {
  switch (pane) {
    case 'model':
      return 'provider'
    case 'provider':
    case 'effort':
      return 'root'
    default:
      return 'close'
  }
}
