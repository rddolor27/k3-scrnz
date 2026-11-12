import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager'
import { type JSX, type ReactNode, useEffect, useRef, useState } from 'react'

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
	revealFile,
	startMirror,
	stopMirror,
} from '../lib/ipc'
import { error, info } from '../lib/log'
import { useApkDrop } from '../state/apk-drop'
import { useNote } from '../state/note'
import { useScreenCapture } from '../state/screen-capture'
import type { WorkerEvent, WorkerInit } from '../video/protocol'
import { CaptureButtons } from './CaptureButtons'

const IDLE_AFTER_MS = 3000
const RETRY_DELAYS_MS = [1000, 2000, 5000]

type Phase =
	| { kind: 'starting' }
	| { kind: 'streaming' }
	| { kind: 'error'; message: string; retrying: boolean }

interface ScreenViewProps {
	serial: string
	displayId: number
	role: MirrorRole
	label?: string
	compact?: boolean
	toolbarStart?: ReactNode
	maxSize?: number
}

export const ScreenView = ({
	serial,
	displayId,
	role,
	label,
	compact = false,
	toolbarStart,
	maxSize,
}: ScreenViewProps): JSX.Element => {
	const hostRef = useRef<HTMLDivElement>(null)
	const controlRef = useRef<ControlSocket | null>(null)
	const workerRef = useRef<Worker | null>(null)
	const retriesRef = useRef(0)
	const [phase, setPhase] = useState<Phase>({ kind: 'starting' })
	const [hasFrame, setHasFrame] = useState(false)
	const [session, setSession] = useState<string | null>(null)
	const [size, setSize] = useState<{ width: number; height: number } | null>(
		null,
	)
	const [lag, setLag] = useState(0)
	const [software, setSoftware] = useState(false)
	const [idle, setIdle] = useState(false)
	const [attempt, setAttempt] = useState(0)
	const interactive = role === 'main'
	const { note, showNote } = useNote()
	const capture = useScreenCapture({
		serial,
		role,
		sessionId: session,
		workerRef,
		showNote,
	})
	const dragging = useApkDrop({
		serial,
		hostRef,
		enabled: interactive,
		showNote,
	})
	const canCapture =
		session !== null && phase.kind === 'streaming' && hasFrame

	useEffect(() => {
		const host = hostRef.current
		if (!host) return
		let live = true
		let sessionId: string | null = null
		let lastSentClip: string | null = null
		let lastFrameAt = 0
		let framed = false
		let idleNow = false
		let failed = false
		let retryTimer = 0
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
		workerRef.current = worker

		const send = (message: ControlMessage): void => {
			controlRef.current?.send(message)
		}

		const fail = (message: string): void => {
			// A dying session reports both a state event and a closed socket.
			if (!live || failed) return
			failed = true
			const delay = RETRY_DELAYS_MS[retriesRef.current]
			setPhase({ kind: 'error', message, retrying: delay !== undefined })
			if (delay === undefined) return
			retriesRef.current += 1
			window.clearTimeout(retryTimer)
			retryTimer = window.setTimeout(() => {
				if (!live) return
				setPhase({ kind: 'starting' })
				setHasFrame(false)
				setAttempt((n) => n + 1)
			}, delay)
		}
		cleanups.push(() => window.clearTimeout(retryTimer))

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
				setSoftware(event.software)
			} else if (event.type === 'notice') {
				void info(`video ${serial}/${displayId}: ${event.message}`)
			} else if (event.type === 'frame') {
				lastFrameAt = performance.now()
				if (!framed) {
					framed = true
					retriesRef.current = 0
					setHasFrame(true)
				}
				if (idleNow) {
					idleNow = false
					setIdle(false)
				}
			} else if (event.type === 'decoder-error') {
				void error(`video decoder (${serial}): ${event.message}`)
			} else if (event.type === 'failed') {
				fail(event.message)
			} else if (event.type === 'closed') {
				fail('The video connection closed.')
			}
		}
		worker.onerror = (e: ErrorEvent): void => {
			void error(`video worker (${serial}): ${e.message}`)
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
				// A mount cancelled meanwhile (StrictMode, fast tab switch) must
				// not start a server: two main servers could both press POWER.
				if (!live) return
				const started = await startMirror(
					serial,
					displayId,
					role,
					maxSize,
				)
				if (!live) {
					void stopMirror(started.sessionId)
					return
				}
				sessionId = started.sessionId
				setSession(sessionId)
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
				void error(
					`mirror ${serial}/${displayId} failed to start: ${String(e)}`,
				)
				fail(String(e))
			}
		}
		void start()

		onSessionState((state) => {
			if (!live || state.sessionId !== sessionId) return
			if (state.state === 'error' || state.state === 'stopped') {
				fail(state.error ?? 'The mirror stopped.')
			}
		})
			.then((unlisten) => (live ? cleanups.push(unlisten) : unlisten()))
			.catch(() => undefined)

		if (interactive) {
			const pressed = new Set<number>()
			const pendingMoves = new Map<number, ControlMessage>()
			const downKeys = new Map<string, number>()
			let special: number | null = null
			let frame = 0
			let repeat = 0
			const flushMoves = (): void => {
				frame = 0
				for (const move of pendingMoves.values()) send(move)
				pendingMoves.clear()
			}
			const queueMove = (
				pointerId: number,
				message: ControlMessage,
			): void => {
				pendingMoves.set(pointerId, message)
				if (!frame) frame = requestAnimationFrame(flushMoves)
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
			const specialDown = (button: number): void => {
				special = button
				if (button === 2) send({ t: 'backOrScreenOn', action: 0 })
				else if (button === 1) key(KEY.HOME, 0)
				else if (button === 3) key(KEY.APP_SWITCH, 0)
			}
			const specialUp = (): void => {
				if (special === 2) send({ t: 'backOrScreenOn', action: 1 })
				else if (special === 1) key(KEY.HOME, 1)
				else if (special === 3) key(KEY.APP_SWITCH, 1)
				special = null
			}

			const onPointerDown = (e: PointerEvent): void => {
				canvas.focus()
				e.preventDefault()
				canvas.setPointerCapture(e.pointerId)
				if (e.button === 0) {
					flushMoves()
					pressed.add(e.pointerId)
					sendIf(touch(e, 0, 1, 1, 1))
				} else if (e.button === 4) {
					send({ t: 'expandNotifications' })
				} else if (special === null) {
					specialDown(e.button)
				}
			}
			const onPointerMove = (e: PointerEvent): void => {
				if (pressed.has(e.pointerId)) {
					const move = touch(e, 2, 1, 0, 1)
					if (move) queueMove(e.pointerId, move)
				} else if (e.pointerType === 'mouse' && video.width) {
					const { inside } = toDevice(
						e,
						canvas,
						video.width,
						video.height,
					)
					const hover = inside ? touch(e, 7, 0, 0, 0) : null
					if (hover) queueMove(e.pointerId, hover)
				}
			}
			// pointerup fires once, for the last released button: release
			// everything this pointer holds, whatever `e.button` says.
			const onPointerUp = (e: PointerEvent): void => {
				if (pressed.has(e.pointerId)) {
					flushMoves()
					pressed.delete(e.pointerId)
					sendIf(touch(e, 1, 0, 1, 0))
				}
				if (special !== null && e.pointerType === 'mouse') specialUp()
			}
			const onWheel = (e: WheelEvent): void => {
				e.preventDefault()
				if (!video.width) return
				const { x, y, inside } = toDevice(
					e,
					canvas,
					video.width,
					video.height,
				)
				if (!inside) return
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
				if (mapped.kind === 'paste') {
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
					return
				}
				const { message } = mapped
				if (message.t === 'key') {
					// Only release keys this canvas pressed (not app shortcuts or Ctrl+V).
					if (action === 0) downKeys.set(e.code, message.keycode)
					else if (!downKeys.delete(e.code)) return
				}
				send(message)
			}
			const onKeyDown = (e: KeyboardEvent): void => onKey(e, 0)
			const onKeyUp = (e: KeyboardEvent): void => onKey(e, 1)
			const onBlur = (): void => {
				for (const keycode of downKeys.values()) key(keycode, 1)
				downKeys.clear()
			}
			const onContextMenu = (e: Event): void => e.preventDefault()

			canvas.addEventListener('pointerdown', onPointerDown)
			canvas.addEventListener('pointermove', onPointerMove)
			canvas.addEventListener('pointerup', onPointerUp)
			canvas.addEventListener('pointercancel', onPointerUp)
			canvas.addEventListener('wheel', onWheel, { passive: false })
			canvas.addEventListener('keydown', onKeyDown)
			canvas.addEventListener('keyup', onKeyUp)
			canvas.addEventListener('blur', onBlur)
			canvas.addEventListener('contextmenu', onContextMenu)
			cleanups.push(() => {
				if (frame) cancelAnimationFrame(frame)
			})

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
			workerRef.current = null
			setSession(null)
			worker.terminate()
			canvas.remove()
			cleanups.forEach((cleanup) => cleanup())
		}
	}, [serial, displayId, role, interactive, attempt, maxSize])

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
				showNote(state === 'Awake' ? 'Screen on' : 'Screen off'),
			)
			.catch((e: unknown) =>
				showNote(`Power failed: ${String(e)}`, { error: true }),
			)
	}
	const reveal = (path: string): void => {
		revealFile(path).catch((e: unknown) => {
			void error(`reveal failed: ${String(e)}`)
		})
	}
	const retry = (): void => {
		retriesRef.current = 0
		setPhase({ kind: 'starting' })
		setHasFrame(false)
		setAttempt((n) => n + 1)
	}
	const resetVideo = (): void => {
		controlRef.current?.send({ t: 'resetVideo', force: true })
	}
	const buttonText = (icon: string, text: string): string =>
		compact ? icon : `${icon} ${text}`
	const revealPath = note?.revealPath ?? null
	const captureButtons = (
		<CaptureButtons
			compact={compact}
			canCapture={canCapture}
			shooting={capture.shooting}
			recordingSince={capture.recordingSince}
			recordingBusy={capture.recordingBusy}
			onScreenshot={capture.takeScreenshot}
			onToggleRecording={capture.toggleRecording}
		/>
	)

	return (
		<div
			className={
				interactive ? 'screen screen-main' : 'screen screen-customer'
			}
		>
			{interactive ? (
				<div
					className={
						compact ? 'screen-toolbar compact' : 'screen-toolbar'
					}
				>
					{toolbarStart}
					<button
						onClick={() => press(KEY.BACK)}
						title='Back (right-click)'
					>
						{buttonText('◀', 'Back')}
					</button>
					<button
						onClick={() => press(KEY.HOME)}
						title='Home (middle-click)'
					>
						{buttonText('⌂', 'Home')}
					</button>
					<button
						onClick={() => press(KEY.APP_SWITCH)}
						title='Recents'
					>
						{buttonText('▢', 'Recents')}
					</button>
					<button
						onClick={togglePower}
						title='Screen on/off (never WAKEUP)'
					>
						{buttonText('⏻', 'Power')}
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
						onClick={resetVideo}
						title='Ask for a fresh key frame'
					>
						{buttonText('⟳', 'Reset video')}
					</button>
					{captureButtons}
					<span className='spacer' />
					<span className='muted'>
						{compact
							? `lag ${lag}`
							: `${size ? `${size.width}×${size.height}` : '…'} · lag ${lag}`}
						{software && ' · sw'}
					</span>
				</div>
			) : (
				<div className='screen-label'>
					<span>{label ?? 'Customer screen'}</span>
					{captureButtons}
					<span className='spacer' />
					<span className='muted'>
						{size ? `${size.width}×${size.height}` : ''} · view only
					</span>
				</div>
			)}
			<div className='screen-host' ref={hostRef}>
				{phase.kind === 'starting' && (
					<div className='screen-overlay'>Starting mirror…</div>
				)}
				{phase.kind === 'streaming' && !hasFrame && (
					<div className='screen-overlay faint'>
						Waiting for video…
					</div>
				)}
				{phase.kind === 'error' && (
					<div className='screen-overlay err'>
						<span>{phase.message}</span>
						{phase.retrying ? (
							<span className='muted'>Retrying…</span>
						) : (
							<button onClick={retry}>Retry</button>
						)}
					</div>
				)}
				{phase.kind === 'streaming' &&
					hasFrame &&
					idle &&
					!interactive && (
						<div className='screen-overlay faint'>No content</div>
					)}
				{note && (
					<div
						className={
							note.error ? 'screen-note err' : 'screen-note'
						}
					>
						<span>{note.text}</span>
						{revealPath !== null && (
							<button
								className='link'
								onClick={() => reveal(revealPath)}
							>
								Show in folder
							</button>
						)}
					</div>
				)}
				{dragging && (
					<div className='drop-overlay'>
						Drop to install on {serial}
					</div>
				)}
			</div>
		</div>
	)
}
