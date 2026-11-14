import { type JSX, useEffect, useState } from 'react'

import logoUrl from '../assets/brand/icon.svg'
import { DeviceGrid } from './components/DeviceGrid'
import { DevicePane } from './components/DevicePane'
import { DeviceTabs } from './components/DeviceTabs'
import { EmulatorManager } from './components/EmulatorManager'
import { StatusBar } from './components/StatusBar'
import { type AdbStatus, setDeviceName, setVisibleDevice } from './lib/ipc'
import { error } from './lib/log'
import { FOCUS_LOG_FILTER_EVENT } from './lib/logcat'
import { useDevices } from './state/devices'
import { useLoopbackCheck } from './state/transport'

export const App = (): JSX.Element => {
	const { devices, adb } = useDevices()
	const loopback = useLoopbackCheck()
	const [selected, setSelected] = useState<string | null>(null)
	const [visited, setVisited] = useState<ReadonlySet<string>>(() => new Set())
	const [grid, setGrid] = useState(false)
	const [gridTools, setGridTools] = useState<HTMLElement | null>(null)
	const current =
		devices.find((d) => d.serial === selected) ?? devices[0] ?? null
	const currentSerial = current?.serial ?? null
	const onlineDevices = devices.filter((d) => d.state === 'device' && !d.gone)
	const showGrid = grid && onlineDevices.length > 0
	const visibleSerial = showGrid ? null : currentSerial

	// The hub replaces a session for the same screen, so the grid and a
	// device pane must never mirror it at once.
	const selectGrid = (): void => {
		setGrid(true)
	}

	const select = (serial: string): void => {
		setVisited((prev) => {
			const keep = [serial, currentSerial].filter(
				(s): s is string => s !== null && !prev.has(s),
			)
			return keep.length === 0 ? prev : new Set([...prev, ...keep])
		})
		setGrid(false)
		setSelected(serial)
	}

	useEffect(() => {
		void setVisibleDevice(visibleSerial)
		const onFocus = (): void => void setVisibleDevice(visibleSerial)
		window.addEventListener('focus', onFocus)
		return (): void => window.removeEventListener('focus', onFocus)
	}, [visibleSerial])

	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent): void => {
			if (!e.ctrlKey || e.altKey || e.metaKey) return
			if (e.target instanceof HTMLInputElement) return
			const handled = (): void => {
				e.preventDefault()
				e.stopPropagation()
			}
			if (e.shiftKey && e.code === 'KeyL') {
				handled()
				window.dispatchEvent(new Event(FOCUS_LOG_FILTER_EVENT))
				return
			}
			if (devices.length === 0) return
			if (e.key === 'Tab') {
				handled()
				const index = devices.findIndex(
					(d) => d.serial === currentSerial,
				)
				const step = e.shiftKey ? -1 : 1
				const next =
					devices[(index + step + devices.length) % devices.length]
				if (next) select(next.serial)
				return
			}
			const digit = /^Digit([1-9])$/.exec(e.code)
			if (!digit || e.shiftKey) return
			handled()
			const target = devices[Number(digit[1]) - 1]
			if (target) select(target.serial)
		}
		window.addEventListener('keydown', onKeyDown, { capture: true })
		return (): void =>
			window.removeEventListener('keydown', onKeyDown, { capture: true })
	})

	const rename = (serial: string, name: string): void => {
		setDeviceName(serial, name).catch((e: unknown) => {
			void error(`renaming ${serial} failed: ${String(e)}`)
		})
	}

	// Opened panes stay mounted and a hidden screen keeps its last frame, so returning never shows a black canvas.
	const mounted = showGrid
		? []
		: devices.filter(
				(d) => d.serial === currentSerial || visited.has(d.serial),
			)

	return (
		<div className='app'>
			<header className='topbar'>
				<span className='brand'>
					<img className='brand-mark' src={logoUrl} alt='' />
					tri.scrnz
				</span>
				<DeviceTabs
					devices={devices}
					selected={currentSerial}
					onSelect={select}
					onRename={rename}
					onSelectGrid={onlineDevices.length > 0 ? selectGrid : null}
					gridSelected={showGrid}
				/>
				<span className='topbar-tools' ref={setGridTools} />
				<EmulatorManager onOpen={select} />
			</header>
			<main className='content'>
				{!current && <NoDevices adb={adb} />}
				{showGrid && (
					<DeviceGrid
						devices={onlineDevices}
						onOpen={select}
						toolsSlot={gridTools}
					/>
				)}
				{mounted.map((device) => (
					<div
						key={device.serial}
						className='pane-slot'
						hidden={device.serial !== currentSerial}
					>
						<DevicePane device={device} />
					</div>
				))}
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
					Connect a device over USB with USB debugging turned on, or
					start one under Emulators.
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
