import type { JSX } from 'react'

import { stateHint, stateTone } from '../lib/device-state'
import type { DeviceView } from '../lib/ipc'

interface DevicePaneProps {
	device: DeviceView
}

/** The selected device. Mirror, customer screen and logcat arrive in M2–M4. */
export const DevicePane = ({ device }: DevicePaneProps): JSX.Element => {
	const tone = stateTone(device)
	const hint = stateHint(device)

	return (
		<section className='pane'>
			<header className='pane-header'>
				<h1>{device.name}</h1>
				<span className={`badge ${tone}`}>
					{device.gone ? 'disconnected' : device.state}
				</span>
			</header>
			{hint && <p className={`hint ${tone}`}>{hint}</p>}
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
				Screen mirror, customer screen and logcat are not implemented
				yet.
			</p>
		</section>
	)
}
