import { getCurrentWebview } from '@tauri-apps/api/webview'
import { type RefObject, useEffect, useRef, useState } from 'react'

import { error } from '../lib/log'

const isApk = (path: string): boolean => path.toLowerCase().endsWith('.apk')

export const useFolderDrop = (
	hostRef: RefObject<HTMLElement | null>,
	onDrop: (path: string) => void,
): boolean => {
	const [dragging, setDragging] = useState(false)
	const onDropRef = useRef(onDrop)

	useEffect(() => {
		onDropRef.current = onDrop
	})

	useEffect(() => {
		let live = true
		let unlisten: (() => void) | null = null
		let candidate: string | null = null

		// A hidden panel has an empty rect, so it never matches.
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

		getCurrentWebview()
			.onDragDropEvent((event) => {
				const drag = event.payload
				if (drag.type === 'leave') {
					candidate = null
					setDragging(false)
					return
				}
				if (drag.type === 'enter') {
					const first = drag.paths[0]
					candidate =
						first !== undefined && !isApk(first) ? first : null
				}
				const inside = candidate !== null && isOver(drag.position)
				if (drag.type !== 'drop') {
					setDragging(inside)
					return
				}
				setDragging(false)
				const path = candidate
				candidate = null
				if (inside && path !== null) onDropRef.current(path)
			})
			.then((fn) => {
				if (live) unlisten = fn
				else fn()
			})
			.catch((e: unknown) => {
				void error(
					`folder drop: drag and drop unavailable: ${String(e)}`,
				)
			})

		return (): void => {
			live = false
			unlisten?.()
		}
	}, [hostRef])

	return dragging
}
