import type { UnlistenFn } from '@tauri-apps/api/event'
import { useCallback, useEffect, useRef, useState } from 'react'

import {
	cancelSystemImageInstall,
	getSystemImageInstall,
	type InstallProgress,
	installSystemImage,
	onSystemImageProgress,
} from '../lib/ipc'
import { info, warn } from '../lib/log'
import { isInstallFinished } from '../lib/system-images'

const NOTE_MS = 12000
const FAILED_TEXT = 'The install failed.'

export type InstallOutcome =
	| { id: string; kind: 'done' }
	| { id: string; kind: 'failed'; error: string }

export interface SystemImageInstall {
	active: InstallProgress | null
	outcome: InstallOutcome | null
	start: (id: string, acceptLicense: boolean) => void
	cancel: () => void
}

// Rust's SysImgError::Cancelled message.
const CANCELLED = 'installation cancelled'

// The event and the command result both end an install; the first one wins.
export const useSystemImageInstall = (
	onInstalled: () => void,
): SystemImageInstall => {
	const [active, setActive] = useState<InstallProgress | null>(null)
	const [outcome, setOutcome] = useState<InstallOutcome | null>(null)
	const activeRef = useRef<InstallProgress | null>(null)
	const cancelRequested = useRef(false)

	const track = useCallback((next: InstallProgress | null): void => {
		activeRef.current = next
		setActive(next)
	}, [])

	const settle = useCallback(
		(id: string, next: InstallOutcome | null): void => {
			if (activeRef.current?.id !== id) return
			track(null)
			setOutcome(next)
			if (next?.kind === 'done') onInstalled()
		},
		[track, onInstalled],
	)

	const apply = useCallback(
		(progress: InstallProgress): void => {
			const { id, phase } = progress
			if (!isInstallFinished(progress)) {
				track(progress)
			} else if (phase === 'done') {
				settle(id, { id, kind: 'done' })
			} else if (phase === 'failed') {
				settle(id, {
					id,
					kind: 'failed',
					error: progress.error ?? FAILED_TEXT,
				})
			} else {
				settle(id, null)
			}
		},
		[track, settle],
	)

	// Subscribe first, then ask: a snapshot never overwrites a newer event.
	useEffect(() => {
		let live = true
		let finishedEarly = false
		const unlisteners: UnlistenFn[] = []

		const init = async (): Promise<void> => {
			const unlisten = await onSystemImageProgress((progress) => {
				if (!live) return
				if (isInstallFinished(progress)) finishedEarly = true
				apply(progress)
			})
			if (!live) {
				unlisten()
				return
			}
			unlisteners.push(unlisten)
			const running = await getSystemImageInstall()
			if (
				live &&
				!finishedEarly &&
				running !== null &&
				!isInstallFinished(running) &&
				activeRef.current === null
			) {
				track(running)
			}
		}
		init().catch((e: unknown) => {
			void warn(`system image install state unavailable: ${String(e)}`)
		})

		return (): void => {
			live = false
			unlisteners.forEach((unlisten) => unlisten())
		}
	}, [apply, track])

	useEffect(() => {
		if (outcome?.kind !== 'done') return
		const timer = window.setTimeout(() => setOutcome(null), NOTE_MS)
		return (): void => window.clearTimeout(timer)
	}, [outcome])

	const start = (id: string, acceptLicense: boolean): void => {
		if (activeRef.current !== null) return
		cancelRequested.current = false
		setOutcome(null)
		track({ id, phase: 'downloading', received: 0, total: 0, error: null })
		installSystemImage(id, acceptLicense)
			.then(() => {
				void info(`installed system image ${id}`)
				settle(id, { id, kind: 'done' })
			})
			.catch((e: unknown) => {
				if (cancelRequested.current || String(e) === CANCELLED) {
					void info(`system image ${id} install cancelled`)
					settle(id, null)
					return
				}
				void warn(`installing system image ${id} failed: ${String(e)}`)
				settle(id, { id, kind: 'failed', error: String(e) })
			})
	}

	const cancel = (): void => {
		cancelRequested.current = true
		cancelSystemImageInstall().catch((e: unknown) => {
			cancelRequested.current = false
			void warn(
				`cancelling the system image install failed: ${String(e)}`,
			)
		})
	}

	return { active, outcome, start, cancel }
}
