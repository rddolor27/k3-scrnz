import { useState } from 'react'

const HIDDEN_KEY = 'tri.gridHidden'

export interface HiddenDevices {
	hidden: ReadonlySet<string>
	hide: (serial: string) => void
	show: (serial: string) => void
	showAll: () => void
}

const read = (): ReadonlySet<string> => {
	try {
		const parsed: unknown = JSON.parse(
			window.localStorage.getItem(HIDDEN_KEY) ?? '[]',
		)
		return new Set(
			Array.isArray(parsed)
				? parsed.filter((s): s is string => typeof s === 'string')
				: [],
		)
	} catch {
		return new Set()
	}
}

const save = (hidden: ReadonlySet<string>): void => {
	try {
		window.localStorage.setItem(HIDDEN_KEY, JSON.stringify([...hidden]))
	} catch {
		// Storage can be unavailable.
	}
}

export const useHiddenDevices = (): HiddenDevices => {
	const [hidden, setHidden] = useState<ReadonlySet<string>>(read)

	const change = (next: ReadonlySet<string>): void => {
		setHidden(next)
		save(next)
	}

	return {
		hidden,
		hide: (serial) => change(new Set([...hidden, serial])),
		show: (serial) =>
			change(new Set([...hidden].filter((s) => s !== serial))),
		showAll: () => change(new Set()),
	}
}
