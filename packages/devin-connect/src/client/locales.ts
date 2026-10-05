import type {} from '@deepseek-ai/dsh-client-locale'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { BuiltInLocaleId } from '@deepseek-ai/dsh-client-locale'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    devin: DevinLocaleKey
  }
}

export type DevinLocaleKey =
  | 'title'
  | 'patLabel'
  | 'patPlaceholder'
  | 'savePat'
  | 'clearPat'
  | 'refresh'
  | 'loading'
  | 'signedOut'
  | 'signedInAs'
  | 'invalidPat'
  | 'organizations'

export const DEVIN_LOCALES: Record<BuiltInLocaleId, Record<DevinLocaleKey, string>> = {
  en: {
    title: 'Devin',
    patLabel: 'Devin API key',
    patPlaceholder: 'Paste your Devin PAT (cog_…)',
    savePat: 'Save',
    clearPat: 'Clear',
    refresh: 'Refresh',
    loading: 'Loading…',
    signedOut: 'Not signed in',
    signedInAs: 'Signed in as {tail}',
    invalidPat: 'Invalid or expired PAT',
    organizations: 'Organizations',
  },
  zh: {
    title: 'Devin',
    patLabel: 'Devin API 密钥',
    patPlaceholder: '粘贴你的 Devin PAT（cog_…）',
    savePat: '保存',
    clearPat: '清除',
    refresh: '刷新',
    loading: '加载中…',
    signedOut: '未登录',
    signedInAs: '已登录为 {tail}',
    invalidPat: '令牌无效或已过期',
    organizations: '组织',
  },
}
