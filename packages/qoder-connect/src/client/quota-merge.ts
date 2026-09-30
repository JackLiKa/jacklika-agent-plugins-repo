export interface QoderAccount {
  packageName: string
  remain: number
  size: number
  packageEndTime?: string
  unlimited?: boolean
}

export interface MergedQuotaGroup {
  packageName: string
  remain: number
  size: number
  packageEndTime?: string
  unlimited: boolean
}

export function mergeCreditAccounts(accounts: QoderAccount[]): MergedQuotaGroup[] {
  const groups = new Map<string, MergedQuotaGroup>()
  for (const account of accounts) {
    const existing = groups.get(account.packageName)
    if (existing) {
      existing.remain += typeof account.remain === 'number' ? account.remain : 0
      existing.size += typeof account.size === 'number' ? account.size : 0
      existing.unlimited = existing.unlimited || account.unlimited === true
      if (account.packageEndTime !== undefined) {
        const current = existing.packageEndTime === undefined ? Infinity : Date.parse(existing.packageEndTime)
        const candidate = Date.parse(account.packageEndTime)
        if (!Number.isNaN(candidate) && (Number.isNaN(current) || candidate < current)) {
          existing.packageEndTime = account.packageEndTime
        }
      }
    } else {
      const group: MergedQuotaGroup = {
        packageName: account.packageName,
        remain: typeof account.remain === 'number' ? account.remain : 0,
        size: typeof account.size === 'number' ? account.size : 0,
        unlimited: account.unlimited === true,
      }
      if (account.packageEndTime !== undefined) group.packageEndTime = account.packageEndTime
      groups.set(account.packageName, group)
    }
  }
  return [...groups.values()]
}

export function clampPercent(remain: number, size: number): number | undefined {
  if (typeof size !== 'number' || size <= 0 || !Number.isFinite(remain)) return undefined
  const value = (remain / size) * 100
  return Math.max(0, Math.min(100, value))
}

export function parseExpiry(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

export function isSpent(group: MergedQuotaGroup): boolean {
  return !group.unlimited && group.remain <= 0
}

export function isExpired(group: MergedQuotaGroup, now: number): boolean {
  if (!isSpent(group)) return false
  const expiry = parseExpiry(group.packageEndTime)
  return expiry !== undefined && expiry < now
}

export function visibleQuotaGroups(groups: MergedQuotaGroup[], now = Date.now()): MergedQuotaGroup[] {
  const result: MergedQuotaGroup[] = []
  let anyHasBalance = false
  for (const group of groups) {
    if (isExpired(group, now)) continue
    if (group.unlimited || group.remain > 0) {
      result.push(group)
      anyHasBalance = true
    }
  }
  if (!anyHasBalance) {
    // All spent and not expired → render "empty" state so the user sees it
    for (const group of groups) {
      if (!isExpired(group, now)) result.push(group)
    }
  }
  return result
}

export function sortPackageRows(groups: MergedQuotaGroup[], now = Date.now()): MergedQuotaGroup[] {
  const live: MergedQuotaGroup[] = []
  const spent: MergedQuotaGroup[] = []
  for (const group of groups) {
    if (isExpired(group, now)) continue
    if (group.unlimited || group.remain > 0) live.push(group)
    else spent.push(group)
  }
  return [...live, ...spent]
}
