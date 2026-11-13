import { type JSX, useEffect, useRef, useState } from 'react'

import type { DeviceView } from '../lib/ipc'
import { Icon } from './Icon'

interface HiddenDevicesMenuProps {
	devices: DeviceView[]
	onShow: (serial: string) => void
	onShowAll: () => void
}

export const HiddenDevicesMenu = ({
	devices,
	onShow,
	onShowAll,
}: HiddenDevicesMenuProps): JSX.Element => {
	const [open, setOpen] = useState(false)
	const rootRef = useRef<HTMLDivElement>(null)

	useEffect(() => {
		if (!open) return
		const onPointerDown = (e: PointerEvent): void => {
			const root = rootRef.current
			if (root && e.target instanceof Node && !root.contains(e.target)) {
				setOpen(false)
			}
		}
		const onKeyDown = (e: KeyboardEvent): void => {
			if (e.key === 'Escape') setOpen(false)
		}
		window.addEventListener('pointerdown', onPointerDown)
		window.addEventListener('keydown', onKeyDown)
		return (): void => {
			window.removeEventListener('pointerdown', onPointerDown)
			window.removeEventListener('keydown', onKeyDown)
		}
	}, [open])

	return (
		<div className='hidden-menu' ref={rootRef}>
			<button
				onClick={() => setOpen((shown) => !shown)}
				aria-expanded={open}
				title='Devices hidden from All devices'
			>
				<Icon name='eyeOff' />
				Hidden ({devices.length})
				<Icon name='chevronDown' />
			</button>
			{open && (
				<div className='emulator-popover hidden-popover' role='dialog'>
					{devices.map((device) => (
						<div className='emulator-row' key={device.serial}>
							<span className='name' title={device.serial}>
								{device.name}
								<span className='muted'>
									{' '}
									· {device.serial}
								</span>
							</span>
							<button onClick={() => onShow(device.serial)}>
								Show
							</button>
						</div>
					))}
					<div className='hidden-footer'>
						<span className='muted'>
							Hidden devices keep their tabs but run no mirror
							here.
						</span>
						<button
							onClick={() => {
								onShowAll()
								setOpen(false)
							}}
						>
							Show all
						</button>
					</div>
				</div>
			)}
		</div>
	)
}
