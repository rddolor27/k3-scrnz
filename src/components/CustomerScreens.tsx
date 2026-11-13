import type { UnlistenFn } from '@tauri-apps/api/event'
import { type JSX, useEffect, useState } from 'react'

import { type DisplayInfo, getDisplays, onDisplaysChanged } from '../lib/ipc'
import { error } from '../lib/log'
import { ScreenView } from './ScreenView'

type CustomerDisplays = Readonly<Record<string, DisplayInfo[]>>

const NO_DISPLAYS: DisplayInfo[] = []

export const useCustomerDisplaysOf = (
	serials: readonly string[],
): CustomerDisplays => {
	const [lists, setLists] = useState<CustomerDisplays>({})
	const key = serials.join('\n')

	useEffect(() => {
		let live = true
		const wanted = new Set(key === '' ? [] : key.split('\n'))
		const gotEvent = new Set<string>()
		const unlisteners: UnlistenFn[] = []
		const put = (serial: string, displays: DisplayInfo[]): void => {
			setLists((all) => ({
				...Object.fromEntries(
					Object.entries(all).filter(([s]) => wanted.has(s)),
				),
				[serial]: displays.filter((d) => d.customer),
			}))
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
		for (const serial of wanted) {
			getDisplays(serial)
				.then((list) => {
					if (live && !gotEvent.has(serial)) put(serial, list)
				})
				.catch((e: unknown) => {
					void error(
						`listing displays of ${serial} failed: ${String(e)}`,
					)
				})
		}
		return (): void => {
			live = false
			unlisteners.forEach((unlisten) => unlisten())
		}
	}, [key])

	return lists
}

export const useCustomerDisplays = (serial: string): DisplayInfo[] =>
	useCustomerDisplaysOf([serial])[serial] ?? NO_DISPLAYS

interface CustomerScreensProps {
	serial: string
	displays: DisplayInfo[]
	compact?: boolean
	maxSize?: number
}

export const CustomerScreens = ({
	serial,
	displays,
	compact = false,
	maxSize,
}: CustomerScreensProps): JSX.Element => (
	<aside className='customer-panel'>
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
