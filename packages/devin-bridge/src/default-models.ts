import type { DevinCatalogModel } from "./adapter/devin.ts";

/**
 * The Devin model catalog this package ships as the `Config.models` default.
 *
 * Generated from one live `DevinAdapter.fetchModelCatalog()` response and
 * family-merged exactly the way `discoverModels()` merges: one entry per
 * model family, preferring the promo variant, with the legacy `MODEL_*`
 * aliases dropped. Every id is a `chatModelUid` the endpoint accepted at
 * generation time — unlike the ids `discoverModels()` derives, which strip
 * the effort suffix and are therefore not all addressable.
 *
 * The provider catalog drifts: regenerate against a live account when a model
 * is missing or an id stops resolving. A profile patch that sets `models`
 * replaces this list wholesale.
 */
export const DEFAULT_MODELS: readonly DevinCatalogModel[] = [
  { id: "claude-opus-5-5-medium", name: "Claude Opus 5.5 Medium (80x)", contextWindow: 1000000, supportsImages: true },
  { id: "claude-fable-5-1-medium", name: "Claude Fable 5.1 Medium (175x)", contextWindow: 1000000, supportsImages: true },
  { id: "claude-sonnet-5-5-medium", name: "Claude Sonnet 5.5 Medium (15x)", contextWindow: 1000000, supportsImages: true },
  { id: "gemini-3-8-flash-medium", name: "Gemini 3.8 Flash Medium [Promo] (8x)", contextWindow: 1048576, supportsImages: true },
  { id: "gpt-6-astra-medium", name: "GPT-6 Astra Medium Thinking (200x)", contextWindow: 1000000, supportsImages: true },
  { id: "gpt-6-sol-medium", name: "GPT-6 Sol Medium Thinking (50x)", contextWindow: 1000000, supportsImages: true },
  { id: "gpt-6-luna-medium", name: "GPT-6 Luna Medium Thinking (5x)", contextWindow: 1000000, supportsImages: true },
  { id: "glm-5-2", name: "GLM-5.2 High (1.5x)", contextWindow: 200000 },
  { id: "kimi-k3-high", name: "Kimi K3 High (6x)", contextWindow: 1048576, supportsImages: true },
  { id: "glm-5-3-low", name: "GLM-5.3 Low (1x)", contextWindow: 1048576 },
  { id: "swe-1-7-lightning", name: "SWE-1.7 Lightning Max (18x)", contextWindow: 202752, supportsImages: true },
  { id: "swe-2-high", name: "SWE-2 High [Promo] (9x)", contextWindow: 262000, supportsImages: true },
  { id: "claude-opus-4-7-medium", name: "Claude Opus 4.7 Medium (40x)", contextWindow: 1000000, supportsImages: true },
  { id: "claude-opus-4-8-medium", name: "Claude Opus 4.8 Medium (25x)", contextWindow: 1000000, supportsImages: true },
  { id: "claude-opus-5-medium", name: "Claude Opus 5 Medium (80x)", contextWindow: 1000000, supportsImages: true },
  { id: "claude-5-fable-low", name: "Claude Fable 5 Low (40x)", contextWindow: 1000000, supportsImages: true },
  { id: "claude-sonnet-5-low", name: "Claude Sonnet 5 Low (12x)", contextWindow: 1000000, supportsImages: true },
  { id: "gemini-3-5-flash-minimal", name: "Gemini 3.5 Flash Minimal (2x)", contextWindow: 1048576, supportsImages: true },
  { id: "gemini-3-6-flash-minimal", name: "Gemini 3.6 Flash Minimal (2x)", contextWindow: 1048576, supportsImages: true },
  { id: "gemini-3-7-flash-low", name: "Gemini 3.7 Flash Low [Promo] (6x)", contextWindow: 1048576, supportsImages: true },
  { id: "gpt-5-6-sol-none", name: "GPT-5.6 Sol No Thinking (10x)", contextWindow: 1000000, supportsImages: true },
  { id: "gpt-5-6-terra-none", name: "GPT-5.6 Terra No Thinking (4x)", contextWindow: 1000000, supportsImages: true },
  { id: "gpt-5-6-luna-none", name: "GPT-5.6 Luna No Thinking (3x)", contextWindow: 1000000, supportsImages: true },
  { id: "gpt-6-1-sol-low", name: "GPT-6.1 Sol Low Thinking (30x)", contextWindow: 1000000, supportsImages: true },
  { id: "grok-4-5-low", name: "Grok 4.5 Low (5x)", contextWindow: 500000, supportsImages: true },
  { id: "grok-4-6-low", name: "Grok 4.6 Low (10x)", contextWindow: 500000, supportsImages: true },
  { id: "grok-4-7-low", name: "Grok 4.7 Low (15x)", contextWindow: 500000, supportsImages: true },
  { id: "inkling-none", name: "Inkling None (2x)", contextWindow: 1048576 },
  { id: "glm-5-3-flash-low", name: "GLM-5.3 Flash Low (1x)", contextWindow: 1000000, supportsImages: true },
  { id: "deepseek-v4-flash-high", name: "DeepSeek V4 Flash High (0.5x)", contextWindow: 1048576 },
  { id: "deepseek-v4-1-flash-high", name: "DeepSeek V4.1 Flash High (2x)", contextWindow: 1048576, supportsImages: true },
  { id: "swe-1-7", name: "SWE-1.7 Max (9x)", contextWindow: 262000, supportsImages: true },
  { id: "claude-opus-4-6", name: "Claude Opus 4.6 (6x)", contextWindow: 200000, supportsImages: true },
  { id: "gpt-5-4-none", name: "GPT-5.4 No Thinking (1.5x)", contextWindow: 272000, supportsImages: true },
  { id: "gpt-5-5-none", name: "GPT-5.5 No Thinking (9x)", contextWindow: 272000, supportsImages: true },
  { id: "gpt-5-4-mini-low", name: "GPT-5.4 Mini Low Thinking (1.5x)", contextWindow: 400000, supportsImages: true },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (4x)", contextWindow: 200000, supportsImages: true },
  { id: "gpt-5-3-codex-low", name: "GPT-5.3-Codex Low (1.5x)", contextWindow: 400000, supportsImages: true },
  { id: "kimi-k2-6", name: "Kimi K2.6 (1x)", contextWindow: 262144, supportsImages: true },
  { id: "kimi-k2-7", name: "Kimi K2.7 (1x)", contextWindow: 262144, supportsImages: true },
  { id: "nemotron-3-ultra-none", name: "Nemotron 3 Ultra None (1x)", contextWindow: 1000000 },
  { id: "swe-1-6", name: "SWE-1.6 (3x)", contextWindow: 200000, supportsImages: true },
  { id: "swe-1-6-fast", name: "SWE-1.6 Fast (3x)", contextWindow: 200000, supportsImages: true },
  { id: "gemini-3-1-pro-low", name: "Gemini 3.1 Pro Low Thinking (1x)", contextWindow: 1048576, supportsImages: true },
  { id: "deepseek-v4-pro-high", name: "DeepSeek V4 Pro High (3x)", contextWindow: 1048576 },
]
