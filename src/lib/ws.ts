import type { Endpoint } from './ipc'

export type Role = 'video' | 'control' | 'echo' | 'record' | 'terminal'

export const connect = (
	ep: Endpoint,
	role: Role,
	sessionId: string | null = null,
): WebSocket => {
	const ws = new WebSocket(`ws://127.0.0.1:${ep.port}`)
	ws.binaryType = 'arraybuffer'
	ws.addEventListener(
		'open',
		() => ws.send(JSON.stringify({ token: ep.token, sessionId, role })),
		{ once: true },
	)
	return ws
}

export type LoopbackCheck =
	| { ok: true; rttMs: number; bytes: number }
	| { ok: false; error: string }

// Fails when Chromium's Local Network Access blocks or prompts (release builds).
export const checkLoopback = (
	ep: Endpoint,
	timeoutMs = 5000,
): Promise<LoopbackCheck> =>
	new Promise((resolve) => {
		const probe = Uint8Array.from({ length: 64 }, (_, i) => i)
		let ws: WebSocket
		try {
			ws = connect(ep, 'echo')
		} catch (e) {
			resolve({ ok: false, error: String(e) })
			return
		}

		let sentAt = 0
		// Runs only from socket events or the timer below, after both exist.
		const finish = (result: LoopbackCheck): void => {
			clearTimeout(timer)
			ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null
			ws.close()
			resolve(result)
		}
		const timer = setTimeout(
			() =>
				finish({ ok: false, error: `no echo within ${timeoutMs} ms` }),
			timeoutMs,
		)

		ws.onopen = (): void => {
			sentAt = performance.now()
			ws.send(probe)
		}
		ws.onmessage = (ev): void => {
			const got =
				ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : null
			const same =
				got !== null &&
				got.length === probe.length &&
				got.every((b, i) => b === probe[i])
			finish(
				same
					? {
							ok: true,
							rttMs: performance.now() - sentAt,
							bytes: probe.length,
						}
					: { ok: false, error: 'echo did not match the probe' },
			)
		}
		ws.onerror = (): void =>
			finish({ ok: false, error: 'WebSocket error (refused or blocked)' })
		ws.onclose = (ev): void =>
			finish({
				ok: false,
				error: `closed before echo (code ${ev.code}${ev.reason ? `: ${ev.reason}` : ''})`,
			})
	})
