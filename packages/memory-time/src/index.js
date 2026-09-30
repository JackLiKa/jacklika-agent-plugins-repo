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
export function formatBeijingTime(date) {
    const parts = new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    }).formatToParts(date);
    const get = (type) => parts.find((p) => p.type === type)?.value ?? '00';
    const yyyy = get('year');
    const MM = get('month');
    const dd = get('day');
    const HH = get('hour');
    const mm = get('minute');
    const ss = get('second');
    return `${yyyy}-${MM}-${dd}T${HH}:${mm}:${ss}+08:00`;
}
//# sourceMappingURL=index.js.map