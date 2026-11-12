import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager'
import { type JSX, useEffect, useRef, useState } from 'react'

import { mapKey } from '../input/keyboard'
import { KEY } from '../input/keycodes'
import { toDevice, wheelToScroll } from '../input/pointer'
import {
	type ControlMessage,
	type ControlSocket,
	openControl,
} from '../lib/control'
import {
	devicePower,
	getEndpoint,
	type MirrorRole,
	onDeviceClipboard,
	onSessionState,
	startMirror,
	stopMirror,
} from '../lib/ipc'
import { error } from '../lib/log'
import type { WorkerEvent, WorkerInit } from '../video/protocol'

/** A customer screen with no frame for this long shows "No content". */
const IDLE_AFTER_MS = 3000

type Phase =
	| { kind: 'starting' }
	| { kind: 'streaming' }
	| { kind: 'error'; message: string }

interface ScreenViewProps {
	serial: string
	displayId: number
	role: MirrorRole
	/** Shown above a customer screen, e.g. "Customer screen". */
	label?: string
}

/**
 * One live screen: starts a mirror session, decodes it in a worker onto an
 * OffscreenCanvas, and (for the main screen) forwards input (spec sections 8, 9).
 */
export const ScreenView = ({
	serial,
	displayId,
	role,
	label,
}: ScreenViewProps): JSX.Element => {
	const hostRef = useRef<HTMLDivElement>(null)
	const controlRef = useRef<ControlSocket | null>(null)
	const [phase, setPhase] = useState<Phase>({ kind: 'starting' })
	const [size, setSize] = useState<{ width: number; height: number } | null>(
		null,
	)
	const [lag, setLag] = useState(0)
	const [idle, setIdle] = useState(false)
	const [note, setNote] = useState<string | null>(null)
	const [attempt, setAttempt] = useState(0)
	const interactive = role === 'main'

	useEffect(() => {
		const host = hostRef.current
		if (!host) return
		let live = true
		let sessionId: string | null = null
		let lastSentClip: string | null = null
		let lastFrameAt = 0
		let idleNow = false
		const video = { width: 0, height: 0 }
		const cleanups: (() => void)[] = []

		// A fresh canvas per mount: transferControlToOffscreen works only once.
		const canvas = document.createElement('canvas')
		canvas.className = 'screen-canvas'
		canvas.tabIndex = interactive ? 0 : -1
		host.appendChild(canvas)
		const offscreen = canvas.transferControlToOffscreen()
		const worker = new Worker(
			new URL('../video/video-worker.ts', import.meta.url),
			{ type: 'module' },
		)

		const send = (message: ControlMessage): void => {
			controlRef.current?.send(message)
		}

		worker.onmessage = (e: MessageEvent<WorkerEvent>): void => {
			const event = e.data
			if (event.type === 'size') {
				video.width = event.width
				video.height = event.height
				setSize({ width: event.width, height: event.height })
			} else if (event.type === 'need-key') {
				send({ t: 'resetVideo' })
			} else if (event.type === 'stats') {
				setLag(event.lag)
			} else if (event.type === 'frame') {
				lastFrameAt = performance.now()
				if (idleNow) {
					idleNow = false
					setIdle(false)
				}
			} else if (event.type === 'decoder-error') {
				void error(`video decoder (${serial}): ${event.message}`)
			}
		}

		const idleTimer = window.setInterval(() => {
			const isIdle =
				lastFrameAt > 0 &&
				performance.now() - lastFrameAt > IDLE_AFTER_MS
			if (isIdle !== idleNow) {
				idleNow = isIdle
				setIdle(isIdle)
			}
		}, 1000)
		cleanups.push(() => window.clearInterval(idleTimer))

		const start = async (): Promise<void> => {
			try {
				const ep = await getEndpoint()
				const started = await startMirror(serial, displayId, role)
				if (!live) {
					void stopMirror(started.sessionId)
					return
				}
				sessionId = started.sessionId
				video.width = started.width
				video.height = started.height
				setSize({ width: started.width, height: started.height })
				const init: WorkerInit = {
					type: 'init',
					canvas: offscreen,
					port: ep.port,
					token: ep.token,
					sessionId,
				}
				worker.postMessage(init, [offscreen])
				controlRef.current = openControl(ep, sessionId)
				setPhase({ kind: 'streaming' })
			} catch (e) {
				if (live) setPhase({ kind: 'error', message: String(e) })
				void error(
					`mirror ${serial}/${displayId} failed to start: ${String(e)}`,
				)
			}
		}
		void start()

		onSessionState((state) => {
			if (!live || state.sessionId !== sessionId) return
			if (state.state === 'error' || state.state === 'stopped') {
				setPhase({
					kind: 'error',
					message: state.error ?? 'The mirror stopped.',
				})
			}
		})
			.then((unlisten) => (live ? cleanups.push(unlisten) : unlisten()))
			.catch(() => undefined)

		if (interactive) {
			const pressed = new Set<number>()
			let pendingMove: ControlMessage | null = null
			let frame = 0
			let repeat = 0
			const flushMove = (): void => {
				frame = 0
				if (pendingMove) send(pendingMove)
				pendingMove = null
			}
			const queueMove = (message: ControlMessage): void => {
				pendingMove = message
				if (!frame) frame = requestAnimationFrame(flushMove)
			}
			const touch = (
				e: PointerEvent,
				action: 0 | 1 | 2 | 7,
				pressure: number,
				actionButton: number,
				buttons: number,
			): ControlMessage | null => {
				if (!video.width) return null
				const { x, y } = toDevice(e, canvas, video.width, video.height)
				return {
					t: 'touch',
					action,
					pointerId: e.pointerType === 'mouse' ? -1 : e.pointerId,
					x,
					y,
					w: video.width,
					h: video.height,
					pressure,
					actionButton,
					buttons,
				}
			}
			const sendIf = (message: ControlMessage | null): void => {
				if (message) send(message)
			}
			const key = (keycode: number, action: 0 | 1): void =>
				send({ t: 'key', action, keycode, repeat: 0, meta: 0 })

			const onPointerDown = (e: PointerEvent): void => {
				canvas.focus()
				e.preventDefault()
				if (e.button === 0) {
					canvas.setPointerCapture(e.pointerId)
					flushMove()
					pressed.add(e.pointerId)
					sendIf(touch(e, 0, 1, 1, 1))
				} else if (e.button === 2)
					send({ t: 'backOrScreenOn', action: 0 })
				else if (e.button === 1) key(KEY.HOME, 0)
				else if (e.button === 3) key(KEY.APP_SWITCH, 0)
				else if (e.button === 4) send({ t: 'expandNotifications' })
			}
			const onPointerMove = (e: PointerEvent): void => {
				if (pressed.has(e.pointerId)) {
					const move = touch(e, 2, 1, 0, 1)
					if (move) queueMove(move)
				} else if (e.pointerType === 'mouse' && video.width) {
					const { inside } = toDevice(
						e,
						canvas,
						video.width,
						video.height,
					)
					const hover = inside ? touch(e, 7, 0, 0, 0) : null
					if (hover) queueMove(hover)
				}
			}
			const onPointerUp = (e: PointerEvent): void => {
				if (e.button === 0 && pressed.has(e.pointerId)) {
					flushMove()
					pressed.delete(e.pointerId)
					sendIf(touch(e, 1, 0, 1, 0))
				} else if (e.button === 2)
					send({ t: 'backOrScreenOn', action: 1 })
				else if (e.button === 1) key(KEY.HOME, 1)
				else if (e.button === 3) key(KEY.APP_SWITCH, 1)
			}
			const onPointerCancel = (e: PointerEvent): void => {
				if (!pressed.has(e.pointerId)) return
				flushMove()
				pressed.delete(e.pointerId)
				sendIf(touch(e, 1, 0, 1, 0))
			}
			const onWheel = (e: WheelEvent): void => {
				e.preventDefault()
				if (!video.width) return
				const { x, y } = toDevice(e, canvas, video.width, video.height)
				send({
					t: 'scroll',
					x,
					y,
					w: video.width,
					h: video.height,
					...wheelToScroll(e),
					buttons: 0,
				})
			}
			const onKey = (e: KeyboardEvent, action: 0 | 1): void => {
				repeat = action === 0 && e.repeat ? repeat + 1 : 0
				const mapped = mapKey(e, action, repeat)
				if (mapped.kind === 'ignore') return
				e.preventDefault()
				if (mapped.kind === 'send') {
					send(mapped.message)
					return
				}
				readText()
					.then((text) => {
						if (!text) return
						lastSentClip = text
						send({ t: 'setClipboard', text, paste: true })
					})
					.catch((err: unknown) => {
						void error(
							`reading the PC clipboard failed: ${String(err)}`,
						)
					})
			}
			const onKeyDown = (e: KeyboardEvent): void => onKey(e, 0)
			const onKeyUp = (e: KeyboardEvent): void => onKey(e, 1)
			const onContextMenu = (e: Event): void => e.preventDefault()

			canvas.addEventListener('pointerdown', onPointerDown)
			canvas.addEventListener('pointermove', onPointerMove)
			canvas.addEventListener('pointerup', onPointerUp)
			canvas.addEventListener('pointercancel', onPointerCancel)
			canvas.addEventListener('wheel', onWheel, { passive: false })
			canvas.addEventListener('keydown', onKeyDown)
			canvas.addEventListener('keyup', onKeyUp)
			canvas.addEventListener('contextmenu', onContextMenu)
			cleanups.push(() => {
				if (frame) cancelAnimationFrame(frame)
			})

			// Device → PC clipboard, ignoring the echo of what we just pasted.
			onDeviceClipboard((clip) => {
				if (clip.serial !== serial || clip.text === lastSentClip) return
				writeText(clip.text).catch((err: unknown) => {
					void error(
						`writing the PC clipboard failed: ${String(err)}`,
					)
				})
			})
				.then((unlisten) =>
					live ? cleanups.push(unlisten) : unlisten(),
				)
				.catch(() => undefined)
		}

		return (): void => {
			live = false
			if (sessionId) void stopMirror(sessionId)
			controlRef.current?.close()
			controlRef.current = null
			worker.terminate()
			canvas.remove()
			cleanups.forEach((cleanup) => cleanup())
		}
	}, [serial, displayId, role, interactive, attempt])

	const press = (keycode: number): void => {
		controlRef.current?.send({
			t: 'key',
			action: 0,
			keycode,
			repeat: 0,
			meta: 0,
		})
		controlRef.current?.send({
			t: 'key',
			action: 1,
			keycode,
			repeat: 0,
			meta: 0,
		})
	}
	const togglePower = (): void => {
		devicePower(serial, 'toggle')
			.then((state) =>
				setNote(state === 'Awake' ? 'Screen on' : 'Screen off'),
			)
			.catch((e: unknown) => setNote(`Power failed: ${String(e)}`))
	}
	const retry = (): void => {
		setPhase({ kind: 'starting' })
		setAttempt((n) => n + 1)
	}

	return (
		<div
			className={
				interactive ? 'screen screen-main' : 'screen screen-customer'
			}
		>
			{interactive ? (
				<div className='screen-toolbar'>
					<button
						onClick={() => press(KEY.BACK)}
						title='Back (right-click)'
					>
						◀ Back
					</button>
					<button
						onClick={() => press(KEY.HOME)}
						title='Home (middle-click)'
					>
						⌂ Home
					</button>
					<button
						onClick={() => press(KEY.APP_SWITCH)}
						title='Recents'
					>
						▢ Recents
					</button>
					<button
						onClick={togglePower}
						title='Screen on/off (never WAKEUP)'
					>
						⏻ Power
					</button>
					<button
						onClick={() => press(KEY.VOLUME_DOWN)}
						title='Volume down'
					>
						🔉
					</button>
					<button
						onClick={() => press(KEY.VOLUME_UP)}
						title='Volume up'
					>
						🔊
					</button>
					<button
						onClick={() =>
							controlRef.current?.send({ t: 'resetVideo' })
						}
						title='Ask for a fresh key frame'
					>
						⟳ Reset video
					</button>
					<span className='spacer' />
					{note && <span className='muted'>{note}</span>}
					<span className='muted'>
						{size ? `${size.width}×${size.height}` : '…'} · lag{' '}
						{lag}
					</span>
				</div>
			) : (
				<div className='screen-label'>
					<span>{label ?? 'Customer screen'}</span>
					<span className='muted'>
						{size ? `${size.width}×${size.height}` : ''} · view only
					</span>
				</div>
			)}
			<div className='screen-host' ref={hostRef}>
				{phase.kind === 'starting' && (
					<div className='screen-overlay'>Starting mirror…</div>
				)}
				{phase.kind === 'error' && (
					<div className='screen-overlay err'>
						<span>{phase.message}</span>
						<button onClick={retry}>Retry</button>
					</div>
				)}
				{phase.kind === 'streaming' && idle && !interactive && (
					<div className='screen-overlay faint'>No content</div>
				)}
			</div>
		</div>
	)
}
