import { type JSX, useEffect, useState } from 'react'

import { DevicePane } from './components/DevicePane'
import { DeviceTabs } from './components/DeviceTabs'
import { StatusBar } from './components/StatusBar'
import { type AdbStatus, setDeviceName } from './lib/ipc'
import { error } from './lib/log'
import { useDevices } from './state/devices'
import { useLoopbackCheck } from './state/transport'

export const App = (): JSX.Element => {
	const { devices, adb } = useDevices()
	const loopback = useLoopbackCheck()
	const [selected, setSelected] = useState<string | null>(null)
	// Falls back to the first tab when the selected device's tab is removed.
	const current =
		devices.find((d) => d.serial === selected) ?? devices[0] ?? null

	// App shortcuts (spec section 9.3): Ctrl+1..9 and Ctrl+(Shift+)Tab. Capture
	// phase, so they are handled before anything forwards keys to a device.
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent): void => {
			if (!e.ctrlKey || e.altKey || e.metaKey || devices.length === 0) {
				return
			}
			if (e.target instanceof HTMLInputElement) return
			if (e.key === 'Tab') {
				e.preventDefault()
				const index = devices.findIndex(
					(d) => d.serial === current?.serial,
				)
				const step = e.shiftKey ? -1 : 1
				const next =
					devices[(index + step + devices.length) % devices.length]
				if (next) setSelected(next.serial)
				return
			}
			const digit = /^Digit([1-9])$/.exec(e.code)
			if (!digit || e.shiftKey) return
			e.preventDefault()
			const target = devices[Number(digit[1]) - 1]
			if (target) setSelected(target.serial)
		}
		window.addEventListener('keydown', onKeyDown, { capture: true })
		return (): void =>
			window.removeEventListener('keydown', onKeyDown, { capture: true })
	}, [devices, current])

	const rename = (serial: string, name: string): void => {
		setDeviceName(serial, name).catch((e: unknown) => {
			void error(`renaming ${serial} failed: ${String(e)}`)
		})
	}

	return (
		<div className='app'>
			<header className='topbar'>
				<span className='brand'>k3.scrnz</span>
				<DeviceTabs
					devices={devices}
					selected={current?.serial ?? null}
					onSelect={setSelected}
					onRename={rename}
				/>
			</header>
			<main className='content'>
				{current ? (
					<DevicePane device={current} />
				) : (
					<NoDevices adb={adb} />
				)}
			</main>
			<StatusBar
				adb={adb}
				onlineCount={
					devices.filter((d) => d.state === 'device' && !d.gone)
						.length
				}
				loopback={loopback}
			/>
		</div>
	)
}

interface NoDevicesProps {
	adb: AdbStatus
}

const NoDevices = ({ adb }: NoDevicesProps): JSX.Element => (
	<section className='empty'>
		{adb.connected ? (
			<>
				<h1>No devices</h1>
				<p className='muted'>
					Connect a device over USB with USB debugging turned on.
				</p>
			</>
		) : (
			<>
				<h1>Waiting for the adb server</h1>
				<p className='muted'>{adb.error ?? 'Connecting…'}</p>
			</>
		)}
	</section>
)
