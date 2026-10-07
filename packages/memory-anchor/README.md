# @jacklika/dsh-memory-anchor

Keeps the memory discipline in front of the model for every prompt. The vault convention — search durable memory before acting, record durable conclusions afterward — lives in the `memory-vault` skill, but a skill only applies when the model chooses to load it. This plugin contributes a short always-on reminder as dynamic runtime context (`ctx.systemPrompt.context`), which the Harness re-renders into every prompt and keeps through compaction.

**Honest boundary**: DSH exposes no `turn/start` or `turn/end` hook, so this is a *reminder* layer only. It does not and cannot perform recall or capture automatically — nothing here intercepts a turn, searches the vault, or writes notes on its own.

## Configuration

```yaml
- name: '@jacklika/dsh-memory-anchor'
  config:
    contextName: 'memory-anchor:discipline'   # default
    order: 135                                # after Harness 110-120 and todo-anchor 130
    recallReminder: true                      # "search memory before acting" line
    captureReminder: true                     # "record conclusions afterward" line
    recallText: '...'                         # override either line entirely
    captureText: '...'
    vaultHint: true                           # allow the Vault sentence
```

- When both reminders are off the contribution renders as `''`, which the Harness drops entirely — no residue in the prompt.
- The Vault sentence ("The Vault is the persistent record of this workspace.") appears only when `vaultHint` is on **and** `wiki_write` or `memory_capture` is actually registered, so deployments without the memory suite never see a hint pointing at missing tools.
- The contribution unloads with the plugin's Loader fiber.
