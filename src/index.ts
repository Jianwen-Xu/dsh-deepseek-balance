/**
 * Host half of dsh-deepseek-balance: resolves the DeepSeek credential through
 * the credential seam, polls the balance endpoint behind a short cache, and
 * serves one JSON route the client half reads.
 *
 * @module dsh-deepseek-balance
 */

const name = 'dsh-deepseek-balance'
const inject = ['webServer', 'credentials']

/** The route pathname, exact — `?refresh=1` is read from the query string. */
const ROUTE_PATH = '/deepseek-balance'

/** How long one upstream balance read stays fresh for non-forced readers. */
const CACHE_TTL_MS = 60_000

/** Upstream read timeout; a hanging request must not hold the route forever. */
const FETCH_TIMEOUT_MS = 10_000

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000

/** Ambient environment without pulling node typings into the host bundle. */
declare const process: { env: Record<string, string | undefined> }

/** Resolved credential value or nothing when the reference is unconfigured. */
interface ResolvedCredential {
    value?: string
    secret?: string
    token?: string
}

interface CredentialsSeam {
    resolve(ref: string): Promise<ResolvedCredential | string | undefined>
}

interface WebRoute {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: unknown, res: unknown) => void | Promise<void>
}

interface ResponseLike {
    setHeader(name: string, value: string): void
    end(body?: string): void
}

interface WebServerSeam {
    register(route: WebRoute): () => void
}

interface PluginContext {
    webServer: WebServerSeam
    credentials: CredentialsSeam
    logger: { info(message: string): void; warn(message: unknown): void }
    effect(callback: () => unknown, label?: string): unknown
}

/** The balance row this plugin surfaces, normalized to the fields the UI shows. */
interface BalanceDisplay {
    currency: string
    totalBalance: string
    grantedBalance: string
    toppedUpBalance: string
}

/** Peak/off-peak pricing facts, derived locally from the published schedule. */
interface PeakStatus {
    peakHour: boolean
    peakLabel: '高峰' | '空闲'
    nextLabel: '高峰' | '空闲'
    /** Epoch milliseconds of the next transition, for the client countdown. */
    nextSwitchAt: number
}

interface BalanceResult extends Partial<PeakStatus> {
    ok: boolean
    code?: string
    message?: string
    isAvailable?: boolean
    display?: BalanceDisplay
    fetchedAt?: number
}

/**
 * Peak status in Beijing wall-clock time. DeepSeek prices peak hours at
 * 09:00-12:00 and 14:00-18:00, Monday through Friday; every other moment is
 * the discounted idle period. The host time zone is irrelevant here: shifting
 * the epoch and reading UTC fields yields Beijing fields on any host.
 * @returns current label plus the epoch timestamp of the next switch.
 */
function computePeakStatus(nowMs: number = Date.now()): PeakStatus {
    const bj = new Date(nowMs + BEIJING_OFFSET_MS)
    const day = bj.getUTCDay() // 0 = Sunday, 6 = Saturday
    const nowMin = bj.getUTCHours() * 60 + bj.getUTCMinutes()

    const P1S = 9 * 60
    const P1E = 12 * 60
    const P2S = 14 * 60
    const P2E = 18 * 60

    const isWeekend = day === 0 || day === 6
    let peakHour: boolean
    let switchInMinutes: number

    if (isWeekend) {
        peakHour = false
        const restOfDay = 24 * 60 - nowMin
        const fullDaysInBetween = day === 6 ? 1 : 0
        switchInMinutes = restOfDay + fullDaysInBetween * 24 * 60 + P1S
    } else if (nowMin < P1S) {
        peakHour = false
        switchInMinutes = P1S - nowMin
    } else if (nowMin < P1E) {
        peakHour = true
        switchInMinutes = P1E - nowMin
    } else if (nowMin < P2S) {
        peakHour = false
        switchInMinutes = P2S - nowMin
    } else if (nowMin < P2E) {
        peakHour = true
        switchInMinutes = P2E - nowMin
    } else {
        peakHour = false
        const restOfDay = 24 * 60 - nowMin
        const fullDaysInBetween = day === 5 ? 2 : 0
        switchInMinutes = restOfDay + fullDaysInBetween * 24 * 60 + P1S
    }

    return {
        peakHour,
        peakLabel: peakHour ? '高峰' : '空闲',
        nextLabel: peakHour ? '空闲' : '高峰',
        nextSwitchAt: nowMs + switchInMinutes * 60 * 1000,
    }
}

/** The request fields this plugin reads without depending on node typings. */
interface RequestLike {
    url?: string
}

/**
 * Whether the caller asked to bypass the cache. The seam hands handlers a raw
 * `IncomingMessage`: it carries no parsed `query`, so the query string is read
 * from `req.url` here.
 * @param req - the incoming request.
 * @returns true when `refresh=1` is present.
 */
function wantsRefresh(req: RequestLike): boolean {
    const url = typeof req.url === 'string' ? req.url : ''
    return new URL(url, 'http://localhost').searchParams.get('refresh') === '1'
}

function sendJson(res: ResponseLike, status: number, body: unknown): void {
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    // The client polls this route itself; a cached reply would defeat it.
    res.setHeader('Cache-Control', 'no-store')
    res.end(JSON.stringify(body))
}

async function apply(ctx: PluginContext): Promise<void> {
    const cache: { data: BalanceResult | null; fetchedAt: number } = { data: null, fetchedAt: 0 }
    let inFlight: Promise<BalanceResult> | null = null

    /**
     * Resolve the API key for the current call. The credential seam already
     * layers environment values, stored values, and `.env` files, so the raw
     * process environment is only a last-resort fallback.
     */
    async function resolveApiKey(): Promise<string | null> {
        let key: string | null = null
        try {
            const resolved = await ctx.credentials.resolve('DEEPSEEK_API_KEY')
            if (typeof resolved === 'string') key = resolved
            else if (resolved !== undefined && resolved !== null) {
                if (typeof resolved.value === 'string') key = resolved.value
                else if (typeof resolved.secret === 'string') key = resolved.secret
                else if (typeof resolved.token === 'string') key = resolved.token
            }
        } catch (err) {
            ctx.logger.warn(`[dsh-deepseek-balance] credentials.resolve failed: ${String(err)}`)
        }
        if (key === null || key.trim() === '') {
            const env = process.env.DEEPSEEK_API_KEY
            key = typeof env === 'string' && env.trim() !== '' ? env : null
        }
        return key === null ? null : key.trim().replace(/^Bearer\s+/i, '')
    }

    /** One upstream read; never throws, always returns a shaped result. */
    async function fetchBalance(): Promise<BalanceResult> {
        const apiKey = await resolveApiKey()
        if (apiKey === null) {
            return { ok: false, code: 'no-api-key', message: '未配置 DEEPSEEK_API_KEY', ...computePeakStatus() }
        }

        const abort = AbortSignal.timeout(FETCH_TIMEOUT_MS)
        try {
            const resp = await fetch('https://api.deepseek.com/user/balance', {
                headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
                signal: abort,
            })
            if (!resp.ok) {
                return { ok: false, code: 'http-error', message: `HTTP ${resp.status}`, ...computePeakStatus() }
            }

            const json = (await resp.json()) as {
                is_available?: boolean
                balance_infos?: Array<{
                    currency?: string
                    total_balance?: string
                    granted_balance?: string
                    topped_up_balance?: string
                }>
            }
            const infos = Array.isArray(json.balance_infos) ? json.balance_infos : []
            // Prefer a funded CNY row; fall back to any funded row, then any CNY
            // row, then whatever the API returned first.
            const funded = (info: (typeof infos)[number]): boolean => parseFloat(String(info.total_balance)) > 0
            const display =
                infos.find((info) => info.currency === 'CNY' && funded(info)) ??
                infos.find(funded) ??
                infos.find((info) => info.currency === 'CNY') ??
                infos[0]
            if (display === undefined) {
                return { ok: false, code: 'no-balance-info', message: '接口未返回余额信息', ...computePeakStatus() }
            }

            return {
                ok: true,
                isAvailable: json.is_available !== false,
                display: {
                    currency: String(display.currency ?? 'CNY'),
                    totalBalance: String(display.total_balance ?? '0'),
                    grantedBalance: String(display.granted_balance ?? '0'),
                    toppedUpBalance: String(display.topped_up_balance ?? '0'),
                },
                ...computePeakStatus(),
                fetchedAt: Date.now(),
            }
        } catch (err) {
            const message = err instanceof Error ? err.name === 'TimeoutError' ? '请求超时' : err.message : String(err)
            return { ok: false, code: 'fetch-error', message, ...computePeakStatus() }
        }
    }

    /**
     * Cache-respecting read. Concurrent callers share one upstream request so a
     * burst of clicks cannot fan out into a burst of API calls.
     * @param forceRefresh - bypass the cached value for this call.
     */
    async function getBalance(forceRefresh = false): Promise<BalanceResult> {
        const now = Date.now()
        if (!forceRefresh && cache.data !== null && now - cache.fetchedAt < CACHE_TTL_MS) return cache.data
        if (forceRefresh) inFlight = null
        inFlight ??= fetchBalance().then((result) => {
            cache.data = result
            cache.fetchedAt = Date.now()
            inFlight = null
            return result
        })
        return inFlight
    }

    ctx.effect(
        () =>
            ctx.webServer.register({
                kind: 'exact',
                path: ROUTE_PATH,
                handler: async (req, res) => {
                    const request = req as RequestLike
                    const response = res as ResponseLike
                    const data = await getBalance(wantsRefresh(request))
                    sendJson(response, 200, data)
                },
            }),
        `dsh-deepseek-balance: GET ${ROUTE_PATH}`,
    )

    // Warm the cache so the first UI paint has data, but never block activation.
    void getBalance().catch(() => {})
    ctx.logger.info(`[dsh-deepseek-balance] 已加载，路由 ${ROUTE_PATH} 已注册`)
}

export { name, inject, apply }
