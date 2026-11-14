import { useEffect, useState } from 'react'

import { listSystemImages, type SystemImage } from '../lib/ipc'
import { warn } from '../lib/log'

export type ImagesLoad =
	| { kind: 'loading' }
	| { kind: 'ready'; images: SystemImage[] }
	| { kind: 'failed'; message: string }

export const useSystemImages = (): {
	load: ImagesLoad
	reload: () => void
} => {
	const [load, setLoad] = useState<ImagesLoad>({ kind: 'loading' })
	const [attempt, setAttempt] = useState(0)

	useEffect(() => {
		let live = true
		listSystemImages()
			.then((images) => {
				if (live) setLoad({ kind: 'ready', images })
			})
			.catch((e: unknown) => {
				void warn(`listing system images failed: ${String(e)}`)
				if (live) setLoad({ kind: 'failed', message: String(e) })
			})
		return (): void => {
			live = false
		}
	}, [attempt])

	const reload = (): void => {
		setLoad({ kind: 'loading' })
		setAttempt((n) => n + 1)
	}

	return { load, reload }
}
