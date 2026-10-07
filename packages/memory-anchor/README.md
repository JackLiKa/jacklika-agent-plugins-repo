# @jacklika/dsh-memory-anchor

Keeps the memory discipline in front of the model for every prompt. The vault convention — search durable memory before acting, record durable conclusions afterward — lives in the `memory-vault` skill, but a skill only applies when the model chooses to load it. This plugin contributes a short always-on reminder as dynamic runtime context (`ctx.systemPrompt.context`), which the Harness re-renders into every prompt and keeps through compaction.

**Honest boundary**: recall cannot be automated — nothing here searches the vault on the model's behalf. Capture CAN: the Harness publishes the session event feed (`session/event`, carrying `turn/start`, `tool/call`, `tool/result`, `assistant/message`, `turn/end`) as a Cordis event — the same feed `dsh-workspace-changes` uses. With `autoCapture` on (default), the plugin appends a mechanical per-turn summary through `wiki_write` when a turn ends. That summary is heuristic bookkeeping (tool names, short excerpts), not a model-curated note — durable conclusions still need an explicit `memory_capture`/`wiki_write`.

## Auto-capture

Each turn that did observable work appends a section to `<captureNotePrefix>-<sessionId>.md` (default `shared/notes/auto-capture-<id>.md`):

- idle turns (no tool calls, no messages) write nothing;
- a turn without a mounted `wiki_write` writes nothing;
- the note id is sanitized (`sess:abc/1` → `auto-capture-sess-abc-1`);
- write failures are logged and never thrown into the session feed.

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
    autoCapture: true                         # append per-turn summaries on turn/end
    captureNotePrefix: 'shared/notes/auto-capture'
    excerptChars: 200                         # per-message excerpt cap in summaries
```

- When both reminders are off the contribution renders as `''`, which the Harness drops entirely — no residue in the prompt.
- The Vault sentence ("The Vault is the persistent record of this workspace.") appears only when `vaultHint` is on **and** `wiki_write` or `memory_capture` is actually registered, so deployments without the memory suite never see a hint pointing at missing tools.
- The contribution and the `session/event` listener unload with the plugin's Loader fiber.
