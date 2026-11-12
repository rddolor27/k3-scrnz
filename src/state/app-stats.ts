import { useEffect, useState } from 'react'

import { type AppStats, getAppStats } from '../lib/ipc'
import { warn } from '../lib/log'

const POLL_MS = 2000

/** CPU/RAM of the app for the status bar, polled only while the window shows. */
export const useAppStats = (): AppStats | null => {
	const [stats, setStats] = useState<AppStats | null>(null)

	useEffect(() => {
		let live = true
		let warned = false
		const poll = (): void => {
			if (document.hidden) return
			getAppStats()
				.then((next) => {
					if (live) setStats(next)
				})
				.catch((e: unknown) => {
					// Logged once: the readout just stays empty.
					if (warned) return
					warned = true
					void warn(`app stats unavailable: ${String(e)}`)
				})
		}
		poll()
		const timer = window.setInterval(poll, POLL_MS)
		return (): void => {
			live = false
			window.clearInterval(timer)
		}
	}, [])

	return stats
}
