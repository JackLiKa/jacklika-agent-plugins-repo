# @jacklika/dsh-model-selector

Custom model selector for the DeepSeek Harness composer seat.

Replaces the default `conversation.input.model` slot with a popup that offers two modes:

- **Original** – a compact, provider-grouped list that mirrors the native selector style.
- **Replica** – a provider-specific replica of the Devin or Qoder native model picker, including parameter controls for context window and reasoning effort.

The last mode is remembered with `localStorage`; the default mode is **Original**.

## How it works

The selector registers on the official slot `conversation.input.model` with `priority: -1`, so it shadows the default seat while the plugin is loaded. Removing the plugin restores the original selector automatically.

It reuses the harness's per-session `modelDirectories` service:

- Provider list, model groups, and reasoning efforts come from `directory.store`.
- Selections are submitted through `directory.select()` so routing stays identical to the native selector.

## Parameters

In **Replica** mode, Devin and Qoder panes expose two parameter rows:

- **Context window** – 200K, 400K, or 1M tokens.
- **Reasoning effort / Thinking mode** – low, medium, high, xhigh, max.

Selected parameters are encoded into the model id as `model-id@@ctx=<tokens>&effort=<level>`. The Devin and Qoder adapters decode this id and pass the values to their respective CLIs:

- `--max-output-tokens <tokens>`
- `--reasoning-effort <level>`

## UI theming

The popup follows the OS color scheme (`prefers-color-scheme`) via CSS variables, so it renders correctly in both light and dark DeepSeek Harness themes.

## Keyboard navigation

- `Esc` closes the popup.
- Mouse/touch selection is fully supported.
