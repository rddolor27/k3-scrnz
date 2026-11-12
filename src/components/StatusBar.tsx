import type { JSX } from 'react'

import type { AdbStatus } from '../lib/ipc'
import type { LoopbackState } from '../state/transport'

interface StatusBarProps {
	adb: AdbStatus
	onlineCount: number
	loopback: LoopbackState
}

/** adb server, device count and transport check (spec section 11). */
export const StatusBar = ({
	adb,
	onlineCount,
	loopback,
}: StatusBarProps): JSX.Element => (
	<footer className='statusbar'>
		<AdbText adb={adb} />
		<span>
			{onlineCount} {onlineCount === 1 ? 'device' : 'devices'} online
		</span>
		<LoopbackText state={loopback} />
	</footer>
)

interface AdbTextProps {
	adb: AdbStatus
}

const AdbText = ({ adb }: AdbTextProps): JSX.Element => {
	if (adb.connected) return <span>adb server {adb.version ?? '?'}</span>
	if (!adb.error) return <span>connecting to the adb server…</span>
	return (
		<span className='err' title={adb.error}>
			adb server not reachable, retrying
		</span>
	)
}

interface LoopbackTextProps {
	state: LoopbackState
}

const LoopbackText = ({ state }: LoopbackTextProps): JSX.Element => {
	if (state.phase === 'running') return <span>WebSocket check…</span>
	if (state.phase === 'failed') {
		return (
			<span className='err' title={state.error}>
				WebSocket check failed
			</span>
		)
	}
	const { result } = state
	return result.ok ? (
		<span className='ok'>WebSocket ok ({result.rttMs.toFixed(1)} ms)</span>
	) : (
		<span className='err' title={result.error}>
			WebSocket blocked
		</span>
	)
}
