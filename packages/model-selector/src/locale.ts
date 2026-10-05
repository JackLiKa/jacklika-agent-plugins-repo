export const NS = 'modelSelector'

export const en = {
  trigger: {
    fallback: 'Select model',
    selectAria: 'Select model',
    aria: 'Current model: {{model}} from {{provider}}',
    ariaEffort: 'Current model: {{model}} from {{provider}}, effort {{effort}}',
  },
  root: {
    model: 'Model',
    effort: 'Effort',
  },
  provider: {
    back: 'Back',
    title: 'Select provider',
    current: 'current',
    models: '{{count}} models',
    failed: 'failed',
    retry: 'Retry',
  },
  model: {
    back: 'Back',
    models: '{{count}} models',
    searchPlaceholder: 'Search models...',
  },
  effort: {
    title: 'Select effort',
    providerDefault: 'Provider default',
    back: 'Back',
  },
  status: {
    loading: 'Loading models...',
  },
  error: {
    action: 'Failed: {{message}}',
  },
  retry: 'Retry',
  mode: {
    original: 'Original',
    replica: 'Replica',
  },
  popup: {
    title: 'Model selector',
  },
  original: {
    search: 'Search models...',
    empty: 'No models found.',
  },
  devin: {
    search: 'Search all models',
    empty: 'No models found.',
    contextWindow: 'Context',
    reasoningEffort: 'Effort',
  },
  qoder: {
    search: 'Search models...',
    empty: 'No models found.',
    discount: 'Off-peak discount starts in',
    contextWindow: 'Context',
    reasoningEffort: 'Thinking',
  },
  replica: {
    empty: 'No providers available.',
  },
}

export const zh = {
  trigger: {
    fallback: '选择模型',
    selectAria: '选择模型',
    aria: '当前模型：{{model}} · {{provider}}',
    ariaEffort: '当前模型：{{model}} · {{provider}} · 推理等级 {{effort}}',
  },
  root: {
    model: '模型',
    effort: '推理等级',
  },
  provider: {
    back: '返回',
    title: '选择供应商',
    current: '当前',
    models: '{{count}} 个模型',
    failed: '加载失败',
    retry: '重试',
  },
  model: {
    back: '返回',
    models: '{{count}} 个模型',
    searchPlaceholder: '搜索模型...',
  },
  effort: {
    title: '选择推理等级',
    providerDefault: '供应商默认',
    back: '返回',
  },
  status: {
    loading: '加载模型中...',
  },
  error: {
    action: '失败：{{message}}',
  },
  retry: '重试',
  mode: {
    original: '原版',
    replica: '复刻',
  },
  popup: {
    title: '模型选择器',
  },
  original: {
    search: '搜索模型...',
    empty: '未找到模型。',
  },
  devin: {
    search: '搜索所有模型',
    empty: '未找到模型。',
    contextWindow: '上下文窗口',
    reasoningEffort: '推理等级',
  },
  qoder: {
    search: '搜索模型...',
    empty: '未找到模型。',
    discount: '错峰折扣将于',
    contextWindow: '上下文窗口',
    reasoningEffort: '思考模式',
  },
  replica: {
    empty: '没有可用的供应商。',
  },
}
