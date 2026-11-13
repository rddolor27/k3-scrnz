import { useSyncExternalStore } from 'react'

import type { TerminalStarted } from '../lib/terminal'

export interface DeviceTerminals {
	sessions: TerminalStarted[]
	active: string | null
}

export interface TerminalControls {
	send: (data: string) => void
	clear: () => void
}

const EMPTY: DeviceTerminals = { sessions: [], active: null }
const terminals = new Map<string, DeviceTerminals>()
const controls = new Map<string, TerminalControls>()
const listeners = new Set<() => void>()

const emit = (): void => {
	for (const listener of listeners) listener()
}

const subscribe = (listener: () => void): (() => void) => {
	listeners.add(listener)
	return (): void => {
		listeners.delete(listener)
	}
}

const update = (serial: string, next: DeviceTerminals): void => {
	terminals.set(serial, next)
	emit()
}

export const useDeviceTerminals = (serial: string): DeviceTerminals =>
	useSyncExternalStore(subscribe, () => terminals.get(serial) ?? EMPTY)

export const addTerminal = (session: TerminalStarted): void => {
	const current = terminals.get(session.serial) ?? EMPTY
	update(session.serial, {
		sessions: [...current.sessions, session],
		active: session.id,
	})
}

export const replaceTerminal = (
	oldId: string,
	session: TerminalStarted,
): void => {
	const current = terminals.get(session.serial) ?? EMPTY
	update(session.serial, {
		sessions: current.sessions.map((s) => (s.id === oldId ? session : s)),
		active: current.active === oldId ? session.id : current.active,
	})
}

export const removeTerminal = (serial: string, id: string): void => {
	const current = terminals.get(serial) ?? EMPTY
	const index = current.sessions.findIndex((s) => s.id === id)
	const sessions = current.sessions.filter((s) => s.id !== id)
	const fallback = sessions[Math.min(index, sessions.length - 1)]?.id ?? null
	update(serial, {
		sessions,
		active: current.active === id ? fallback : current.active,
	})
}

export const activateTerminal = (serial: string, id: string): void => {
	const current = terminals.get(serial) ?? EMPTY
	update(serial, { ...current, active: id })
}

export const registerControls = (
	id: string,
	terminal: TerminalControls,
): (() => void) => {
	controls.set(id, terminal)
	return (): void => {
		if (controls.get(id) === terminal) controls.delete(id)
	}
}

export const typeInto = (id: string, data: string): void => {
	controls.get(id)?.send(data)
}

export const clearTerminal = (id: string): void => {
	controls.get(id)?.clear()
}
