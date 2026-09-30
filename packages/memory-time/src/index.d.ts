/**
 * Shared timestamp formatting for the dsh-memory suite.
 *
 * The project convention is to store all vault timestamps in Asia/Shanghai
 * (Beijing) time with an explicit `+08:00` offset. This keeps the local
 * audit log readable and avoids mixing UTC `Z` with local wall-clock dates.
 * @module @jacklika/dsh-memory-time
 */
/**
 * Format a Date as an ISO-like string in Asia/Shanghai (+08:00).
 * Uses `Intl.DateTimeFormat` with the `sv-SE` locale to get zero-padded,
 * 24-hour components that resemble ISO 8601 without re-implementing calendars.
 */
export declare function formatBeijingTime(date: Date): string;
//# sourceMappingURL=index.d.ts.map