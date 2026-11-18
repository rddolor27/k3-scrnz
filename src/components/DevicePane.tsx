import { type JSX, lazy, Suspense, useRef, useState } from 'react'

import {
	isStartingEmulator,
	stateHint,
	stateLabel,
	stateTone,
} from '../lib/device-state'
import { type DeviceView, isEmulator, stopEmulator } from '../lib/ipc'
import { warn } from '../lib/log'
import { useDeviceRecording } from '../state/device-recording'
import { useNote } from '../state/note'
import { AppMenu } from './AppMenu'
import { RecordingTimer } from './CaptureButtons'
import { CustomerScreens, useCustomerDisplays } from './CustomerScreens'
import { FileExplorer } from './FileExplorer'
import { Icon } from './Icon'
import { LogcatPanel } from './LogcatPanel'
import { ScreenView } from './ScreenView'

const TerminalPanel = lazy(() =>
	import('./TerminalPanel').then((m) => ({ default: m.TerminalPanel })),
)

type View = 'screen' | 'files' | 'info'
type BottomPanel = 'logcat' | 'terminal'

const LOG_HEIGHT_KEY = 'tri.logHeight'
const LOG_HIDDEN_KEY = 'tri.logCollapsed'
const CUSTOMER_KEY = 'tri.customerPanel'
const MIN_LOG = 120
// The emulator encodes in software; a smaller stream keeps lag low.
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
		// Storage can be unavailable.
	}
}

interface DevicePaneProps {
	device: DeviceView
}

export const DevicePane = ({ device }: DevicePaneProps): JSX.Element => {
	const [view, setView] = useState<View>('screen')
	const [bottomHidden, setBottomHidden] = useState(() => {
		try {
			return window.localStorage.getItem(LOG_HIDDEN_KEY) === 'true'
		} catch {
			return false
		}
	})
	const toggleBottom = (): void => {
		const next = !bottomHidden
		setBottomHidden(next)
		save(LOG_HIDDEN_KEY, String(next))
	}
	const tone = stateTone(device)
	const hint = stateHint(device)
	const online = device.state === 'device' && !device.gone
	const booting = isStartingEmulator(device)

	return (
		<section className='pane pane-wide'>
			<header className='pane-header'>
				<h1>{device.name}</h1>
				<span className='tab-serial'>{device.serial}</span>
				<span className={`badge ${tone}`}>
					{stateLabel(device) ?? device.state}
				</span>
				{isEmulator(device.serial) && online && (
					<StopEmulator serial={device.serial} />
				)}
				{online && <AppMenu serial={device.serial} />}
				{online && view === 'screen' && (
					<button
						className='panel-toggle'
						aria-pressed={!bottomHidden}
						title={
							bottomHidden
								? 'Show logcat and terminal'
								: 'Hide logcat and terminal (logcat keeps running)'
						}
						aria-label={
							bottomHidden
								? 'Show logcat and terminal'
								: 'Hide logcat and terminal'
						}
						onClick={toggleBottom}
					>
						<Icon name='panelBottom' />
					</button>
				)}
				<div className='views' role='tablist'>
					{(['screen', 'files', 'info'] as const).map((v) => (
						<button
							key={v}
							role='tab'
							aria-selected={view === v}
							onClick={() => setView(v)}
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
			{online && (
				<ScreenLayout
					serial={device.serial}
					deviceName={device.name}
					hidden={view !== 'screen'}
					bottomHidden={bottomHidden}
					onHideBottom={toggleBottom}
				/>
			)}
			{view === 'screen' && !online && (
				<p className='muted'>
					{booting
						? 'The screen appears once the emulator has booted.'
						: 'The mirror starts when the device is connected.'}
				</p>
			)}
			{view === 'files' &&
				(online ? (
					<FileExplorer serial={device.serial} />
				) : (
					<p className='muted'>
						{booting
							? 'Files are available once the emulator has booted.'
							: 'Files are available while the device is connected.'}
					</p>
				))}
			{view === 'info' && <Overview device={device} />}
		</section>
	)
}

interface StopEmulatorProps {
	serial: string
}

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
				<Icon name='stop' />
				{state === 'stopping' ? 'Stopping…' : 'Stop emulator'}
			</button>
			{state !== 'idle' && state !== 'stopping' && (
				<span className='err'>{state}</span>
			)}
		</span>
	)
}

interface ScreenLayoutProps {
	serial: string
	deviceName: string
	hidden: boolean
	bottomHidden: boolean
	onHideBottom: () => void
}

const ScreenLayout = ({
	serial,
	deviceName,
	hidden,
	bottomHidden,
	onHideBottom,
}: ScreenLayoutProps): JSX.Element => {
	const customers = useCustomerDisplays(serial)
	const { note, showNote } = useNote()
	const recording = useDeviceRecording({ serial, showNote })
	const [bottom, setBottom] = useState<BottomPanel>('logcat')
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
				gridTemplateRows: bottomHidden
					? 'minmax(160px, 1fr)'
					: `minmax(160px, 1fr) 6px ${logHeight}px`,
			}}
		>
			<div className='screens'>
				<ScreenView
					serial={serial}
					displayId={0}
					role='main'
					maxSize={isEmulator(serial) ? EMULATOR_MAX_SIZE : undefined}
					keepAlive={recording.since !== null}
					extraNote={note}
					captureExtra={
						customers.length > 0 ? (
							recording.since === null ? (
								<button
									className='record-button'
									onClick={recording.toggle}
									disabled={
										!showCustomer ||
										!recording.ready ||
										recording.busy
									}
									title={
										showCustomer
											? 'Record the main and customer screens side by side as one MP4'
											: 'Show the customer screen to record both'
									}
								>
									<Icon name='record' />
									{customers.length > 1
										? 'Record all'
										: 'Record both'}
								</button>
							) : (
								<button
									className='recording'
									onClick={recording.toggle}
									disabled={recording.busy}
									title='Stop recording'
								>
									<Icon name='stop' />
									<RecordingTimer since={recording.since} />
								</button>
							)
						) : null
					}
				/>
				{customers.length > 0 && (
					<>
						<button
							className='customer-toggle'
							onClick={toggleCustomer}
							disabled={recording.since !== null}
							title={
								recording.since !== null
									? 'Stop the recording to hide the customer screen'
									: showCustomer
										? 'Hide the customer screen'
										: 'Show the customer screen'
							}
							aria-label={
								showCustomer
									? 'Hide the customer screen'
									: 'Show the customer screen'
							}
						>
							<Icon
								name={
									showCustomer
										? 'chevronRight'
										: 'chevronLeft'
								}
							/>
						</button>
						{showCustomer && (
							<CustomerScreens
								serial={serial}
								displays={customers}
								keepAlive={recording.since !== null}
							/>
						)}
					</>
				)}
			</div>
			{!bottomHidden && (
				<div
					className='splitter'
					role='separator'
					aria-orientation='horizontal'
					onPointerDown={startDrag}
				/>
			)}
			<div className='log-region' hidden={bottomHidden}>
				<div className='bottom-tabs' role='tablist'>
					{(['logcat', 'terminal'] as const).map((panel) => (
						<button
							key={panel}
							role='tab'
							aria-selected={bottom === panel}
							onClick={() => setBottom(panel)}
						>
							{panel === 'logcat' ? 'Logcat' : 'Terminal'}
						</button>
					))}
					<button
						className='bottom-toggle'
						title='Hide logcat and terminal (logcat keeps running)'
						aria-label='Hide logcat and terminal'
						onClick={onHideBottom}
					>
						<Icon name='chevronDown' />
					</button>
				</div>
				<div className='bottom-body' hidden={bottom !== 'logcat'}>
					<LogcatPanel serial={serial} />
				</div>
				{bottom === 'terminal' && (
					<div className='bottom-body'>
						<Suspense
							fallback={
								<p className='muted'>Loading the terminal…</p>
							}
						>
							<TerminalPanel
								serial={serial}
								deviceName={deviceName}
							/>
						</Suspense>
					</div>
				)}
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
