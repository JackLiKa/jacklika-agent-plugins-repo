import '@deepseek-ai/dsh-client-locale'
import '@deepseek-ai/dsh-client-ui-slots'
import type { BuiltInLocaleId } from '@deepseek-ai/dsh-client-locale'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    qoder: QoderLocaleKey
  }
}

export type QoderLocaleKey =
  | 'title'
  | 'signIn'
  | 'signOut'
  | 'patLabel'
  | 'patPlaceholder'
  | 'savePat'
  | 'clearPat'
  | 'refresh'
  | 'loading'
  | 'signedOut'
  | 'signedInAs'
  | 'invalidPat'
  | 'credits'
  | 'remaining'
  | 'total'
  | 'expires'
  | 'models'
  | 'cnRegion'
  | 'globalRegion'

export const QODER_LOCALES: Record<BuiltInLocaleId, Record<QoderLocaleKey, string>> = {
  en: {
    title: 'Qoder',
    signIn: 'Sign in',
    signOut: 'Clear token',
    patLabel: 'Personal access token',
    patPlaceholder: 'Paste your Qoder PAT',
    savePat: 'Save',
    clearPat: 'Clear',
    refresh: 'Refresh',
    loading: 'Loading…',
    signedOut: 'Not signed in',
    signedInAs: 'Signed in as {tail}',
    invalidPat: 'Invalid or expired PAT',
    credits: 'Credits',
    remaining: 'Remaining',
    total: 'Total',
    expires: 'Expires',
    models: 'Available models',
    cnRegion: 'China',
    globalRegion: 'Global',
  },
  zh: {
    title: 'Qoder',
    signIn: '登录',
    signOut: '清除令牌',
    patLabel: '个人访问令牌',
    patPlaceholder: '粘贴你的 Qoder PAT',
    savePat: '保存',
    clearPat: '清除',
    refresh: '刷新',
    loading: '加载中…',
    signedOut: '未登录',
    signedInAs: '已登录为 {tail}',
    invalidPat: '令牌无效或已过期',
    credits: '额度',
    remaining: '剩余',
    total: '总量',
    expires: '到期',
    models: '可用模型',
    cnRegion: '国内',
    globalRegion: '国际',
  },
}
