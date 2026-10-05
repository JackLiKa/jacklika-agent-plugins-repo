import type { CatalogFailure, CatalogGroup, CatalogModel, Choice, Pane, Selection } from './types.ts'

export function compositeKey(providerId: string, modelId: string): string {
  return `${providerId}:${modelId}`
}

export function selectionFor(group: CatalogGroup, model: CatalogModel): Selection {
  return {
    provider: group.id,
    model: model.id,
    ...(model.reasoning?.defaultEffort === undefined ? {} : { reasoningEffort: model.reasoning.defaultEffort }),
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
  return choices.find(
    (choice) => choice.selection.provider === current.provider && choice.selection.model === current.model,
  )
}

export function isCurrentSelected(
  current: { provider: string; model: string } | null,
  providerId: string,
  modelId: string,
): boolean {
  return current !== null && current.provider === providerId && current.model === modelId
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
