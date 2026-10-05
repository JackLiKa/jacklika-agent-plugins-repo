import { ModelSelector } from './components/ModelSelector.tsx'
import { NS, en, zh } from './locale.ts'
import type { Selection } from './model/types.ts'

export const name = '@jacklika/dsh-model-selector-client'

export const inject = [
  'locale',
  'sessions',
  'slots',
  'modelDirectories',
]

export function apply(ctx: any): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), '@jacklika/dsh-model-selector: dictionaries')

  ctx.inject(['slots', 'modelDirectories', 'sessions'], (scope: any) => {
    const models: any = scope.modelDirectories
    const sessions: any = scope.sessions

    scope.slots.inject(
      'conversation.input.model',
      () =>
        scope.slots.register(
          {
            name: 'conversation.input.model',
            locale: NS,
            priority: -1,
            registrant: '@jacklika/dsh-model-selector',
            inject: (sessionId: string) => {
              const directory = models.directoryFor(sessionId)
              const available = sessions.subagentAddress(sessionId) === undefined
              return {
                available,
                directory: directory.store,
                load: () => {
                  if (available) directory.load().catch(() => {})
                },
                select: async (selection: Selection) => {
                  if (!available) return false
                  try {
                    await directory.select(selection)
                    return true
                  } catch {
                    return false
                  }
                },
              }
            },
          },
          ModelSelector,
        ),
    )
  })
}
