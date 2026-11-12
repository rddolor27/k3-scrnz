import { useEffect, useState } from 'react'

import { getEndpoint } from '../lib/ipc'
import { error, info } from '../lib/log'
import { checkLoopback, type LoopbackCheck } from '../lib/ws'

export type LoopbackState =
	| { phase: 'running' }
	| { phase: 'done'; result: LoopbackCheck }
	| { phase: 'failed'; error: string }

export const useLoopbackCheck = (): LoopbackState => {
	const [state, setState] = useState<LoopbackState>({ phase: 'running' })

	useEffect(() => {
		let live = true
		const run = async (): Promise<void> => {
			try {
				const result = await checkLoopback(await getEndpoint())
				if (result.ok) {
					void info(
						`loopback check ok: ${result.bytes} B echoed in ${result.rttMs.toFixed(1)} ms`,
					)
				} else {
					void error(`loopback check failed: ${result.error}`)
				}
				if (live) setState({ phase: 'done', result })
			} catch (e) {
				void error(`loopback check could not run: ${String(e)}`)
				if (live) setState({ phase: 'failed', error: String(e) })
			}
		}
		void run()
		return (): void => {
			live = false
		}
	}, [])

	return state
}
