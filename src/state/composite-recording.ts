import { useCallback, useEffect, useRef, useState } from 'react'

import {
	getEndpoint,
	onRecordingEnded,
	type RecordingEnded,
	startGridRecording,
	stopGridRecording,
} from '../lib/ipc'
import { debug, error, info, warn } from '../lib/log'
import { type FrameTap, subscribeTaps } from '../video/frame-taps'
import type {
	GridCell,
	GridLogLevel,
	GridRecorderEvent,
	GridRecorderRequest,
} from '../video/grid-protocol'
import type { WorkerRequest } from '../video/protocol'
import type { ShowNote } from './note'
import { describeEnd } from './screen-capture'

const STOP_TIMEOUT_MS = 10_000

const LOGGERS: Record<GridLogLevel, (message: string) => Promise<void>> = {
	debug,
	info,
	warn,
	error,
}

export interface CompositePlan {
	name: string
	width: number
	height: number
	serial?: string
	cells?: GridCell[]
}

interface ActiveRecording {
	id: string
	since: number
	compositor: Worker
	stopTapping: () => void
	stopping: boolean
	givenUp: boolean
	fallbackTimer: number
	failure: string | null
}

interface UseCompositeRecordingOptions {
	accepts: (tap: FrameTap) => boolean
	order: string[]
	plan: () => Promise<CompositePlan>
	showNote: ShowNote
}

export interface CompositeRecording {
	since: number | null
	busy: boolean
	toggle: () => void
}

const send = <T>(
	worker: Worker,
	message: T,
	transfer: Transferable[] = [],
): void => {
	worker.postMessage(message, transfer)
}

const errorText = (e: unknown): string =>
	e instanceof Error ? e.message : String(e)

const release = (active: ActiveRecording): void => {
	window.clearTimeout(active.fallbackTimer)
	active.stopTapping()
	active.compositor.terminate()
}

const attachTaps = (
	compositor: Worker,
	accepts: (tap: FrameTap) => boolean,
): (() => void) => {
	const attached = new Map<string, Worker>()
	const detach = (key: string): void => {
		const worker = attached.get(key)
		if (!worker) return
		attached.delete(key)
		send<GridRecorderRequest>(compositor, { type: 'remove', key })
		send<WorkerRequest>(worker, { type: 'untap' })
	}
	const unsubscribe = subscribeTaps(({ kind, tap }) => {
		if (kind === 'remove') {
			if (attached.get(tap.key) === tap.worker) detach(tap.key)
			return
		}
		if (!accepts(tap)) return
		detach(tap.key)
		const { port1, port2 } = new MessageChannel()
		send<WorkerRequest>(tap.worker, { type: 'tap', port: port1 }, [port1])
		send<GridRecorderRequest>(
			compositor,
			{ type: 'add', key: tap.key, label: tap.label, port: port2 },
			[port2],
		)
		attached.set(tap.key, tap.worker)
	})
	return (): void => {
		unsubscribe()
		for (const key of [...attached.keys()]) detach(key)
	}
}

export const useCompositeRecording = ({
	accepts,
	order,
	plan,
	showNote,
}: UseCompositeRecordingOptions): CompositeRecording => {
	const [since, setSince] = useState<number | null>(null)
	const [busy, setBusy] = useState(false)
	const activeRef = useRef<ActiveRecording | null>(null)
	const orderRef = useRef<string[]>([])
	const acceptsRef = useRef(accepts)
	const planRef = useRef(plan)
	const disposedRef = useRef(false)
	const orderKey = order.join('\n')

	useEffect(() => {
		acceptsRef.current = accepts
		planRef.current = plan
	}, [accepts, plan])

	const settle = useCallback(
		(active: ActiveRecording, ended: RecordingEnded): void => {
			if (activeRef.current !== active) return
			activeRef.current = null
			release(active)
			setSince(null)
			setBusy(false)
			const { text, options } = describeEnd(ended)
			if (active.failure === null) {
				showNote(text, options)
			} else {
				showNote(`Recording stopped: ${active.failure}`, {
					...options,
					error: true,
				})
			}
		},
		[showNote],
	)

	const giveUp = useCallback(
		(active: ActiveRecording): void => {
			if (activeRef.current !== active || active.givenUp) return
			active.givenUp = true
			release(active)
			stopGridRecording(active.id)
				.then((ended) => settle(active, ended))
				.catch((e: unknown) => {
					void warn(
						`stopping the composite recording failed: ${String(e)}`,
					)
					if (activeRef.current !== active) return
					activeRef.current = null
					setSince(null)
					setBusy(false)
					showNote(`Recording failed: ${String(e)}`, { error: true })
				})
		},
		[settle, showNote],
	)

	const abort = useCallback(
		(active: ActiveRecording, message: string): void => {
			void warn(`compositor failed: ${message}`)
			if (active.failure === null) active.failure = message
			giveUp(active)
		},
		[giveUp],
	)

	const start = useCallback(async (): Promise<void> => {
		setBusy(true)
		try {
			const composite = await planRef.current()
			const ep = await getEndpoint()
			const started = await startGridRecording(
				composite.name,
				composite.width,
				composite.height,
				composite.serial,
			)
			let compositor: Worker
			try {
				if (disposedRef.current) {
					throw new Error(
						'The view closed while the recording started.',
					)
				}
				compositor = new Worker(
					new URL(
						'../video/grid-recorder-worker.ts',
						import.meta.url,
					),
					{ type: 'module' },
				)
			} catch (e) {
				stopGridRecording(started.id).catch((err: unknown) => {
					void warn(
						`closing the composite recording failed: ${String(err)}`,
					)
				})
				throw e
			}
			const active: ActiveRecording = {
				id: started.id,
				since: Date.now(),
				compositor,
				stopTapping: () => undefined,
				stopping: false,
				givenUp: false,
				fallbackTimer: 0,
				failure: null,
			}
			compositor.onmessage = (
				e: MessageEvent<GridRecorderEvent>,
			): void => {
				const event = e.data
				if (event.type === 'log') {
					void LOGGERS[event.level](`compositor: ${event.message}`)
				} else if (event.type === 'error') {
					abort(active, event.message)
				} else if (event.type === 'started') {
					void info(`composite recording ${active.id} started`)
				} else if (disposedRef.current) {
					// Nobody is left to show the result; the file is saved.
					activeRef.current = null
					release(active)
				} else {
					compositor.terminate()
				}
			}
			compositor.onerror = (e: ErrorEvent): void =>
				abort(active, e.message)
			send<GridRecorderRequest>(compositor, {
				type: 'init',
				port: ep.port,
				token: ep.token,
				recordingId: started.id,
				width: composite.width,
				height: composite.height,
				cells: composite.cells,
			})
			send<GridRecorderRequest>(compositor, {
				type: 'order',
				keys: orderRef.current,
			})
			active.stopTapping = attachTaps(compositor, (tap) =>
				acceptsRef.current(tap),
			)
			activeRef.current = active
			setSince(active.since)
		} catch (e) {
			void warn(`composite recording failed to start: ${errorText(e)}`)
			if (!disposedRef.current) {
				showNote(`Recording failed: ${errorText(e)}`, { error: true })
			}
		} finally {
			setBusy(false)
		}
	}, [abort, showNote])

	const stop = useCallback((): void => {
		const active = activeRef.current
		if (!active || active.stopping) return
		active.stopping = true
		setBusy(true)
		// The stop goes first: removing the tiles must not become a black frame.
		send<GridRecorderRequest>(active.compositor, { type: 'stop' })
		active.stopTapping()
		active.fallbackTimer = window.setTimeout(
			() => giveUp(active),
			STOP_TIMEOUT_MS,
		)
	}, [giveUp])

	useEffect(() => {
		disposedRef.current = false
		return (): void => {
			disposedRef.current = true
			stop()
		}
	}, [stop])

	useEffect(() => {
		let live = true
		let unlisten: (() => void) | null = null
		onRecordingEnded((ended) => {
			const active = activeRef.current
			if (active && active.id === ended.sessionId) settle(active, ended)
		})
			.then((fn) => {
				if (live) unlisten = fn
				else fn()
			})
			.catch((e: unknown) => {
				void warn(`recording events unavailable: ${String(e)}`)
			})
		return (): void => {
			live = false
			unlisten?.()
		}
	}, [settle])

	useEffect(() => {
		orderRef.current = orderKey === '' ? [] : orderKey.split('\n')
		const active = activeRef.current
		if (active) {
			send<GridRecorderRequest>(active.compositor, {
				type: 'order',
				keys: orderRef.current,
			})
		}
	}, [orderKey])

	const toggle = (): void => {
		if (busy) return
		if (since === null) void start()
		else stop()
	}

	return { since, busy, toggle }
}
