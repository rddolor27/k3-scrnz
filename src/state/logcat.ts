import { Channel } from '@tauri-apps/api/core'
import { useEffect, useRef, useState } from 'react'

import { error, warn } from '../lib/log'
import {
	APP_PACKAGE_EVENT,
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

export const MAX_ROWS = 50_000
export const TRIM_CHUNK = 5_000

interface LogBuffer {
	rows: LogRow[]
	version: number
	trimmed: number
	epoch: number
	skipped: number
}

// `rows` is mutated in place while streaming; only `version` signals change.
export interface LogView {
	rows: readonly LogRow[]
	version: number
	trimmed: number
	epoch: number
	skipped: number
}

export interface LogcatState extends LogView {
	paused: boolean
	info: LogcatInfo | null
	error: string | null
	filterError: string | null
	setFilter: (filter: LogFilter) => void
	clear: () => void
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

const snapshotOf = (buffer: LogBuffer): LogView => ({
	...viewOf(buffer),
	rows: buffer.rows.slice(),
})

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

const receiveBatch = (
	prev: Session,
	view: LogView,
	reset: boolean,
): Session => {
	if (reset) return { ...prev, view, paused: false }
	return prev.paused ? prev : { ...prev, view }
}

export const useLogcat = (serial: string): LogcatState => {
	const [session, setSession] = useState<Session>(() => newSession(serial))
	const [attempt, setAttempt] = useState(0)
	const bufferRef = useRef<LogBuffer | null>(null)
	const appliedFilter = useRef<LogFilter>(DEFAULT_LOG_FILTER)
	const filterRequest = useRef(0)

	const current = session.serial === serial ? session : newSession(serial)
	if (current !== session) setSession(current)

	useEffect(() => {
		let live = true
		const buffer = createBuffer()
		bufferRef.current = buffer
		// Rust resolves the uid later and sends a `reset`: refetch until known.
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
		const onPackageChanged = (): void => {
			uidKnown = false
			refreshInfo()
		}
		window.addEventListener(APP_PACKAGE_EVENT, onPackageChanged)

		const begin = async (): Promise<void> => {
			await startLogcat(serial, channel)
			try {
				// start_logcat may keep an earlier mount's filter; reapply ours.
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
			window.removeEventListener(APP_PACKAGE_EVENT, onPackageChanged)
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
