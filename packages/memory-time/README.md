# @jacklika/dsh-memory-time

Shared timestamp formatting for the `dsh-memory` suite.

`formatBeijingTime(date)` returns an ISO-like string in Asia/Shanghai
(`+08:00`) time. The memory vault uses this convention for note frontmatter
(`created`) and for append-section headings, so the local audit log stays on a
single clock and never mixes UTC `Z` with local wall-clock dates.
