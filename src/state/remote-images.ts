import { useCallback, useEffect, useRef, useState } from 'react'

import {
	listRemoteImages,
	type RemoteCatalog,
	type RemoteImage,
	uninstallSystemImage,
} from '../lib/ipc'
import { info, warn } from '../lib/log'

export interface RemoteCatalogState {
	catalog: RemoteCatalog | null
	loading: boolean
	error: string | null
	refresh: () => void
}

// A new `version` reloads the cached catalog without blanking what is shown.
export const useRemoteCatalog = (version: number): RemoteCatalogState => {
	const [catalog, setCatalog] = useState<RemoteCatalog | null>(null)
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)
	const [attempt, setAttempt] = useState(0)
	const forceRef = useRef(false)

	useEffect(() => {
		let live = true
		const force = forceRef.current
		forceRef.current = false
		listRemoteImages(force)
			.then((next) => {
				if (!live) return
				setCatalog(next)
				setError(null)
				setLoading(false)
			})
			.catch((e: unknown) => {
				void warn(
					`listing downloadable system images failed: ${String(e)}`,
				)
				if (!live) return
				setError(String(e))
				setLoading(false)
			})
		return (): void => {
			live = false
		}
	}, [attempt, version])

	const refresh = useCallback((): void => {
		forceRef.current = true
		setLoading(true)
		setAttempt((n) => n + 1)
	}, [])

	return { catalog, loading, error, refresh }
}

export interface UninstallFailure {
	id: string
	text: string
}

export interface UninstallState {
	busyId: string | null
	failure: UninstallFailure | null
	uninstall: (image: RemoteImage) => void
}

export const useUninstallImage = (
	onUninstalled: () => void,
): UninstallState => {
	const [busyId, setBusyId] = useState<string | null>(null)
	const [failure, setFailure] = useState<UninstallFailure | null>(null)

	const uninstall = (image: RemoteImage): void => {
		setBusyId(image.id)
		setFailure(null)
		uninstallSystemImage(image.id)
			.then(() => {
				void info(`uninstalled system image ${image.id}`)
				onUninstalled()
			})
			.catch((e: unknown) => {
				void warn(
					`uninstalling system image ${image.id} failed: ${String(e)}`,
				)
				setFailure({ id: image.id, text: String(e) })
			})
			.finally(() => setBusyId(null))
	}

	return { busyId, failure, uninstall }
}
