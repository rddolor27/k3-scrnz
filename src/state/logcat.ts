import { Channel } from '@tauri-apps/api/core'
import { useEffect, useRef, useState } from 'react'

import { error, warn } from '../lib/log'
import {
	clearLogcat,
	DEFAULT_LOG_FILTER,
	getLogcatInfo,
	type LogBatch,
	type LogcatInfo,
	type LogFilter,
	type LogRow,
	setLogcatFilter,
	startLogcat,
} from '../lib/logcat'

/** Rows kept in the webview; matches the Rust ring (spec section 10.2). */
export const MAX_ROWS = 50_000
/** Rows dropped at once when the cap is passed, so the splice cost is amortised. */
export const TRIM_CHUNK = 5_000

/** The live rows, mutated in place by every batch. React sees a `LogView`. */
interface LogBuffer {
	rows: LogRow[]
	version: number
	trimmed: number
	epoch: number
	skipped: number
}

/**
 * What the panel renders. While streaming, `rows` is the live array (mutated
 * in place), so `version` is the only change signal. While paused it is a copy.
 */
export interface LogView {
	rows: readonly LogRow[]
	/** Bumped once per applied batch, so React renders at most ~10 times a second. */
	version: number
	/** Rows dropped from the top since the session began. Only ever grows. */
	trimmed: number
	/** Bumped by every `reset` batch (filter change, clear, reconnect). */
	epoch: number
	/** Rows the flood guard dropped since the last reset. */
	skipped: number
}

export interface LogcatState extends LogView {
	paused: boolean
	/** The app behind "Only my app"; null until `get_logcat_info` answers. */
	info: LogcatInfo | null
	/** Why the stream couldn't start; null while it runs. */
	error: string | null
	/** Rust's rejection of the last filter (e.g. a bad regex); null when applied. */
	filterError: string | null
	/** Sends the filter to Rust, which answers with a `reset` batch. */
	setFilter: (filter: LogFilter) => void
	/** Empties the local buffer only; never touches the device. */
	clear: () => void
	/** Freezes the display (the stream keeps flowing) or catches up again. */
	setPaused: (paused: boolean) => void
	retry: () => void
}

interface Session {
	serial: string
	view: LogView
	paused: boolean
	info: LogcatInfo | null
	error: string | null
	filterError: string | null
}

type SessionPatch = Partial<Omit<Session, 'serial'>>

const EMPTY_VIEW: LogView = {
	rows: [],
	version: 0,
	trimmed: 0,
	epoch: 0,
	skipped: 0,
}

const newSession = (serial: string): Session => ({
	serial,
	view: EMPTY_VIEW,
	paused: false,
	info: null,
	error: null,
	filterError: null,
})

/** Late callbacks of an earlier device must not touch the current session. */
const patchSession =
	(serial: string, patch: SessionPatch) =>
	(prev: Session): Session =>
		prev.serial === serial ? { ...prev, ...patch } : prev

const createBuffer = (): LogBuffer => ({
	rows: [],
	version: 0,
	trimmed: 0,
	epoch: 0,
	skipped: 0,
})

const viewOf = (buffer: LogBuffer): LogView => ({
	rows: buffer.rows,
	version: buffer.version,
	trimmed: buffer.trimmed,
	epoch: buffer.epoch,
	skipped: buffer.skipped,
})

/** A frozen copy for pause: later batches can't change or shift it. */
const snapshotOf = (buffer: LogBuffer): LogView => ({
	...viewOf(buffer),
	rows: buffer.rows.slice(),
})

/** Drops whole chunks from the top once the cap is passed. */
const trimBuffer = (buffer: LogBuffer): void => {
	const excess = buffer.rows.length - MAX_ROWS
	if (excess <= 0) return
	const drop = Math.ceil(excess / TRIM_CHUNK) * TRIM_CHUNK
	buffer.rows.splice(0, drop)
	buffer.trimmed += drop
}

const applyBatch = (buffer: LogBuffer, batch: LogBatch): void => {
	if (batch.kind === 'reset') {
		buffer.rows = batch.rows
		buffer.skipped = batch.skipped
		buffer.epoch += 1
	} else {
		for (const row of batch.rows) buffer.rows.push(row)
		buffer.skipped += batch.skipped
	}
	trimBuffer(buffer)
	buffer.version += 1
}

/** A reset replaces the display and ends a pause; an append is held while paused. */
const receiveBatch = (
	prev: Session,
	view: LogView,
	reset: boolean,
): Session => {
	if (reset) return { ...prev, view, paused: false }
	return prev.paused ? prev : { ...prev, view }
}

/**
 * The logcat stream of one device (spec section 10.3). Rows live in a plain
 * array outside React state; one `version` bump per batch drives the render.
 * Switching `serial` drops the old session and ignores its late messages.
 */
export const useLogcat = (serial: string): LogcatState => {
	const [session, setSession] = useState<Session>(() => newSession(serial))
	const [attempt, setAttempt] = useState(0)
	const bufferRef = useRef<LogBuffer | null>(null)
	// Last filter Rust accepted, replayed on every start so both sides agree.
	const appliedFilter = useRef<LogFilter>(DEFAULT_LOG_FILTER)
	const filterRequest = useRef(0)

	// A new device starts from a blank session (state adjusted during render).
	const current = session.serial === serial ? session : newSession(serial)
	if (current !== session) setSession(current)

	useEffect(() => {
		let live = true
		const buffer = createBuffer()
		bufferRef.current = buffer
		// Rust looks the app's uid up in the background and sends a `reset` when
		// it lands, so the info is fetched again on resets until it is known.
		let uidKnown = false
		const refreshInfo = (): void => {
			getLogcatInfo(serial)
				.then((info) => {
					if (!live) return
					uidKnown = info.appUid !== null
					setSession(patchSession(serial, { info }))
				})
				.catch((e: unknown) => {
					void warn(`logcat: app info unavailable: ${String(e)}`)
				})
		}
		// A Channel can't be detached: `live` silences it once we move on.
		const channel = new Channel<LogBatch>((batch) => {
			if (!live) return
			applyBatch(buffer, batch)
			const view = viewOf(buffer)
			const reset = batch.kind === 'reset'
			setSession((prev) =>
				prev.serial === serial ? receiveBatch(prev, view, reset) : prev,
			)
			if (reset && !uidKnown) refreshInfo()
		})

		const begin = async (): Promise<void> => {
			await startLogcat(serial, channel)
			try {
				// start_logcat is idempotent and may find a filter from an earlier mount.
				await setLogcatFilter(serial, appliedFilter.current)
			} catch (e) {
				void warn(`logcat: restoring the filter failed: ${String(e)}`)
			}
			refreshInfo()
		}
		begin().catch((e: unknown) => {
			void error(`logcat: start failed for ${serial}: ${String(e)}`)
			if (live) setSession(patchSession(serial, { error: String(e) }))
		})

		return (): void => {
			live = false
			bufferRef.current = null
		}
	}, [serial, attempt])

	const setFilter = (filter: LogFilter): void => {
		filterRequest.current += 1
		const request = filterRequest.current
		setLogcatFilter(serial, filter)
			.then(() => {
				if (request !== filterRequest.current) return
				appliedFilter.current = filter
				setSession(patchSession(serial, { filterError: null }))
			})
			.catch((e: unknown) => {
				// Only the latest request decides what the user sees.
				if (request !== filterRequest.current) return
				setSession(patchSession(serial, { filterError: String(e) }))
			})
	}

	const clear = (): void => {
		clearLogcat(serial).catch((e: unknown) => {
			void error(`logcat: clear failed for ${serial}: ${String(e)}`)
		})
	}

	const setPaused = (paused: boolean): void => {
		const buffer = bufferRef.current
		if (!buffer) return
		const view = paused ? snapshotOf(buffer) : viewOf(buffer)
		setSession(patchSession(serial, { paused, view }))
	}

	const retry = (): void => {
		setSession(patchSession(serial, { error: null }))
		setAttempt((n) => n + 1)
	}

	return {
		...current.view,
		paused: current.paused,
		info: current.info,
		error: current.error,
		filterError: current.filterError,
		setFilter,
		clear,
		setPaused,
		retry,
	}
}
