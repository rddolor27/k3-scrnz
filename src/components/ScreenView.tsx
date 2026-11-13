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
import { registerTap } from '../video/frame-taps'
import type { WorkerEvent, WorkerInit, WorkerRequest } from '../video/protocol'
import { CaptureButtons } from './CaptureButtons'
import { IconButton } from './IconButton'

const IDLE_AFTER_MS = 3000
const RETRY_DELAYS_MS = [1000, 2000, 5000]
// Every running server costs the device an encoder and ~80 MB of RAM.
const SUSPEND_AFTER_MS = 30_000
// Streams whose hardware decoder held frames back start in software next time.
const softwareStreams = new Set<string>()

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
	tapLabel?: string
}

export const ScreenView = ({
	serial,
	displayId,
	role,
	label,
	compact = false,
	toolbarStart,
	maxSize,
	tapLabel,
}: ScreenViewProps): JSX.Element => {
	const hostRef = useRef<HTMLDivElement>(null)
	const controlRef = useRef<ControlSocket | null>(null)
	const workerRef = useRef<Worker | null>(null)
	const retriesRef = useRef(0)
	const staleRef = useRef<HTMLCanvasElement | null>(null)
	const [tapWorker, setTapWorker] = useState<Worker | null>(null)
	const [phase, setPhase] = useState<Phase>({ kind: 'starting' })
	const [hasFrame, setHasFrame] = useState(false)
	const [session, setSession] = useState<string | null>(null)
	const [size, setSize] = useState<{ width: number; height: number } | null>(
		null,
	)
	const [lag, setLag] = useState(0)
	const [software, setSoftware] = useState(false)
	const [blank, setBlank] = useState(false)
	const [attempt, setAttempt] = useState(0)
	const [suspended, setSuspended] = useState(false)
	const [stale, setStale] = useState(false)
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
		session !== null && phase.kind === 'streaming' && hasFrame && !stale
	const suspendable =
		tapLabel === undefined && capture.recordingSince === null
	const suspendableRef = useRef(suspendable)

	useEffect(() => {
		suspendableRef.current = suspendable
	}, [suspendable])

	useEffect(() => {
		const host = hostRef.current
		if (!host) return
		const cleanups: (() => void)[] = []
		// A hidden pane or tab has a 0×0 host; minimized windows set document.hidden.
		const isShown = (): boolean =>
			!document.hidden && host.clientWidth > 0 && host.clientHeight > 0
		const watchVisibility = (report: () => void): void => {
			const observer = new ResizeObserver(report)
			observer.observe(host)
			document.addEventListener('visibilitychange', report)
			cleanups.push(() => {
				observer.disconnect()
				document.removeEventListener('visibilitychange', report)
			})
		}

		if (suspended) {
			let resumed = false
			watchVisibility(() => {
				if (resumed || !isShown()) return
				resumed = true
				void info(
					`mirror ${serial}/${displayId}: shown again, resuming`,
				)
				retriesRef.current = 0
				setPhase((p) => (p.kind === 'error' ? { kind: 'starting' } : p))
				setSuspended(false)
			})
			return (): void => cleanups.forEach((cleanup) => cleanup())
		}

		let live = true
		let sessionId: string | null = null
		let lastSentClip: string | null = null
		let lastFrameAt = 0
		let framed = false
		let idleNow = false
		let failed = false
		let retryTimer = 0
		const video = { width: 0, height: 0 }
		const streamKey = `${serial}/${displayId}/${maxSize ?? 0}`

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

		const keepStale = (bitmap: ImageBitmap): void => {
			const still = document.createElement('canvas')
			still.className = 'screen-stale'
			still.width = bitmap.width
			still.height = bitmap.height
			const renderer = still.getContext('bitmaprenderer')
			if (!renderer) {
				bitmap.close()
				return
			}
			renderer.transferFromImageBitmap(bitmap)
			staleRef.current?.remove()
			host.prepend(still)
			staleRef.current = still
			setStale(true)
		}
		const dropStale = (): void => {
			if (!staleRef.current) return
			staleRef.current.remove()
			staleRef.current = null
			setStale(false)
		}

		let shown = isShown()
		let suspendTimer = 0
		const suspendLater = (): void => {
			window.clearTimeout(suspendTimer)
			suspendTimer = window.setTimeout(() => {
				if (!live || shown) return
				if (!suspendableRef.current) {
					suspendLater()
					return
				}
				const request: WorkerRequest = { type: 'snapshot' }
				worker.postMessage(request)
			}, SUSPEND_AFTER_MS)
		}
		const reportVisibility = (): void => {
			const next = isShown()
			if (next === shown) return
			shown = next
			const request: WorkerRequest = { type: 'visibility', visible: next }
			worker.postMessage(request)
			if (next) window.clearTimeout(suspendTimer)
			else suspendLater()
		}
		if (!shown) {
			const request: WorkerRequest = {
				type: 'visibility',
				visible: false,
			}
			worker.postMessage(request)
			suspendLater()
		}
		watchVisibility(reportVisibility)
		cleanups.push(() => window.clearTimeout(suspendTimer))

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
				if (event.software) softwareStreams.add(streamKey)
			} else if (event.type === 'notice') {
				void info(`video ${serial}/${displayId}: ${event.message}`)
			} else if (event.type === 'frame') {
				lastFrameAt = performance.now()
				if (!framed) {
					framed = true
					retriesRef.current = 0
					setHasFrame(true)
					dropStale()
				}
				if (idleNow) {
					idleNow = false
					setBlank(false)
				}
			} else if (event.type === 'blank') {
				if (idleNow) setBlank(event.blank)
			} else if (event.type === 'decoder-error') {
				void error(`video decoder (${serial}): ${event.message}`)
			} else if (event.type === 'failed') {
				fail(event.message)
			} else if (event.type === 'closed') {
				fail('The video connection closed.')
			} else if (event.type === 'snapshot') {
				if (!live || shown) {
					event.bitmap?.close()
					return
				}
				if (event.bitmap) keepStale(event.bitmap)
				void info(
					`mirror ${serial}/${displayId}: hidden for ${SUSPEND_AFTER_MS / 1000} s, stopping until shown`,
				)
				setSuspended(true)
			}
		}
		worker.onerror = (e: ErrorEvent): void => {
			void error(`video worker (${serial}): ${e.message}`)
		}

		const idleTimer = window.setInterval(() => {
			const isIdle =
				lastFrameAt > 0 &&
				performance.now() - lastFrameAt > IDLE_AFTER_MS
			if (!isIdle || idleNow) return
			idleNow = true
			if (interactive) return
			// A still screen sends no frames either; only a black one is empty.
			const request: WorkerRequest = { type: 'blank' }
			worker.postMessage(request)
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
					software: softwareStreams.has(streamKey),
				}
				worker.postMessage(init, [offscreen])
				setTapWorker(worker)
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
			setTapWorker(null)
			setBlank(false)
			worker.terminate()
			canvas.remove()
			cleanups.forEach((cleanup) => cleanup())
		}
	}, [serial, displayId, role, interactive, attempt, maxSize, suspended])

	useEffect(() => {
		if (tapLabel === undefined || !tapWorker) return
		return registerTap({ key: serial, label: tapLabel, worker: tapWorker })
	}, [serial, tapLabel, tapWorker])

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
	const rotateDevice = (): void => {
		controlRef.current?.send({ t: 'rotateDevice' })
	}
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
					<span
						className='tool-group'
						role='group'
						aria-label='Navigation'
					>
						<IconButton
							icon='back'
							label='Back'
							hint='Back (or right-click the screen)'
							onClick={() => press(KEY.BACK)}
						/>
						<IconButton
							icon='home'
							label='Home'
							hint='Home (or middle-click the screen)'
							onClick={() => press(KEY.HOME)}
						/>
						<IconButton
							icon='recents'
							label='Recent apps'
							onClick={() => press(KEY.APP_SWITCH)}
						/>
					</span>
					<span
						className='tool-group'
						role='group'
						aria-label='Hardware keys'
					>
						<IconButton
							icon='power'
							label='Power'
							hint='Screen on/off'
							onClick={togglePower}
						/>
						<IconButton
							icon='volumeDown'
							label='Volume down'
							onClick={() => press(KEY.VOLUME_DOWN)}
						/>
						<IconButton
							icon='volumeUp'
							label='Volume up'
							onClick={() => press(KEY.VOLUME_UP)}
						/>
						<IconButton
							icon='rotate'
							label='Rotate device'
							hint='Rotate the device between portrait and landscape (apps locked to one orientation stay put)'
							onClick={rotateDevice}
						/>
					</span>
					{captureButtons}
					<span className='spacer' />
					<span
						className='screen-stats'
						title='Stream size · frames decoded behind real time'
					>
						{compact
							? `lag ${lag}`
							: `${size ? `${size.width}×${size.height}` : '…'} · lag ${lag}`}
						{software && ' · software decode'}
					</span>
					<IconButton
						icon='refresh'
						label='Reset video'
						hint='Reset video: ask the device for a fresh key frame'
						onClick={resetVideo}
					/>
				</div>
			) : (
				<div className='screen-label'>
					<span>{label ?? 'Customer screen'}</span>
					{captureButtons}
					<span className='spacer' />
					<span className='screen-stats'>
						{size ? `${size.width}×${size.height} · ` : ''}view only
					</span>
				</div>
			)}
			<div className='screen-host' ref={hostRef}>
				{phase.kind === 'starting' && !stale && (
					<div className='screen-overlay'>Starting mirror…</div>
				)}
				{phase.kind === 'streaming' && !hasFrame && !stale && (
					<div className='screen-overlay faint'>
						Waiting for video…
					</div>
				)}
				{stale && phase.kind !== 'error' && (
					<div className='screen-overlay faint'>Reconnecting…</div>
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
					blank &&
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
