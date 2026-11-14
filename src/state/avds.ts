import { useCallback, useEffect, useRef, useState } from 'react'

import { type AvdBusy, avdTitle } from '../lib/avd'
import {
	type Avd,
	deleteAvd,
	listAvds,
	startEmulator,
	type StartOptions,
	stopEmulator,
} from '../lib/ipc'
import { info, warn } from '../lib/log'

const REFRESH_MS = 3000
const NOTE_MS = 12000
const STOP_GRACE_MS = 30000

export interface AvdsState {
	avds: Avd[] | null
	error: string | null
	refresh: () => Promise<void>
}

export const useAvds = (): AvdsState => {
	const [avds, setAvds] = useState<Avd[] | null>(null)
	const [error, setError] = useState<string | null>(null)
	const enqueueRef = useRef<(() => Promise<void>) | null>(null)

	useEffect(() => {
		let live = true
		let chain: Promise<void> = Promise.resolve()
		let waiting = 0
		const load = async (): Promise<void> => {
			try {
				const next = await listAvds()
				if (!live) return
				setAvds(next)
				setError(null)
			} catch (e) {
				if (live) setError(String(e))
			}
		}
		// Loads run one after another, so the last request always wins.
		const enqueue = (): Promise<void> => {
			waiting += 1
			chain = chain.then(load).finally(() => {
				waiting -= 1
			})
			return chain
		}
		enqueueRef.current = enqueue
		void enqueue()
		const timer = window.setInterval(() => {
			if (waiting === 0) void enqueue()
		}, REFRESH_MS)
		return (): void => {
			live = false
			enqueueRef.current = null
			window.clearInterval(timer)
		}
	}, [])

	const refresh = useCallback(
		(): Promise<void> => enqueueRef.current?.() ?? Promise.resolve(),
		[],
	)

	return { avds, error, refresh }
}

export interface AvdNote {
	text: string
	error: boolean
}

interface AvdActionsInput {
	avds: Avd[] | null
	refresh: () => Promise<void>
	onOpen: (serial: string) => void
}

export interface AvdActions {
	busy: ReadonlyMap<string, AvdBusy>
	note: AvdNote | null
	showNote: (text: string) => void
	start: (avd: Avd, options?: StartOptions) => Promise<boolean>
	stop: (avd: Avd) => Promise<boolean>
	remove: (avd: Avd) => Promise<boolean>
}

const withEntry = (
	busy: ReadonlyMap<string, AvdBusy>,
	name: string,
	kind: AvdBusy | null,
): ReadonlyMap<string, AvdBusy> => {
	const next = new Map(busy)
	if (kind) next.set(name, kind)
	else next.delete(name)
	return next
}

export const useAvdActions = ({
	avds,
	refresh,
	onOpen,
}: AvdActionsInput): AvdActions => {
	const [busy, setBusy] = useState<ReadonlyMap<string, AvdBusy>>(
		() => new Map(),
	)
	const [note, setNote] = useState<AvdNote | null>(null)

	// The emulator shuts down seconds after the stop command returns.
	if (avds) {
		const settled = [...busy].filter(
			([name, kind]) =>
				kind === 'stopping' &&
				!avds.some(
					(avd) => avd.name === name && avd.state !== 'stopped',
				),
		)
		if (settled.length > 0) {
			setBusy(
				settled.reduce(
					(map, [name]) => withEntry(map, name, null),
					busy,
				),
			)
		}
	}

	useEffect(() => {
		if (!note || note.error) return
		const timer = window.setTimeout(() => setNote(null), NOTE_MS)
		return (): void => window.clearTimeout(timer)
	}, [note])

	const run = async (
		avd: Avd,
		kind: AvdBusy,
		task: () => Promise<string>,
	): Promise<boolean> => {
		setBusy((prev) => withEntry(prev, avd.name, kind))
		setNote(null)
		let ok = true
		try {
			setNote({ text: await task(), error: false })
		} catch (e) {
			ok = false
			void warn(`emulator ${avd.name}: ${kind} failed: ${String(e)}`)
			setNote({ text: String(e), error: true })
		}
		await refresh()
		if (kind === 'stopping' && ok) {
			window.setTimeout(() => {
				setBusy((prev) =>
					prev.get(avd.name) === 'stopping'
						? withEntry(prev, avd.name, null)
						: prev,
				)
			}, STOP_GRACE_MS)
		} else {
			setBusy((prev) => withEntry(prev, avd.name, null))
		}
		return ok
	}

	const start = (avd: Avd, options?: StartOptions): Promise<boolean> =>
		run(avd, 'starting', async () => {
			const serial = await startEmulator(avd.name, options)
			void info(`emulator ${avd.name} started as ${serial}`)
			onOpen(serial)
			return `${avdTitle(avd)} is starting without a window. Its tab shows the screen once Android has started.`
		})

	const stop = (avd: Avd): Promise<boolean> => {
		const { serial } = avd
		if (!serial) return Promise.resolve(false)
		return run(avd, 'stopping', async () => {
			await stopEmulator(serial)
			void info(`emulator ${serial} stopping`)
			return `${avdTitle(avd)} is shutting down.`
		})
	}

	const remove = (avd: Avd): Promise<boolean> =>
		run(avd, 'deleting', async () => {
			await deleteAvd(avd.name)
			void info(`emulator ${avd.name} deleted`)
			return `Deleted ${avdTitle(avd)}.`
		})

	return {
		busy,
		note,
		showNote: (text) => setNote({ text, error: false }),
		start,
		stop,
		remove,
	}
}
