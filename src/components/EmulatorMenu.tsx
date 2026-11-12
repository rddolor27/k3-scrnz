import { type JSX, useEffect, useRef, useState } from 'react'

import { type Avd, listAvds, startEmulator, stopEmulator } from '../lib/ipc'
import { info, warn } from '../lib/log'

/** While the menu is open, so a booting emulator flips to "running". */
const REFRESH_MS = 3000

type Load =
	| { kind: 'loading' }
	| { kind: 'ready'; avds: Avd[] }
	| { kind: 'failed'; message: string }

interface EmulatorMenuProps {
	/** Selects a device tab (it may appear only once the emulator boots). */
	onOpen: (serial: string) => void
}

/**
 * Lists the SDK's AVDs and boots one headless (user request 2026-11-12, not
 * in SPEC v1). A booted emulator gets a normal, mirrored device tab.
 */
export const EmulatorMenu = ({ onOpen }: EmulatorMenuProps): JSX.Element => {
	const [open, setOpen] = useState(false)
	const [load, setLoad] = useState<Load>({ kind: 'loading' })
	const [starting, setStarting] = useState<string | null>(null)
	const [message, setMessage] = useState<string | null>(null)
	const rootRef = useRef<HTMLDivElement>(null)

	useEffect(() => {
		if (!open) return
		let live = true
		const refresh = (): void => {
			listAvds()
				.then((avds) => {
					if (live) setLoad({ kind: 'ready', avds })
				})
				.catch((e: unknown) => {
					if (live) setLoad({ kind: 'failed', message: String(e) })
				})
		}
		refresh()
		const timer = window.setInterval(refresh, REFRESH_MS)
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
			live = false
			window.clearInterval(timer)
			window.removeEventListener('pointerdown', onPointerDown)
			window.removeEventListener('keydown', onKeyDown)
		}
	}, [open])

	const start = (name: string): void => {
		setStarting(name)
		setMessage(null)
		startEmulator(name)
			.then((serial) => {
				void info(`emulator ${name} started as ${serial}`)
				setMessage(
					`${name} is booting (about 30 s). Its tab opens once adb sees it.`,
				)
				onOpen(serial)
			})
			.catch((e: unknown) => {
				void warn(`starting emulator ${name} failed: ${String(e)}`)
				setMessage(String(e))
			})
			.finally(() => setStarting(null))
	}

	const stop = (name: string, serial: string): void => {
		setMessage(`Stopping ${name}…`)
		stopEmulator(serial)
			.then(() => void info(`emulator ${serial} stopping`))
			.catch((e: unknown) => {
				void warn(`stopping emulator ${serial} failed: ${String(e)}`)
				setMessage(String(e))
			})
	}

	return (
		<div className='emulator-menu' ref={rootRef}>
			<button
				onClick={() => setOpen((shown) => !shown)}
				aria-expanded={open}
				title='Boot an Android emulator inside k3.scrnz'
			>
				＋ Emulator
			</button>
			{open && (
				<div className='emulator-popover' role='dialog'>
					{load.kind === 'loading' && (
						<span className='muted'>Looking for AVDs…</span>
					)}
					{load.kind === 'failed' && (
						<span className='err'>{load.message}</span>
					)}
					{load.kind === 'ready' && load.avds.length === 0 && (
						<span className='muted'>
							No AVDs yet. Create one in Android Studio's Device
							Manager.
						</span>
					)}
					{load.kind === 'ready' &&
						load.avds.map((avd) => (
							<div className='emulator-row' key={avd.name}>
								<span className='name' title={avd.name}>
									{avd.name.replace(/_/g, ' ')}
								</span>
								{avd.serial ? (
									<>
										<button
											className='link ok'
											onClick={() => {
												if (avd.serial)
													onOpen(avd.serial)
											}}
											title='Open its tab'
										>
											running · {avd.serial}
										</button>
										<button
											onClick={() => {
												if (avd.serial)
													stop(avd.name, avd.serial)
											}}
										>
											Stop
										</button>
									</>
								) : (
									<button
										disabled={starting !== null}
										onClick={() => start(avd.name)}
									>
										{starting === avd.name
											? 'Starting…'
											: 'Start'}
									</button>
								)}
							</div>
						))}
					{message && <span className='muted'>{message}</span>}
					<span className='muted'>
						Boots without a window (host GPU, quick boot) and shows
						up as a tab like a device. Closing k3.scrnz stops the
						emulators it started.
					</span>
				</div>
			)}
		</div>
	)
}
