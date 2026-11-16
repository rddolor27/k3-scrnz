import type { MirrorRole } from '../lib/ipc'

export interface FrameTap {
	key: string
	serial: string
	displayId: number
	role: MirrorRole
	label: string
	worker: Worker
	size: () => { width: number; height: number } | null
}

export interface TapEvent {
	kind: 'add' | 'remove'
	tap: FrameTap
}

type TapListener = (event: TapEvent) => void

export const tapKey = (serial: string, displayId: number): string =>
	`${serial}/${displayId}`

const taps = new Map<string, FrameTap>()
const listeners = new Set<TapListener>()
const changeListeners = new Set<() => void>()

const notify = (event: TapEvent): void => {
	for (const listener of [...listeners]) listener(event)
	for (const listener of [...changeListeners]) listener()
}

export const listTaps = (): FrameTap[] => [...taps.values()]

export const registerTap = (tap: FrameTap): (() => void) => {
	taps.set(tap.key, tap)
	notify({ kind: 'add', tap })
	return (): void => {
		if (taps.get(tap.key) !== tap) return
		taps.delete(tap.key)
		notify({ kind: 'remove', tap })
	}
}

export const subscribeTaps = (listener: TapListener): (() => void) => {
	for (const tap of taps.values()) listener({ kind: 'add', tap })
	listeners.add(listener)
	return (): void => {
		listeners.delete(listener)
	}
}

export const subscribeTapChanges = (listener: () => void): (() => void) => {
	changeListeners.add(listener)
	return (): void => {
		changeListeners.delete(listener)
	}
}
