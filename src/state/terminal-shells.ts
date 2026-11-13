import { useEffect, useSyncExternalStore } from 'react'

import { warn } from '../lib/log'
import { listTerminalShells, type ShellInfo } from '../lib/terminal'

const SHELL_KEY = 'tri.terminalShell'

interface ShellState {
	shells: ShellInfo[]
	saved: string | null
}

const readSaved = (): string | null => {
	try {
		return window.localStorage.getItem(SHELL_KEY)
	} catch {
		return null
	}
}

const writeSaved = (id: string): void => {
	try {
		window.localStorage.setItem(SHELL_KEY, id)
	} catch {
		// Storage can be unavailable.
	}
}

let state: ShellState = { shells: [], saved: readSaved() }
let loaded = false
let loading = false
const listeners = new Set<() => void>()

const subscribe = (listener: () => void): (() => void) => {
	listeners.add(listener)
	return (): void => {
		listeners.delete(listener)
	}
}

const getSnapshot = (): ShellState => state

const update = (next: ShellState): void => {
	state = next
	for (const listener of listeners) listener()
}

const loadShells = (): void => {
	if (loaded || loading) return
	loading = true
	listTerminalShells()
		.then((shells) => {
			loaded = true
			update({ ...state, shells })
		})
		.catch((e: unknown) => {
			void warn(`terminal: listing shells failed: ${String(e)}`)
		})
		.finally(() => {
			loading = false
		})
}

const selectShell = (id: string): void => {
	writeSaved(id)
	update({ ...state, saved: id })
}

export interface TerminalShells {
	shells: ShellInfo[]
	current: ShellInfo | null
	select: (id: string) => void
}

export const useTerminalShells = (): TerminalShells => {
	const { shells, saved } = useSyncExternalStore(subscribe, getSnapshot)

	useEffect(() => {
		loadShells()
	}, [])

	const current = shells.find((s) => s.id === saved) ?? shells[0] ?? null
	return { shells, current, select: selectShell }
}
