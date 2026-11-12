import { type JSX, useEffect, useState } from 'react'

import { DeviceGrid } from './components/DeviceGrid'
import { DevicePane } from './components/DevicePane'
import { DeviceTabs } from './components/DeviceTabs'
import { EmulatorMenu } from './components/EmulatorMenu'
import { StatusBar } from './components/StatusBar'
import { type AdbStatus, setDeviceName, setVisibleDevice } from './lib/ipc'
import { error } from './lib/log'
import { FOCUS_LOG_FILTER_EVENT } from './lib/logcat'
import { useDevices } from './state/devices'
import { useLoopbackCheck } from './state/transport'

/**
 * A hidden tab (or a minimized window) keeps its mirror for this long, so
 * switching back is instant; then the session stops to save CPU (spec 8.3).
 */
const KEEP_HIDDEN_MS = 15_000

export const App = (): JSX.Element => {
	const { devices, adb } = useDevices()
	const loopback = useLoopbackCheck()
	const [selected, setSelected] = useState<string | null>(null)
	const [hiddenAt, setHiddenAt] = useState<Record<string, number>>({})
	const [paused, setPaused] = useState(false)
	const [grid, setGrid] = useState(false)
	// Falls back to the first tab when the selected device's tab is removed.
	const current =
		devices.find((d) => d.serial === selected) ?? devices[0] ?? null
	const currentSerial = current?.serial ?? null
	const onlineDevices = devices.filter((d) => d.state === 'device' && !d.gone)
	const showGrid = grid && onlineDevices.length > 0
	const visibleSerial = showGrid ? null : currentSerial

	// The grid and a device pane never mirror the same screen at once (the
	// hub replaces a session for the same screen), so no pane stays mounted.
	const selectGrid = (): void => {
		setGrid(true)
		setHiddenAt({})
	}

	const select = (serial: string): void => {
		if (showGrid) {
			setGrid(false)
			setSelected(serial)
			return
		}
		if (currentSerial && currentSerial !== serial) {
			const now = Date.now()
			setHiddenAt((hidden) => {
				const next = { ...hidden, [currentSerial]: now }
				delete next[serial]
				return next
			})
		}
		setSelected(serial)
	}

	// Drop panes that have been hidden for longer than KEEP_HIDDEN_MS.
	useEffect(() => {
		const timer = window.setInterval(() => {
			const now = Date.now()
			setHiddenAt((hidden) => {
				const kept = Object.entries(hidden).filter(
					([, at]) => now - at < KEEP_HIDDEN_MS,
				)
				return kept.length === Object.keys(hidden).length
					? hidden
					: Object.fromEntries(kept)
			})
		}, 1000)
		return (): void => window.clearInterval(timer)
	}, [])

	// A minimized window pauses mirrors after the same grace period.
	// (Tauri's backgroundThrottling is unsupported on Windows.)
	useEffect(() => {
		let timer = 0
		const onVisibility = (): void => {
			window.clearTimeout(timer)
			if (document.hidden) {
				timer = window.setTimeout(() => setPaused(true), KEEP_HIDDEN_MS)
			} else {
				setPaused(false)
			}
		}
		document.addEventListener('visibilitychange', onVisibility)
		return (): void => {
			window.clearTimeout(timer)
			document.removeEventListener('visibilitychange', onVisibility)
		}
	}, [])

	// Rust polls the visible device's displays (spec 7.1), also on focus.
	useEffect(() => {
		void setVisibleDevice(visibleSerial)
		const onFocus = (): void => void setVisibleDevice(visibleSerial)
		window.addEventListener('focus', onFocus)
		return (): void => window.removeEventListener('focus', onFocus)
	}, [visibleSerial])

	// App shortcuts (spec section 9.3), in the capture phase and stopped there,
	// so they never reach a mirrored device: Ctrl+1..9, Ctrl+(Shift+)Tab and
	// Ctrl+Shift+L (focus the log filter).
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

	const mounted = devices.filter(
		(d) =>
			!paused &&
			!showGrid &&
			(d.serial === currentSerial ||
				Object.prototype.hasOwnProperty.call(hiddenAt, d.serial)),
	)

	return (
		<div className='app'>
			<header className='topbar'>
				<span className='brand'>k3.scrnz</span>
				<DeviceTabs
					devices={devices}
					selected={currentSerial}
					onSelect={select}
					onRename={rename}
					onSelectGrid={onlineDevices.length > 0 ? selectGrid : null}
					gridSelected={showGrid}
				/>
				<EmulatorMenu onOpen={select} />
			</header>
			<main className='content'>
				{!current && <NoDevices adb={adb} />}
				{showGrid && !paused && (
					<DeviceGrid devices={onlineDevices} onOpen={select} />
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
