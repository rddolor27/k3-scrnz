import type { UnlistenFn } from '@tauri-apps/api/event'
import { type JSX, useEffect, useState } from 'react'

import { type DisplayInfo, getDisplays, onDisplaysChanged } from '../lib/ipc'
import { error } from '../lib/log'
import { ScreenView } from './ScreenView'

type CustomerDisplays = Readonly<Record<string, DisplayInfo[]>>

const NO_DISPLAYS: DisplayInfo[] = []

const sameIds = (a: DisplayInfo[], b: DisplayInfo[]): boolean =>
	a.length === b.length && a.every((display, i) => display.id === b[i]?.id)

export const useCustomerDisplaysOf = (
	serials: readonly string[],
	refreshMs = 0,
): CustomerDisplays => {
	const [lists, setLists] = useState<CustomerDisplays>({})
	const key = serials.join('\n')

	useEffect(() => {
		let live = true
		const wanted = new Set(key === '' ? [] : key.split('\n'))
		const gotEvent = new Set<string>()
		const asking = new Set<string>()
		const unlisteners: UnlistenFn[] = []
		const put = (serial: string, displays: DisplayInfo[]): void => {
			const customers = displays.filter((d) => d.customer)
			setLists((all) => {
				const known = all[serial]
				if (known && sameIds(known, customers)) return all
				return {
					...Object.fromEntries(
						Object.entries(all).filter(([s]) => wanted.has(s)),
					),
					[serial]: customers,
				}
			})
		}
		// One request per device at a time: a hung device must not pile them up.
		const ask = (serial: string, refresh: boolean): void => {
			if (asking.has(serial)) return
			asking.add(serial)
			getDisplays(serial)
				.then((list) => {
					if (live && (refresh || !gotEvent.has(serial))) {
						put(serial, list)
					}
				})
				.catch((e: unknown) => {
					if (refresh) return
					void error(
						`listing displays of ${serial} failed: ${String(e)}`,
					)
				})
				.finally(() => asking.delete(serial))
		}
		onDisplaysChanged((change) => {
			if (!live || !wanted.has(change.serial)) return
			gotEvent.add(change.serial)
			put(change.serial, change.displays)
		})
			.then((unlisten) =>
				live ? unlisteners.push(unlisten) : unlisten(),
			)
			.catch(() => undefined)
		for (const serial of wanted) ask(serial, false)
		const timer =
			refreshMs > 0
				? window.setInterval(() => {
						if (document.hidden) return
						for (const serial of wanted) ask(serial, true)
					}, refreshMs)
				: 0
		return (): void => {
			live = false
			window.clearInterval(timer)
			unlisteners.forEach((unlisten) => unlisten())
		}
	}, [key, refreshMs])

	return lists
}

export const useCustomerDisplays = (serial: string): DisplayInfo[] =>
	useCustomerDisplaysOf([serial])[serial] ?? NO_DISPLAYS

interface CustomerScreensProps {
	serial: string
	displays: DisplayInfo[]
	compact?: boolean
	maxSize?: number
	share?: number
}

export const CustomerScreens = ({
	serial,
	displays,
	compact = false,
	maxSize,
	share,
}: CustomerScreensProps): JSX.Element => (
	<aside
		className='customer-panel'
		style={
			share === undefined ? undefined : { flexBasis: `${share * 100}%` }
		}
	>
		{displays.map((display, index) => (
			<ScreenView
				key={display.id}
				serial={serial}
				displayId={display.id}
				role='customer'
				label={
					index > 0
						? `Screen ${index + 2}`
						: compact
							? 'Customer'
							: 'Customer screen'
				}
				compact={compact}
				maxSize={maxSize}
			/>
		))}
	</aside>
)
