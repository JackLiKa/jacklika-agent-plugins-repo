/** Browser-half route constants.
 * Kept as six string literals rather than computed suffixes so a build drift on
 * either side cannot cause the browser to request routes the host never mounted.
 */
export const QODER_STATUS_PATH = '/plugins/dsh-qoder-connect/status' as const
export const QODER_PROBE_PATH = '/plugins/dsh-qoder-connect/probe' as const
export const QODER_AUTH_PATH = '/plugins/dsh-qoder-connect/auth' as const
export const QODER_GLOBAL_STATUS_PATH = '/plugins/dsh-qoder-connect/global/status' as const
export const QODER_GLOBAL_PROBE_PATH = '/plugins/dsh-qoder-connect/global/probe' as const
export const QODER_GLOBAL_AUTH_PATH = '/plugins/dsh-qoder-connect/global/auth' as const

/** Map a status path back to its provider variant id. */
export function variantOfStatusPath(path: string): 'qoder' | 'qoder-global' {
  return path.includes('/global/') ? 'qoder-global' : 'qoder'
}
