import type { Endpoint } from './ipc'
import { connect } from './ws'

export type ControlMessage =
	| { t: 'key'; action: 0 | 1; keycode: number; repeat: number; meta: number }
	| { t: 'text'; text: string }
	| {
			t: 'touch'
			action: 0 | 1 | 2 | 7
			pointerId: number
			x: number
			y: number
			w: number
			h: number
			pressure: number
			actionButton: number
			buttons: number
	  }
	| {
			t: 'scroll'
			x: number
			y: number
			w: number
			h: number
			hscroll: number
			vscroll: number
			buttons: number
	  }
	| { t: 'backOrScreenOn'; action: 0 | 1 }
	| { t: 'setClipboard'; text: string; paste: boolean }
	| { t: 'getClipboard'; copyKey: 0 | 1 | 2 }
	// `force` skips Rust's 1 s rate limit (toolbar button only).
	| { t: 'resetVideo'; force?: boolean }
	| { t: 'expandNotifications' }
	| { t: 'collapsePanels' }
	| { t: 'rotateDevice' }

export interface ControlSocket {
	send: (message: ControlMessage) => void
	close: () => void
}

export const openControl = (ep: Endpoint, sessionId: string): ControlSocket => {
	const ws = connect(ep, 'control', sessionId)
	const queue: string[] = []
	// Registered after connect()'s hello listener, so the hello goes first.
	ws.addEventListener('open', () => {
		for (const text of queue.splice(0)) ws.send(text)
	})
	return {
		send: (message: ControlMessage): void => {
			const text = JSON.stringify(message)
			if (ws.readyState === WebSocket.OPEN) ws.send(text)
			else if (ws.readyState === WebSocket.CONNECTING) queue.push(text)
		},
		close: (): void => ws.close(),
	}
}
