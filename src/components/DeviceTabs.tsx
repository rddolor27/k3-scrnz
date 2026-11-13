import { type JSX, useRef, useState } from 'react'

import { stateLabel, stateTone } from '../lib/device-state'
import type { DeviceView } from '../lib/ipc'
import { Icon } from './Icon'

interface DeviceTabsProps {
	devices: DeviceView[]
	selected: string | null
	onSelect: (serial: string) => void
	onRename: (serial: string, name: string) => void
	onSelectGrid: (() => void) | null
	gridSelected: boolean
}

export const DeviceTabs = ({
	devices,
	selected,
	onSelect,
	onRename,
	onSelectGrid,
	gridSelected,
}: DeviceTabsProps): JSX.Element => {
	// Keyed by transport id too: a device removed mid-rename comes back with a
	// new one, so the input doesn't pop up again.
	const [editing, setEditing] = useState<{
		serial: string
		transportId: number
	} | null>(null)

	return (
		<div className='tabs' role='tablist'>
			{onSelectGrid && (
				<button
					role='tab'
					aria-selected={gridSelected}
					className='tab tab-grid'
					title='Every connected device in one view'
					onClick={onSelectGrid}
				>
					<Icon name='devices' />
					All devices
				</button>
			)}
			{devices.map((device, index) => {
				if (
					device.serial === editing?.serial &&
					device.transportId === editing.transportId
				) {
					return (
						<RenameInput
							key={device.serial}
							initial={device.name}
							onDone={(name) => {
								setEditing(null)
								if (name !== null && name !== device.name) {
									onRename(device.serial, name)
								}
							}}
						/>
					)
				}
				const label = stateLabel(device)
				const shortcut = index < 9 ? `Ctrl+${index + 1} · ` : ''
				return (
					<button
						key={device.serial}
						role='tab'
						aria-selected={
							!gridSelected && device.serial === selected
						}
						className={device.gone ? 'tab gone' : 'tab'}
						title={`${shortcut}double-click to rename`}
						onClick={() => onSelect(device.serial)}
						onDoubleClick={() =>
							setEditing({
								serial: device.serial,
								transportId: device.transportId,
							})
						}
					>
						<span className={`dot ${stateTone(device)}`} />
						<span className='tab-name'>{device.name}</span>
						{device.name !== device.serial && (
							<span className='tab-serial'>{device.serial}</span>
						)}
						{label && <span className='tab-note'>{label}</span>}
					</button>
				)
			})}
		</div>
	)
}

interface RenameInputProps {
	initial: string
	onDone: (name: string | null) => void
}

const RenameInput = ({ initial, onDone }: RenameInputProps): JSX.Element => {
	const [value, setValue] = useState(initial)
	const finished = useRef(false)
	const finish = (name: string | null): void => {
		if (finished.current) return
		finished.current = true
		onDone(name === null ? null : name.trim())
	}

	return (
		<input
			className='tab-rename'
			aria-label='Device name'
			autoFocus
			maxLength={40}
			value={value}
			placeholder='Model name'
			onChange={(e) => setValue(e.target.value)}
			onKeyDown={(e) => {
				if (e.key === 'Enter') finish(value)
				if (e.key === 'Escape') finish(null)
			}}
			onBlur={() => finish(value)}
		/>
	)
}
