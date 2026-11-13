import { type Channel, invoke } from '@tauri-apps/api/core'

export type LogRow = readonly [
	seq: number,
	tsMs: number,
	pid: number,
	tid: number,
	level: number,
	tag: string,
	msg: string,
]

export interface LogBatch {
	kind: 'append' | 'reset'
	rows: LogRow[]
	skipped: number
}

export interface LogFilter {
	minLevel: number
	tag: string | null
	text: string | null
	regex: boolean
	onlyApp: boolean
}

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

export const FOCUS_LOG_FILTER_EVENT = 'tri-focus-log-filter'

const LEVEL_BY_VALUE = new Map<number, LogLevel>(
	LOG_LEVELS.map((level): [number, LogLevel] => [level.value, level]),
)

export const levelLetter = (level: number): string =>
	LEVEL_BY_VALUE.get(level)?.letter ?? '?'

export const levelClass = (level: number): string => {
	const known = LEVEL_BY_VALUE.get(level)
	return known ? `lv-${known.letter.toLowerCase()}` : 'lv-u'
}

export const formatLogTime = (tsMs: number): string => {
	const d = new Date(tsMs)
	const two = (n: number): string => String(n).padStart(2, '0')
	const ms = String(d.getMilliseconds()).padStart(3, '0')
	return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}.${ms}`
}

export const startLogcat = (
	serial: string,
	onBatch: Channel<LogBatch>,
): Promise<void> => invoke<void>('start_logcat', { serial, onBatch })

export const setLogcatFilter = (
	serial: string,
	filter: LogFilter,
): Promise<void> => invoke<void>('set_logcat_filter', { serial, filter })

// Never `logcat -c`: this empties the local buffer only.
export const clearLogcat = (serial: string): Promise<void> =>
	invoke<void>('clear_logcat', { serial })

export const getLogcatInfo = (serial: string): Promise<LogcatInfo> =>
	invoke<LogcatInfo>('get_logcat_info', { serial })
