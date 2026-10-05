export interface ReasoningLevel {
  id: string
  name: string
  description?: string
}

export interface CatalogModel {
  id: string
  name: string
  description?: string
  reasoning?: {
    defaultEffort?: string
    efforts: ReasoningLevel[]
  }
}

export interface CatalogGroup {
  id: string
  name: string
  models: CatalogModel[]
}

export interface CatalogFailure {
  id: string
  name: string
  message: string
}

export interface DirectorySnapshot {
  current: { provider: string; model: string; reasoningEffort?: string } | null
  routable: boolean | null
  groups: CatalogGroup[]
  failures: CatalogFailure[]
  status: 'idle' | 'loading' | 'selecting' | 'ready' | 'error'
  error: string | null
}

export interface DirectoryStore {
  subscribe(fn: () => void): () => void
  getSnapshot(): DirectorySnapshot
}

export interface Selection {
  provider: string
  model: string
  reasoningEffort?: string
}

export type Pane = 'root' | 'provider' | 'model' | 'effort'

export interface Choice {
  group: CatalogGroup
  model: CatalogModel
  selection: Selection
}

export interface EffortChoice {
  key: string
  effort?: string
  label: string
  description?: string
}

export interface ModelProviderSelectProps {
  locked: boolean
  available: boolean
  directory: DirectoryStore
  load: () => void
  select: (selection: Selection) => Promise<boolean>
  t: (key: string, params?: Record<string, unknown>) => string
}
