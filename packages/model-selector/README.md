# @jacklika/dsh-model-selector

Provider-first model selector for the DeepSeek Harness composer seat.

Replaces the default `conversation.input.model` slot with a three-level selector that keeps large catalogs readable:

1. **Root** – choose Model or Effort.
2. **Provider** – pick a provider, search providers, retry failed providers.
3. **Model** – see only that provider's models, grouped by family.

## How it works

The selector registers on the official slot `conversation.input.model` with `priority: -1`, so it shadows the default seat while the plugin is loaded. Removing the plugin restores the original selector automatically.

It reuses the harness's per-session `modelDirectories` service:

- Provider list, model groups, and reasoning efforts come from `directory.store`.
- Selections are submitted through `directory.select()` so routing, effort handling, and adapter defaults stay identical to the native selector.

## Model metadata

Models advertise their context window and cost in the `description` field (supplied by adapters such as `@jacklika/dsh-devin-connect`). The selector renders this metadata under each model name.

## Family grouping

Devin exposes many variants per model family (`SWE-2 High/Medium/Max`, `Claude Fable 5.1 Medium/Low/...`). The selector splits model names on the ` › ` separator and renders one header per family, so related variants stay together.

## Keyboard navigation

- `↑` / `↓` move focus through the current pane's rows.
- `Esc` walks back one level: model → provider → root → close.
- Clicking a provider/model also works with the mouse.
