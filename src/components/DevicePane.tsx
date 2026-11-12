import { type JSX, useEffect, useRef, useState } from 'react'

import { stateHint, stateTone } from '../lib/device-state'
import { type DeviceView, isEmulator, stopEmulator } from '../lib/ipc'
import { warn } from '../lib/log'
import { CustomerScreens, useCustomerDisplays } from './CustomerScreens'
import { FileExplorer } from './FileExplorer'
import { LogcatPanel } from './LogcatPanel'
import { ScreenView } from './ScreenView'

type View = 'screen' | 'files' | 'info'

const LOG_HEIGHT_KEY = 'k3.logHeight'
const CUSTOMER_KEY = 'k3.customerPanel'
const MIN_LOG = 120
const KEEP_SCREEN_MS = 15_000
/** The emulator encodes video in software; a smaller stream keeps lag low. */
const EMULATOR_MAX_SIZE = 1280

const readNumber = (key: string, fallback: number): number => {
	try {
		const value = Number(window.localStorage.getItem(key))
		return Number.isFinite(value) && value > 0 ? value : fallback
	} catch {
		return fallback
	}
}

const save = (key: string, value: string): void => {
	try {
		window.localStorage.setItem(key, value)
	} catch {
		// Storage can be unavailable; the layout just isn't remembered.
	}
}

interface DevicePaneProps {
	device: DeviceView
}

/** The selected device: screen + customer screen + logcat, files, or info. */
export const DevicePane = ({ device }: DevicePaneProps): JSX.Element => {
	const [view, setView] = useState<View>('screen')
	// The screen stays mounted (hidden) for a while after switching to Files
	// or Info, so switching back doesn't restart the mirror (spec 8.3).
	const [keepScreen, setKeepScreen] = useState(true)
	const tone = stateTone(device)
	const hint = stateHint(device)
	const online = device.state === 'device' && !device.gone

	useEffect(() => {
		if (view === 'screen' || !keepScreen) return
		const timer = window.setTimeout(
			() => setKeepScreen(false),
			KEEP_SCREEN_MS,
		)
		return (): void => window.clearTimeout(timer)
	}, [view, keepScreen])

	const show = (v: View): void => {
		setView(v)
		if (v === 'screen') setKeepScreen(true)
	}

	return (
		<section className='pane pane-wide'>
			<header className='pane-header'>
				<h1>{device.name}</h1>
				<span className='tab-serial'>{device.serial}</span>
				<span className={`badge ${tone}`}>
					{device.gone ? 'disconnected' : device.state}
				</span>
				{isEmulator(device.serial) && online && (
					<StopEmulator serial={device.serial} />
				)}
				<div className='views' role='tablist'>
					{(['screen', 'files', 'info'] as const).map((v) => (
						<button
							key={v}
							role='tab'
							aria-selected={view === v}
							onClick={() => show(v)}
						>
							{v === 'screen'
								? 'Screen'
								: v === 'files'
									? 'Files'
									: 'Info'}
						</button>
					))}
				</div>
			</header>
			{hint && <p className={`hint ${tone}`}>{hint}</p>}
			{online && (view === 'screen' || keepScreen) && (
				<ScreenLayout
					serial={device.serial}
					hidden={view !== 'screen'}
				/>
			)}
			{view === 'screen' && !online && (
				<p className='muted'>
					The mirror starts when the device is connected.
				</p>
			)}
			{view === 'files' &&
				(online ? (
					<FileExplorer serial={device.serial} />
				) : (
					<p className='muted'>
						Files are available while the device is connected.
					</p>
				))}
			{view === 'info' && <Overview device={device} />}
		</section>
	)
}

interface StopEmulatorProps {
	serial: string
}

/** A headless emulator has no window to close; this shuts it down. */
const StopEmulator = ({ serial }: StopEmulatorProps): JSX.Element => {
	const [state, setState] = useState<'idle' | 'stopping' | string>('idle')
	const stop = (): void => {
		setState('stopping')
		stopEmulator(serial).catch((e: unknown) => {
			void warn(`stopping emulator ${serial} failed: ${String(e)}`)
			setState(String(e))
		})
	}
	return (
		<span className='stop-emulator'>
			<button onClick={stop} disabled={state === 'stopping'}>
				{state === 'stopping' ? 'Stopping…' : '■ Stop emulator'}
			</button>
			{state !== 'idle' && state !== 'stopping' && (
				<span className='err'>{state}</span>
			)}
		</span>
	)
}

interface ScreenLayoutProps {
	serial: string
	hidden: boolean
}

/** Main screen and customer panel on top, logcat below a draggable splitter. */
const ScreenLayout = ({ serial, hidden }: ScreenLayoutProps): JSX.Element => {
	const customers = useCustomerDisplays(serial)
	const [logHeight, setLogHeight] = useState(() =>
		readNumber(LOG_HEIGHT_KEY, 260),
	)
	const [showCustomer, setShowCustomer] = useState(() => {
		try {
			return window.localStorage.getItem(CUSTOMER_KEY) !== 'hidden'
		} catch {
			return true
		}
	})
	const layoutRef = useRef<HTMLDivElement>(null)

	const startDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
		const layout = layoutRef.current
		if (!layout) return
		e.currentTarget.setPointerCapture(e.pointerId)
		const bottom = layout.getBoundingClientRect().bottom
		const max = layout.clientHeight - 160
		let height = logHeight
		const onMove = (ev: PointerEvent): void => {
			height = Math.round(
				Math.min(max, Math.max(MIN_LOG, bottom - ev.clientY)),
			)
			setLogHeight(height)
		}
		const onUp = (): void => {
			window.removeEventListener('pointermove', onMove)
			window.removeEventListener('pointerup', onUp)
			window.removeEventListener('pointercancel', onUp)
			save(LOG_HEIGHT_KEY, String(height))
		}
		window.addEventListener('pointermove', onMove)
		window.addEventListener('pointerup', onUp)
		window.addEventListener('pointercancel', onUp)
	}

	const toggleCustomer = (): void => {
		setShowCustomer((shown) => {
			save(CUSTOMER_KEY, shown ? 'hidden' : 'shown')
			return !shown
		})
	}

	return (
		<div
			className='device-layout'
			hidden={hidden}
			ref={layoutRef}
			style={{
				gridTemplateRows: `minmax(160px, 1fr) 6px ${logHeight}px`,
			}}
		>
			<div className='screens'>
				<ScreenView
					serial={serial}
					displayId={0}
					role='main'
					maxSize={isEmulator(serial) ? EMULATOR_MAX_SIZE : undefined}
				/>
				{customers.length > 0 && (
					<>
						<button
							className='customer-toggle'
							onClick={toggleCustomer}
							title={
								showCustomer
									? 'Hide the customer screen'
									: 'Show the customer screen'
							}
						>
							{showCustomer ? '›' : '‹'}
						</button>
						{showCustomer && (
							<CustomerScreens
								serial={serial}
								displays={customers}
							/>
						)}
					</>
				)}
			</div>
			<div
				className='splitter'
				role='separator'
				aria-orientation='horizontal'
				onPointerDown={startDrag}
			/>
			<div className='log-region'>
				<LogcatPanel serial={serial} />
			</div>
		</div>
	)
}

interface OverviewProps {
	device: DeviceView
}

const Overview = ({ device }: OverviewProps): JSX.Element => (
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
)
