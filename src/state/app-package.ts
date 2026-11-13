import { useEffect, useState } from 'react'

import { warn } from '../lib/log'
import { APP_PACKAGE_EVENT, getLogcatInfo } from '../lib/logcat'

export const useAppPackage = (serial: string): string | null => {
	const [appPackage, setAppPackage] = useState<string | null>(null)

	useEffect(() => {
		let live = true
		const load = (): void => {
			getLogcatInfo(serial)
				.then((info) => {
					if (live) setAppPackage(info.appPackage)
				})
				.catch((e: unknown) => {
					void warn(`app package of ${serial} unknown: ${String(e)}`)
				})
		}
		load()
		window.addEventListener(APP_PACKAGE_EVENT, load)
		return (): void => {
			live = false
			window.removeEventListener(APP_PACKAGE_EVENT, load)
		}
	}, [serial])

	return appPackage
}
