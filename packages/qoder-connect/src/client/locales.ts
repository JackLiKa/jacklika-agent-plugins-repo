import type {} from '@deepseek-ai/dsh-client-locale'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { BuiltInLocaleId } from '@deepseek-ai/dsh-client-locale'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    qoder: QoderLocaleKey
  }
}

export type QoderLocaleKey =
  | 'title'
  | 'titleAI'
  | 'intro'
  | 'introAI'
  | 'signIn'
  | 'signOut'
  | 'patLabel'
  | 'patPlaceholder'
  | 'patPlaceholderAI'
  | 'patGuide'
  | 'patGuideAI'
  | 'savePat'
  | 'clearPat'
  | 'refresh'
  | 'loading'
  | 'signedOut'
  | 'signedOutHint'
  | 'signedOutHintAI'
  | 'signedInAs'
  | 'invalidPat'
  | 'credits'
  | 'remaining'
  | 'total'
  | 'expires'
  | 'models'
  | 'cnRegion'
  | 'globalRegion'
  | 'variantTabCN'
  | 'variantTabGlobal'
  | 'accountHeading'
  | 'patReplace'
  | 'patClear'
  | 'patClearing'
  | 'refreshing'
  | 'patSave'
  | 'patSaving'
  | 'patSaved'
  | 'patSaveFailed'
  | 'patInvalid'
  | 'cancel'
  | 'patHeading'
  | 'statusResponseInvalid'
  | 'statusRefreshFailed'
  | 'catalogLive'
  | 'catalogSaved'
  | 'catalogFallback'
  | 'catalogError'
  | 'refreshModels'
  | 'refreshingModels'
  | 'tabStatus'
  | 'tabContext'
  | 'tabModels'
  | 'tabDetails'
  | 'tabCheckIn'
  | 'creditsHeading'
  | 'creditsUsed'
  | 'creditsTotalUnlimited'
  | 'cycleResetAt'
  | 'creditsError'
  | 'creditsDetailHeading'
  | 'expand'
  | 'collapse'
  | 'totalCredits'
  | 'noModels'

export const QODER_LOCALES: Record<BuiltInLocaleId, Record<QoderLocaleKey, string>> = {
  en: {
    title: 'Qoder',
    titleAI: 'Qoder AI',
    intro: 'Qoder domestic cloud models',
    introAI: 'Qoder global cloud models',
    signIn: 'Sign in',
    signOut: 'Clear token',
    patLabel: 'Personal access token',
    patPlaceholder: 'Paste your Qoder PAT',
    patPlaceholderAI: 'Paste your Qoder Global PAT',
    patGuide: 'Enter your Qoder PAT to enable the domestic provider.',
    patGuideAI: 'Enter your Qoder Global PAT to enable the global provider.',
    savePat: 'Save',
    clearPat: 'Clear',
    refresh: 'Refresh',
    loading: 'Loading…',
    signedOut: 'Not signed in',
    signedOutHint: 'Sign in with a Qoder PAT to start chatting.',
    signedOutHintAI: 'Sign in with a Qoder Global PAT to start chatting.',
    signedInAs: 'Signed in as {tail}',
    invalidPat: 'Invalid or expired PAT',
    credits: 'Credits',
    remaining: 'Remaining',
    total: 'Total',
    expires: 'Expires',
    models: 'Available models',
    cnRegion: 'China',
    globalRegion: 'Global',
    variantTabCN: 'China',
    variantTabGlobal: 'Global',
    accountHeading: 'Account',
    patReplace: 'Replace',
    patClear: 'Clear',
    patClearing: 'Clearing…',
    refreshing: 'Refreshing…',
    patSave: 'Save',
    patSaving: 'Saving…',
    patSaved: 'PAT saved.',
    patSaveFailed: 'Failed to save PAT.',
    patInvalid: 'Invalid or expired PAT.',
    cancel: 'Cancel',
    patHeading: 'Personal access token',
    statusResponseInvalid: 'The host returned an invalid status document.',
    statusRefreshFailed: 'Refresh failed: {message}',
    catalogLive: 'Catalog live at {time}',
    catalogSaved: 'Catalog saved at {time}',
    catalogFallback: 'Catalog unavailable',
    catalogError: 'Catalog error: {message}',
    refreshModels: 'Refresh models',
    refreshingModels: 'Refreshing…',
    tabStatus: 'Status',
    tabContext: 'Context',
    tabModels: 'Models',
    tabDetails: 'Details',
    tabCheckIn: 'Check-in',
    creditsHeading: 'Credits',
    creditsUsed: 'Used',
    creditsTotalUnlimited: 'Unlimited',
    cycleResetAt: 'Resets at {time}',
    creditsError: 'Credits error: {message}',
    creditsDetailHeading: 'Credit packages',
    expand: 'Expand',
    collapse: 'Collapse',
    totalCredits: 'Total credits',
    noModels: 'No models available',
  },
  zh: {
    title: 'Qoder',
    titleAI: 'Qoder AI',
    intro: 'Qoder 国内云端模型',
    introAI: 'Qoder 国际云端模型',
    signIn: '登录',
    signOut: '清除令牌',
    patLabel: '个人访问令牌',
    patPlaceholder: '粘贴你的 Qoder PAT',
    patPlaceholderAI: '粘贴你的 Qoder Global PAT',
    patGuide: '输入 Qoder 国内 PAT 以启用国内模型。',
    patGuideAI: '输入 Qoder Global PAT 以启用国际模型。',
    savePat: '保存',
    clearPat: '清除',
    refresh: '刷新',
    loading: '加载中…',
    signedOut: '未登录',
    signedOutHint: '使用 Qoder PAT 登录后开始聊天。',
    signedOutHintAI: '使用 Qoder Global PAT 登录后开始聊天。',
    signedInAs: '已登录为 {tail}',
    invalidPat: '令牌无效或已过期',
    credits: '额度',
    remaining: '剩余',
    total: '总量',
    expires: '到期',
    models: '可用模型',
    cnRegion: '国内',
    globalRegion: '国际',
    variantTabCN: '国内',
    variantTabGlobal: '国际',
    accountHeading: '账号',
    patReplace: '更换',
    patClear: '清除',
    patClearing: '清除中…',
    refreshing: '刷新中…',
    patSave: '保存',
    patSaving: '保存中…',
    patSaved: '令牌已保存。',
    patSaveFailed: '保存令牌失败。',
    patInvalid: '令牌无效或已过期。',
    cancel: '取消',
    patHeading: '个人访问令牌',
    statusResponseInvalid: '宿主返回了无效的状态文档。',
    statusRefreshFailed: '刷新失败：{message}',
    catalogLive: '目录已同步于 {time}',
    catalogSaved: '目录已缓存于 {time}',
    catalogFallback: '目录不可用',
    catalogError: '目录错误：{message}',
    refreshModels: '刷新模型',
    refreshingModels: '刷新中…',
    tabStatus: '状态',
    tabContext: '上下文',
    tabModels: '模型',
    tabDetails: '明细',
    tabCheckIn: '签到',
    creditsHeading: '额度',
    creditsUsed: '已用',
    creditsTotalUnlimited: '不限量',
    cycleResetAt: '重置于 {time}',
    creditsError: '额度错误：{message}',
    creditsDetailHeading: '额度包',
    expand: '展开',
    collapse: '收起',
    totalCredits: '总额度',
    noModels: '暂无可用模型',
  },
}
