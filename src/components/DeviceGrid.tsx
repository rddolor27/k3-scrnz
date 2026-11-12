import type { JSX } from 'react'

import type { DeviceView } from '../lib/ipc'
import { ScreenView } from './ScreenView'

/** Tiles stream at most this size: several decoders at 1920 cost too much. */
const GRID_MAX_SIZE = 1280

interface DeviceGridProps {
	devices: DeviceView[]
	onOpen: (serial: string) => void
}

/**
 * Every connected POS's main screen in one view, each tile controllable
 * (user request 2026-11-12, not in SPEC v1). Customer screens, logcat and
 * files stay in the device tabs.
 */
export const DeviceGrid = ({
	devices,
	onOpen,
}: DeviceGridProps): JSX.Element => {
	if (devices.length === 0) {
		return (
			<section className='empty'>
				<h1>No POS devices</h1>
				<p className='muted'>
					Each connected device shows up here as a tile.
				</p>
			</section>
		)
	}
	return (
		<div className='device-grid'>
			{devices.map((device) => (
				<div className='grid-tile' key={device.serial}>
					<ScreenView
						serial={device.serial}
						displayId={0}
						role='main'
						compact
						maxSize={GRID_MAX_SIZE}
						toolbarStart={
							<button
								className='tile-name'
								onClick={() => onOpen(device.serial)}
								title={`${device.serial} · open its tab`}
							>
								{device.name}
							</button>
						}
					/>
				</div>
			))}
		</div>
	)
}
