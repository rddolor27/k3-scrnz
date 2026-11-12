import { type JSX, useEffect, useState } from 'react'

import { type Endpoint, getEndpoint } from './lib/ipc'
import { error, info } from './lib/log'
import { checkLoopback, type LoopbackCheck } from './lib/ws'

type Check =
	| { phase: 'running' }
	| { phase: 'done'; endpoint: Endpoint; result: LoopbackCheck }
	| { phase: 'failed'; error: string }

// M0 screen: proves the page can reach the loopback WebSocket (spec section 14, M0).
// The device tabs replace it in M1.
export const App = (): JSX.Element => {
	const [check, setCheck] = useState<Check>({ phase: 'running' })
	const [run, setRun] = useState(0)

	useEffect(() => {
		let live = true
		const runCheck = async (): Promise<void> => {
			try {
				const endpoint = await getEndpoint()
				const result = await checkLoopback(endpoint)
				if (result.ok) {
					void info(
						`loopback check ok: ${result.bytes} B echoed in ${result.rttMs.toFixed(1)} ms`,
					)
				} else {
					void error(`loopback check failed: ${result.error}`)
				}
				if (live) setCheck({ phase: 'done', endpoint, result })
			} catch (e) {
				void error(`loopback check could not run: ${String(e)}`)
				if (live) setCheck({ phase: 'failed', error: String(e) })
			}
		}
		void runCheck()
		return (): void => {
			live = false
		}
	}, [run])

	const rerun = (): void => {
		setCheck({ phase: 'running' })
		setRun((n) => n + 1)
	}

	return (
		<div className='app'>
			<header className='topbar'>
				<span className='brand'>k3.scrnz</span>
				<span className='tag'>M0 · setup</span>
			</header>
			<main className='center'>
				<section className='card'>
					<h1>Loopback WebSocket</h1>
					<p className='muted'>
						Video and input use ws://127.0.0.1 (spec section 8.1).
						This checks that the page can reach it.
					</p>
					<dl>
						<dt>Endpoint</dt>
						<dd>
							{check.phase === 'done'
								? `ws://127.0.0.1:${check.endpoint.port}`
								: '…'}
						</dd>
						<dt>Result</dt>
						<CheckResult check={check} />
					</dl>
					<button
						disabled={check.phase === 'running'}
						onClick={rerun}
					>
						Run again
					</button>
				</section>
			</main>
		</div>
	)
}

interface CheckResultProps {
	check: Check
}

const CheckResult = ({ check }: CheckResultProps): JSX.Element => {
	if (check.phase === 'running') return <dd>checking…</dd>
	if (check.phase === 'failed') return <dd className='err'>{check.error}</dd>
	const r = check.result
	if (r.ok) {
		return (
			<dd className='ok'>
				OK · {r.bytes} B echoed in {r.rttMs.toFixed(1)} ms
			</dd>
		)
	}
	return (
		<dd className='err'>
			{r.error}. Switch video to the Channel fallback (spec section 8.1).
		</dd>
	)
}
