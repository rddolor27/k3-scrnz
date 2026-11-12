import type { UnlistenFn } from '@tauri-apps/api/event'
import { type JSX, useEffect, useState } from 'react'

import { type DisplayInfo, getDisplays, onDisplaysChanged } from '../lib/ipc'
import { error } from '../lib/log'
import { ScreenView } from './ScreenView'

export const useCustomerDisplays = (serial: string): DisplayInfo[] => {
	const [displays, setDisplays] = useState<DisplayInfo[]>([])

	useEffect(() => {
		let live = true
		let gotEvent = false
		const unlisteners: UnlistenFn[] = []
		onDisplaysChanged((change) => {
			if (!live || change.serial !== serial) return
			gotEvent = true
			setDisplays(change.displays)
		})
			.then((unlisten) =>
				live ? unlisteners.push(unlisten) : unlisten(),
			)
			.catch(() => undefined)
		getDisplays(serial)
			.then((list) => {
				if (live && !gotEvent) setDisplays(list)
			})
			.catch((e: unknown) => {
				void error(`listing displays of ${serial} failed: ${String(e)}`)
			})
		return (): void => {
			live = false
			unlisteners.forEach((unlisten) => unlisten())
		}
	}, [serial])

	return displays.filter((d) => d.customer)
}

interface CustomerScreensProps {
	serial: string
	displays: DisplayInfo[]
}

export const CustomerScreens = ({
	serial,
	displays,
}: CustomerScreensProps): JSX.Element => (
	<aside className='customer-panel'>
		{displays.map((display, index) => (
			<ScreenView
				key={display.id}
				serial={serial}
				displayId={display.id}
				role='customer'
				label={index === 0 ? 'Customer screen' : `Screen ${index + 2}`}
			/>
		))}
	</aside>
)
