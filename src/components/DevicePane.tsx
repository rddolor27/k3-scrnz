import { type JSX, useState } from 'react'

import { stateHint, stateTone } from '../lib/device-state'
import type { DeviceView } from '../lib/ipc'
import { FileExplorer } from './FileExplorer'

type View = 'overview' | 'files'

interface DevicePaneProps {
	device: DeviceView
}

/** The selected device. Mirror, customer screen and logcat arrive in M2–M4. */
export const DevicePane = ({ device }: DevicePaneProps): JSX.Element => {
	const [view, setView] = useState<View>('overview')
	const tone = stateTone(device)
	const hint = stateHint(device)
	const online = device.state === 'device' && !device.gone

	return (
		<section className={view === 'files' ? 'pane pane-wide' : 'pane'}>
			<header className='pane-header'>
				<h1>{device.name}</h1>
				<span className={`badge ${tone}`}>
					{device.gone ? 'disconnected' : device.state}
				</span>
				<div className='views' role='tablist'>
					<button
						role='tab'
						aria-selected={view === 'overview'}
						onClick={() => setView('overview')}
					>
						Overview
					</button>
					<button
						role='tab'
						aria-selected={view === 'files'}
						onClick={() => setView('files')}
					>
						Files
					</button>
				</div>
			</header>
			{hint && <p className={`hint ${tone}`}>{hint}</p>}
			{view === 'overview' && <Overview device={device} />}
			{view === 'files' &&
				(online ? (
					<FileExplorer key={device.serial} serial={device.serial} />
				) : (
					<p className='muted'>
						Files are available while the device is connected.
					</p>
				))}
		</section>
	)
}

interface OverviewProps {
	device: DeviceView
}

const Overview = ({ device }: OverviewProps): JSX.Element => (
	<>
		<dl className='details'>
			<dt>Serial</dt>
			<dd>{device.serial}</dd>
			<dt>Model</dt>
			<dd>{device.model ?? '—'}</dd>
			<dt>Product</dt>
			<dd>{device.product ?? '—'}</dd>
			<dt>Device</dt>
			<dd>{device.device ?? '—'}</dd>
			<dt>Transport id</dt>
			<dd>{device.transportId}</dd>
		</dl>
		<p className='muted'>
			Screen mirror, customer screen and logcat are not implemented yet.
		</p>
	</>
)
