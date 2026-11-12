import type { JSX } from 'react'

import type { AdbStatus, AppStats } from '../lib/ipc'
import { useAppStats } from '../state/app-stats'
import type { LoopbackState } from '../state/transport'

const RAM_TARGET_BYTES = 300 * 1024 * 1024

interface StatusBarProps {
	adb: AdbStatus
	onlineCount: number
	loopback: LoopbackState
}

export const StatusBar = ({
	adb,
	onlineCount,
	loopback,
}: StatusBarProps): JSX.Element => {
	const stats = useAppStats()
	return (
		<footer className='statusbar'>
			<AdbText adb={adb} />
			<span>
				{onlineCount} {onlineCount === 1 ? 'device' : 'devices'} online
			</span>
			<LoopbackText state={loopback} />
			<span className='spacer' />
			{stats && <StatsText stats={stats} />}
		</footer>
	)
}

interface StatsTextProps {
	stats: AppStats
}

const MIB = 1024 * 1024

const StatsText = ({ stats }: StatsTextProps): JSX.Element => {
	const mb = Math.round(stats.memoryBytes / MIB)
	const emulatorGb = stats.emulatorMemoryBytes / (1024 * MIB)
	return (
		<>
			<span
				className={
					stats.memoryBytes > RAM_TARGET_BYTES ? 'warn' : undefined
				}
				title={`k3.scrnz and ${stats.processes - 1} WebView2 processes; RAM is the summed working set`}
			>
				CPU {stats.cpuPercent.toFixed(1)}% · RAM {mb} MB
			</span>
			{stats.emulatorMemoryBytes > 0 && (
				<span title='Emulators started from k3.scrnz'>
					Emulator CPU {stats.emulatorCpuPercent.toFixed(1)}% · RAM{' '}
					{emulatorGb.toFixed(1)} GB
				</span>
			)}
		</>
	)
}

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
