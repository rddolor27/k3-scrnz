export interface FrameTap {
	key: string
	label: string
	worker: Worker
}

export interface TapEvent {
	kind: 'add' | 'remove'
	tap: FrameTap
}

type TapListener = (event: TapEvent) => void

const taps = new Map<string, FrameTap>()
const listeners = new Set<TapListener>()

const notify = (event: TapEvent): void => {
	for (const listener of [...listeners]) listener(event)
}

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
