# @jacklika/dsh-model-selector

Provider-first model selector for the DeepSeek Harness composer seat.

Replaces the default `conversation.input.model` slot with a three-level selector:

1. **Root** – choose Model or Effort.
2. **Provider** – pick a provider, search providers, retry failed providers.
3. **Model** – see only that provider's models, grouped by family (e.g. `SWE-2`, `Claude Fable 5.1`), with context window and cost metadata shown under each model.

The selector reuses the harness `modelDirectories` service and `directory.select()` so selection semantics are unchanged.
