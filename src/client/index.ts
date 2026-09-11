import React from 'react'

const name = 'dsh-deepseek-balance-client'
const inject = ['slots']

/** The balance row the host route returns, already normalized. */
interface BalanceDisplay {
    currency: string
    totalBalance: string
    grantedBalance: string
    toppedUpBalance: string
}

interface BalancePayload {
    ok: boolean
    isAvailable?: boolean
    message?: string
    code?: string
    display?: BalanceDisplay
    peakLabel?: string
    nextLabel?: string
    nextSwitchAt?: number
}

type BalanceStatus = 'loading' | 'live' | 'unavailable' | 'error'

/** Background poll cadence; the host caches for 60s, so this stays cheap. */
const POLL_INTERVAL_MS = 30_000

/** Countdown refresh cadence while a switch is pending. */
const COUNTDOWN_TICK_MS = 1_000

/**
 * The sidebar footer indicator: a status dot, the balance, and an optional
 * peak/off-peak badge with a countdown to the next price switch. Clicking it
 * forces a fresh read; hovering shows the granted/top-up split.
 */
function apply(ctx: any): void {
    const { useState, useEffect, useRef, useCallback, createElement } = React

    function BalanceIndicator() {
        const [payload, setPayload] = useState<BalancePayload | null>(null)
        const [status, setStatus] = useState<BalanceStatus>('loading')
        const [lastError, setLastError] = useState<string | null>(null)
        const [refreshing, setRefreshing] = useState(false)
        const [countdownMs, setCountdownMs] = useState<number | null>(null)
        const fetchingRef = useRef(false)

        const load = useCallback(async (force: boolean) => {
            if (fetchingRef.current) return
            fetchingRef.current = true
            if (force) setRefreshing(true)
            try {
                const resp = await fetch(`/deepseek-balance${force ? '?refresh=1' : ''}`, {
                    headers: { Accept: 'application/json' },
                })
                const data = (await resp.json()) as BalancePayload
                if (!resp.ok || data.ok !== true) {
                    setStatus('error')
                    setLastError(data.message ?? `HTTP ${resp.status}`)
                } else {
                    setPayload(data)
                    setStatus(data.isAvailable === false ? 'unavailable' : 'live')
                    setLastError(null)
                }
            } catch (err) {
                setStatus('error')
                setLastError(err instanceof Error ? err.message : String(err))
            } finally {
                fetchingRef.current = false
                setRefreshing(false)
            }
        }, [])

        // Background poll, suspended while the tab is hidden. Returning to the
        // tab refreshes immediately rather than waiting out the interval.
        useEffect(() => {
            void load(false)
            const tick = () => {
                if (!document.hidden) void load(false)
            }
            const timer = setInterval(tick, POLL_INTERVAL_MS)
            const onVisible = () => {
                if (!document.hidden) void load(false)
            }
            document.addEventListener('visibilitychange', onVisible)
            return () => {
                clearInterval(timer)
                document.removeEventListener('visibilitychange', onVisible)
            }
        }, [load])

        // Countdown to the next peak/off-peak switch.
        const nextSwitchAt = payload?.nextSwitchAt ?? null
        useEffect(() => {
            if (nextSwitchAt === null) {
                setCountdownMs(null)
                return
            }
            const update = () => setCountdownMs(Math.max(0, nextSwitchAt - Date.now()))
            update()
            const timer = setInterval(update, COUNTDOWN_TICK_MS)
            return () => clearInterval(timer)
        }, [nextSwitchAt])

        const balance = payload?.display ?? null
        const peakLabel = payload?.peakLabel ?? ''
        const nextLabel = payload?.nextLabel ?? ''

        const dotColor =
            status === 'live'
                ? 'var(--dsh-color-success, #22c55e)'
                : status === 'unavailable'
                    ? 'var(--dsh-color-warning, #eab308)'
                    : status === 'error'
                        ? 'var(--dsh-color-danger, #ef4444)'
                        : 'var(--dsh-color-info, #3b82f6)'

        let text = '余额加载中…'
        if (balance !== null) text = `余额 ${balance.totalBalance} ${balance.currency}`
        else if (status === 'error') text = '余额获取失败'

        const remaining = countdownMs === null || countdownMs <= 0 ? '' : formatDuration(countdownMs)
        const badgeText = peakLabel === '' ? '' : remaining === '' ? peakLabel : `${peakLabel} · 距${nextLabel} ${remaining}`
        const isPeak = peakLabel === '高峰'

        const title = balance !== null
            ? `总额 ${balance.totalBalance} ${balance.currency} · 赠送 ${balance.grantedBalance} · 充值 ${balance.toppedUpBalance}`
            : lastError ?? ''

        return createElement(
            'div',
            {
                title,
                'aria-live': 'polite',
                'aria-busy': refreshing,
                style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '4px 10px',
                    borderRadius: '6px',
                    fontSize: '12px',
                    lineHeight: 1.4,
                    color: 'var(--dsh-text-secondary, #888)',
                    cursor: 'pointer',
                    userSelect: 'none',
                    opacity: refreshing ? 0.6 : 1,
                    transition: 'opacity 120ms ease',
                },
                onClick: () => void load(true),
            },
            createElement('span', {
                'aria-hidden': true,
                style: {
                    width: '8px',
                    height: '8px',
                    borderRadius: '50%',
                    backgroundColor: dotColor,
                    flexShrink: 0,
                },
            }),
            createElement('span', { style: { whiteSpace: 'nowrap' } }, text),
            badgeText === ''
                ? null
                : createElement(
                    'span',
                    {
                        style: {
                            padding: '1px 6px',
                            borderRadius: '4px',
                            fontSize: '11px',
                            whiteSpace: 'nowrap',
                            backgroundColor: isPeak ? 'rgba(245,158,11,0.15)' : 'rgba(34,197,94,0.15)',
                            color: isPeak ? 'var(--dsh-color-warning, #f59e0b)' : 'var(--dsh-color-success, #22c55e)',
                        },
                    },
                    badgeText,
                ),
        )
    }

    ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register(
            {
                name: 'sidebar.footer.action',
                id: 'deepseek-balance-indicator',
                order: 10,
            },
            BalanceIndicator,
        ),
    )
}

/**
 * Compact duration for a countdown: `45s`, `12m`, `3h20m`, `2d`.
 * @param ms - remaining milliseconds.
 * @returns the shortened label.
 */
function formatDuration(ms: number): string {
    const totalSeconds = Math.round(ms / 1000)
    if (totalSeconds < 60) return `${totalSeconds}s`
    const minutes = Math.floor(totalSeconds / 60)
    if (minutes < 60) return `${minutes}m`
    const hours = Math.floor(minutes / 60)
    const remMinutes = minutes % 60
    if (hours < 24) return remMinutes > 0 ? `${hours}h${remMinutes}m` : `${hours}h`
    const days = Math.floor(hours / 24)
    const remHours = hours % 24
    return remHours > 0 ? `${days}d${remHours}h` : `${days}d`
}

export { name, inject, apply }
