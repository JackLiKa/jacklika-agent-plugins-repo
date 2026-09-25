import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as MemoryQueue from '../packages/memory-queue/lib/index.js'
import * as MemoryFilesystem from '../packages/tool-memory-filesystem/lib/index.js'

const [mode, vault, marker] = process.argv.slice(2)
const ctx = new Context()
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRuntime)
await ctx.plugin(MemoryQueue, {
  toolNames: mode === 'hold' ? ['slow_tool'] : ['wiki_write'],
  vaultRoot: vault,
  crossProcessLock: true,
  laneArgument: 'id',
  lockStaleMs: 600,
  lockHeartbeatMs: 100,
  lockTimeoutMs: 5000,
  lockRetryMs: 50,
})
if (mode === 'hold') {
  ctx.tools.register(defineTool({
    name: 'slow_tool',
    description: 'Hold the queue lock until the parent terminates this worker.',
    parameters: { id: { type: 'string', required: true, description: 'Lock lane.' } },
    output: { schema: { type: 'json' }, render: () => [] },
    async execute() {
      await new Promise(resolve => setTimeout(resolve, 30000))
      return {}
    },
  }))
} else {
  await ctx.plugin(MemoryFilesystem, { vaultRoot: vault })
}
const result = await ctx.tools.execute({
  signal: new AbortController().signal,
  callId: ToolCallId(`${mode}-${marker}`),
  name: mode === 'hold' ? 'slow_tool' : 'wiki_write',
  arguments: mode === 'hold' ? { id: 'shared/concurrent.md' } : { id: 'shared/concurrent.md', content: marker },
})
await ctx.fiber.dispose()
if (result.isError) process.exitCode = 1
