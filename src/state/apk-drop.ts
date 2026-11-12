import { getCurrentWebview } from '@tauri-apps/api/webview'
import { type RefObject, useEffect, useRef, useState } from 'react'

import { installApkPath } from '../lib/ipc'
import { error, warn } from '../lib/log'
import type { ShowNote } from './note'

interface UseApkDropOptions {
	serial: string
	hostRef: RefObject<HTMLElement | null>
	enabled: boolean
	showNote: ShowNote
}

const isApk = (path: string): boolean => path.toLowerCase().endsWith('.apk')

const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path

export const useApkDrop = ({
	serial,
	hostRef,
	enabled,
	showNote,
}: UseApkDropOptions): boolean => {
	const [dragging, setDragging] = useState(false)
	const installing = useRef(false)

	useEffect(() => {
		if (!enabled) return
		let live = true
		let unlisten: (() => void) | null = null
		let hasApk = false

		// A hidden screen has an empty rect, so it never matches.
		const isOver = (position: { x: number; y: number }): boolean => {
			const rect = hostRef.current?.getBoundingClientRect()
			if (!rect || rect.width === 0 || rect.height === 0) return false
			const x = position.x / window.devicePixelRatio
			const y = position.y / window.devicePixelRatio
			return (
				x >= rect.left &&
				x < rect.right &&
				y >= rect.top &&
				y < rect.bottom
			)
		}

		const install = async (paths: string[]): Promise<void> => {
			if (installing.current) {
				showNote('Another install is still running', { error: true })
				return
			}
			installing.current = true
			const failed: string[] = []
			let message = ''
			for (const path of paths) {
				const name = baseName(path)
				showNote(`Installing ${name}…`, { busy: true })
				try {
					message = await installApkPath(serial, path)
				} catch (e) {
					failed.push(`${name}: ${String(e)}`)
					void warn(
						`installing ${name} on ${serial} failed: ${String(e)}`,
					)
				}
			}
			installing.current = false
			const done = paths.length - failed.length
			if (paths.length === 1) {
				showNote(failed[0] ?? message, { error: failed.length > 0 })
			} else if (failed.length === 0) {
				showNote(`Installed ${done} apps on ${serial}`)
			} else {
				showNote(
					`Installed ${done} of ${paths.length}. ${failed.join(' · ')}`,
					{ error: true },
				)
			}
		}

		getCurrentWebview()
			.onDragDropEvent((event) => {
				const drag = event.payload
				if (drag.type === 'leave') {
					hasApk = false
					setDragging(false)
					return
				}
				const inside = isOver(drag.position)
				if (drag.type === 'enter') hasApk = drag.paths.some(isApk)
				if (drag.type !== 'drop') {
					setDragging(hasApk && inside)
					return
				}
				hasApk = false
				setDragging(false)
				if (!inside) return
				const apks = drag.paths.filter(isApk)
				if (apks.length === 0) {
					showNote('Only .apk files can be installed here')
				} else {
					void install(apks)
				}
			})
			.then((fn) => {
				if (live) unlisten = fn
				else fn()
			})
			.catch((e: unknown) => {
				void error(`apk drop: drag and drop unavailable: ${String(e)}`)
			})

		return (): void => {
			live = false
			unlisten?.()
		}
	}, [serial, hostRef, enabled, showNote])

	return enabled && dragging
}
