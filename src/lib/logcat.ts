import { type Channel, invoke } from '@tauri-apps/api/core'

/**
 * One log line: `[seq, tsMs, pid, tid, level, tag, msg]` (spec section 10.3).
 * `tsMs` is epoch milliseconds, `level` is the Android priority (2=V .. 7=F).
 */
export type LogRow = readonly [
	seq: number,
	tsMs: number,
	pid: number,
	tid: number,
	level: number,
	tag: string,
	msg: string,
]

/**
 * One message on the logcat Channel, at most one per device per 100 ms.
 * `reset` replaces everything shown, `append` adds rows. `skipped` is the
 * number of rows the flood guard dropped this tick.
 */
export interface LogBatch {
	kind: 'append' | 'reset'
	rows: LogRow[]
	skipped: number
}

/** The filter Rust applies before rows cross IPC (spec section 10.2). */
export interface LogFilter {
	/** Android priority: 2=V 3=D 4=I 5=W 6=E 7=F. */
	minLevel: number
	tag: string | null
	text: string | null
	/** Treat `text` as a regular expression. */
	regex: boolean
	onlyApp: boolean
}

/** What "Only my app" refers to; `appUid` is null while the app isn't found. */
export interface LogcatInfo {
	appPackage: string
	appUid: number | null
}

export interface LogLevel {
	value: number
	letter: string
	label: string
}

export const LOG_LEVELS: readonly LogLevel[] = [
	{ value: 2, letter: 'V', label: 'Verbose' },
	{ value: 3, letter: 'D', label: 'Debug' },
	{ value: 4, letter: 'I', label: 'Info' },
	{ value: 5, letter: 'W', label: 'Warn' },
	{ value: 6, letter: 'E', label: 'Error' },
	{ value: 7, letter: 'F', label: 'Fatal' },
]

export const DEFAULT_LOG_FILTER: LogFilter = {
	minLevel: 2,
	tag: null,
	text: null,
	regex: false,
	onlyApp: false,
}

/** Dispatched on `window` to focus the search box (Ctrl+Shift+L). */
export const FOCUS_LOG_FILTER_EVENT = 'k3-focus-log-filter'

const LEVEL_BY_VALUE = new Map<number, LogLevel>(
	LOG_LEVELS.map((level): [number, LogLevel] => [level.value, level]),
)

export const levelLetter = (level: number): string =>
	LEVEL_BY_VALUE.get(level)?.letter ?? '?'

/** CSS class that colours a row; unknown priorities fall back to `lv-u`. */
export const levelClass = (level: number): string => {
	const known = LEVEL_BY_VALUE.get(level)
	return known ? `lv-${known.letter.toLowerCase()}` : 'lv-u'
}

/** `HH:MM:SS.mmm` in local time. */
export const formatLogTime = (tsMs: number): string => {
	const d = new Date(tsMs)
	const two = (n: number): string => String(n).padStart(2, '0')
	const ms = String(d.getMilliseconds()).padStart(3, '0')
	return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}.${ms}`
}

/**
 * Starts (or re-attaches to) the device's logcat stream. Rust answers with a
 * `reset` batch at once. A Channel can't be detached: when the caller is done
 * it ignores the channel and creates a new one for the next call.
 */
export const startLogcat = (
	serial: string,
	onBatch: Channel<LogBatch>,
): Promise<void> => invoke<void>('start_logcat', { serial, onBatch })

/** Rejects with the regex error text when `filter.text` isn't a valid regex. */
export const setLogcatFilter = (
	serial: string,
	filter: LogFilter,
): Promise<void> => invoke<void>('set_logcat_filter', { serial, filter })

/** Clears the local buffer only (never `logcat -c`); Rust answers with a `reset`. */
export const clearLogcat = (serial: string): Promise<void> =>
	invoke<void>('clear_logcat', { serial })

export const getLogcatInfo = (serial: string): Promise<LogcatInfo> =>
	invoke<LogcatInfo>('get_logcat_info', { serial })
