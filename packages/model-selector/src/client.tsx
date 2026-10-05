import { ModelSelector } from './components/ModelSelector.tsx'
import { NS, en, zh } from './locale.ts'
import type { Selection } from './model/types.ts'

export const name = '@jacklika/dsh-model-selector-client'

export const inject = [
  'locale',
  'sessions',
  'slots',
  'modelDirectories',
  'remote.session',
]

export function apply(ctx: any): void {
  ctx.effect(() => {
    const disposeDict = ctx.locale.register(NS, { zh, en })

    const models: any = ctx.modelDirectories
    const sessions: any = ctx.sessions

    const disposeSlot = ctx.slots.inject(
      'conversation.input.model',
      () =>
        ctx.slots.register(
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

    return () => {
      disposeSlot()
      disposeDict()
    }
  })
}
