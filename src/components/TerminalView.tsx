import '@xterm/xterm/css/xterm.css'

import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { type JSX, useEffect, useRef, useState } from 'react'

import { getEndpoint } from '../lib/ipc'
import { warn } from '../lib/log'
import type { TerminalStarted } from '../lib/terminal'
import { TERMINAL_FONT, TERMINAL_THEME } from '../lib/terminal-theme'
import { connect } from '../lib/ws'
import { registerControls } from '../state/terminals'
import { Icon } from './Icon'

const RECONNECT_MS = 1000
const DIM = '\x1b[90m'
const RESET = '\x1b[0m'

interface ExitMessage {
	t: 'exit'
	code: number | null
}

interface ExitState {
	code: number | null
}

const exitText = (code: number | null): string =>
	code === null ? 'Session ended' : `Exited with code ${code}`

const isExitMessage = (value: unknown): value is ExitMessage =>
	typeof value === 'object' &&
	value !== null &&
	't' in value &&
	value.t === 'exit'

const parseControl = (text: string): ExitMessage | null => {
	try {
		const value: unknown = JSON.parse(text)
		return isExitMessage(value) ? value : null
	} catch {
		return null
	}
}

interface TerminalViewProps {
	session: TerminalStarted
	hidden: boolean
	onRestart: () => void
}

export const TerminalView = ({
	session,
	hidden,
	onRestart,
}: TerminalViewProps): JSX.Element => {
	const hostRef = useRef<HTMLDivElement>(null)
	const restartRef = useRef(onRestart)
	const [exit, setExit] = useState<ExitState | null>(null)

	useEffect(() => {
		restartRef.current = onRestart
	})

	useEffect(() => {
		const host = hostRef.current
		if (!host) return
		const term = new Terminal({
			fontFamily: TERMINAL_FONT,
			fontSize: 13,
			lineHeight: 1.1,
			theme: TERMINAL_THEME,
			minimumContrastRatio: 4.5,
			cursorStyle: 'bar',
			cursorWidth: 2,
			cursorBlink: true,
			scrollback: 10_000,
		})
		const fit = new FitAddon()
		term.loadAddon(fit)
		term.open(host)
		const encoder = new TextEncoder()
		let socket: WebSocket | null = null
		let live = true
		let exited = false
		let timer = 0

		const send = (data: string): void => {
			if (socket?.readyState === WebSocket.OPEN) {
				socket.send(encoder.encode(data))
			}
		}
		const sendSize = (): void => {
			if (socket?.readyState === WebSocket.OPEN) {
				socket.send(
					JSON.stringify({
						t: 'resize',
						cols: term.cols,
						rows: term.rows,
					}),
				)
			}
		}
		const showExit = (code: number | null): void => {
			exited = true
			setExit({ code })
			term.write(`\r\n${DIM}[${exitText(code)}]${RESET}\r\n`)
		}

		const open = async (): Promise<void> => {
			const ep = await getEndpoint()
			if (!live) return
			const ws = connect(ep, 'terminal', session.id)
			socket = ws
			ws.addEventListener('open', () => {
				term.reset()
				sendSize()
			})
			ws.addEventListener('message', (e: MessageEvent<unknown>) => {
				if (e.data instanceof ArrayBuffer) {
					term.write(new Uint8Array(e.data))
				} else if (typeof e.data === 'string') {
					const control = parseControl(e.data)
					if (control) showExit(control.code)
				}
			})
			ws.addEventListener('close', () => {
				if (live && !exited) {
					timer = window.setTimeout(
						() => void reconnect(),
						RECONNECT_MS,
					)
				}
			})
		}
		const reconnect = (): Promise<void> =>
			open().catch((e: unknown) => {
				void warn(
					`terminal ${session.id}: connect failed: ${String(e)}`,
				)
			})
		void reconnect()

		const paste = (): void => {
			readText()
				.then((text) => term.paste(text))
				.catch((e: unknown) => {
					void warn(`terminal: paste failed: ${String(e)}`)
				})
		}
		const copy = (text: string): void => {
			writeText(text).catch((e: unknown) => {
				void warn(`terminal: copy failed: ${String(e)}`)
			})
		}

		const data = term.onData((input) => {
			if (!exited) {
				send(input)
			} else if (input === '\r') {
				restartRef.current()
			}
		})
		const resize = term.onResize(sendSize)
		term.attachCustomKeyEventHandler((e) => {
			if (e.type !== 'keydown' || !e.ctrlKey || !e.shiftKey) return true
			if (e.code === 'KeyC') {
				const selection = term.getSelection()
				if (selection) copy(selection)
				return false
			}
			if (e.code === 'KeyV') {
				paste()
				return false
			}
			return true
		})
		const onContextMenu = (e: MouseEvent): void => {
			e.preventDefault()
			const selection = term.getSelection()
			if (selection) {
				copy(selection)
				term.clearSelection()
			} else {
				paste()
			}
		}
		host.addEventListener('contextmenu', onContextMenu)
		const observer = new ResizeObserver(() => {
			if (host.clientWidth > 0 && host.clientHeight > 0) fit.fit()
		})
		observer.observe(host)
		const unregister = registerControls(session.id, {
			send,
			clear: () => term.clear(),
		})

		return (): void => {
			live = false
			window.clearTimeout(timer)
			unregister()
			observer.disconnect()
			host.removeEventListener('contextmenu', onContextMenu)
			data.dispose()
			resize.dispose()
			socket?.close()
			term.dispose()
		}
	}, [session.id])

	const failed = exit !== null && exit.code !== null && exit.code !== 0

	return (
		<div className='terminal-view' hidden={hidden}>
			<div className='terminal-stage'>
				<div className='terminal-host' ref={hostRef} />
			</div>
			{exit && (
				<div
					className={
						failed ? 'terminal-exit failed' : 'terminal-exit'
					}
					role='status'
				>
					<span className={failed ? 'dot bad' : 'dot'} />
					<span>{exitText(exit.code)}</span>
					<button onClick={onRestart}>
						<Icon name='refresh' />
						{session.kind === 'device' ? 'New shell' : 'Restart'}
					</button>
					<span className='terminal-exit-hint'>or press Enter</span>
				</div>
			)}
		</div>
	)
}
