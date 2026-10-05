import Schema from '@deepseek-ai/schemastery'

export const name = '@jacklika/dsh-model-selector'

export const inject: string[] = []

export const Config = Schema.object({}).default({})

export function apply(): void {
  // Pure client-surface plugin; all UI wiring lives in src/client.tsx.
}
