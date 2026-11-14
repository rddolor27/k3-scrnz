import { type JSX, useEffect, useRef, useState } from 'react'

import {
	androidLabel,
	type AvdBusy,
	avdDisplayText,
	avdTitle,
	screenLabel,
} from '../lib/avd'
import type { Avd, StartOptions } from '../lib/ipc'
import { Icon } from './Icon'

const CONFIRM_MS = 4000
const COLD_BOOT: StartOptions = { coldBoot: true, wipeData: false }
const WIPE_AND_START: StartOptions = { coldBoot: true, wipeData: true }

type Confirm = 'wipe' | 'delete'

interface AvdListProps {
	avds: readonly Avd[]
	busy: ReadonlyMap<string, AvdBusy>
	onStart: (avd: Avd, options?: StartOptions) => void
	onStop: (avd: Avd) => void
	onDelete: (avd: Avd) => void
	onOpen: (serial: string) => void
}

export const AvdList = ({
	avds,
	busy,
	onStart,
	onStop,
	onDelete,
	onOpen,
}: AvdListProps): JSX.Element => (
	<ul className='avd-list'>
		{avds.map((avd) => (
			<AvdRow
				key={avd.name}
				avd={avd}
				busy={busy.get(avd.name) ?? null}
				onStart={onStart}
				onStop={onStop}
				onDelete={onDelete}
				onOpen={onOpen}
			/>
		))}
	</ul>
)

interface AvdRowProps {
	avd: Avd
	busy: AvdBusy | null
	onStart: (avd: Avd, options?: StartOptions) => void
	onStop: (avd: Avd) => void
	onDelete: (avd: Avd) => void
	onOpen: (serial: string) => void
}

const AvdRow = ({
	avd,
	busy,
	onStart,
	onStop,
	onDelete,
	onOpen,
}: AvdRowProps): JSX.Element => {
	const [menuOpen, setMenuOpen] = useState(false)
	const [confirming, setConfirming] = useState<Confirm | null>(null)
	const menuRef = useRef<HTMLDivElement>(null)
	const { serial } = avd
	const title = avdTitle(avd)
	const status = avdDisplayText(avd, busy)
	const stopped = avd.state === 'stopped'
	const working = busy !== null
	const pending = stopped && !working ? confirming : null

	useEffect(() => {
		if (!confirming) return
		const timer = window.setTimeout(() => setConfirming(null), CONFIRM_MS)
		return (): void => window.clearTimeout(timer)
	}, [confirming])

	useEffect(() => {
		if (!menuOpen) return
		const onPointerDown = (e: PointerEvent): void => {
			const root = menuRef.current
			if (root && e.target instanceof Node && !root.contains(e.target)) {
				setMenuOpen(false)
				setConfirming((current) =>
					current === 'wipe' ? null : current,
				)
			}
		}
		window.addEventListener('pointerdown', onPointerDown)
		return (): void =>
			window.removeEventListener('pointerdown', onPointerDown)
	}, [menuOpen])

	const closeMenu = (): void => {
		setMenuOpen(false)
		setConfirming((current) => (current === 'wipe' ? null : current))
	}

	const startWith = (options: StartOptions): void => {
		closeMenu()
		onStart(avd, options)
	}

	const wipeAndStart = (): void => {
		if (pending === 'wipe') startWith(WIPE_AND_START)
		else setConfirming('wipe')
	}

	const remove = (): void => {
		if (pending === 'delete') {
			setConfirming(null)
			onDelete(avd)
		} else {
			setConfirming('delete')
		}
	}

	const versionParts = [
		avd.apiLevel === null ? null : androidLabel(avd.apiLevel),
		avd.tagDisplay,
	].filter((part): part is string => part !== null && part !== '')
	const showPlayChip = avd.playStore && !/play/i.test(avd.tagDisplay ?? '')
	const screenParts: string[] = []
	if (avd.width !== null && avd.height !== null) {
		screenParts.push(screenLabel({ width: avd.width, height: avd.height }))
	}
	if (avd.density !== null) screenParts.push(`${avd.density} dpi`)

	return (
		<li className='avd-row'>
			<div className='avd-info'>
				<div className='avd-head'>
					<strong
						className='avd-name'
						title={avd.path ? `${avd.name}\n${avd.path}` : avd.name}
					>
						{title}
					</strong>
					<span className='avd-state'>
						<span className={`dot ${status.tone}`} />
						{status.text}
					</span>
				</div>
				{(versionParts.length > 0 || showPlayChip) && (
					<p className='avd-meta'>
						{versionParts.join(' · ')}
						{showPlayChip && (
							<span className='avd-chip'>Play Store</span>
						)}
					</p>
				)}
				{(screenParts.length > 0 || avd.customerDisplay) && (
					<p className='avd-meta'>
						{screenParts.join(' · ')}
						{avd.customerDisplay && (
							<span className='avd-chip'>
								+ customer screen{' '}
								{screenLabel(avd.customerDisplay)}
							</span>
						)}
					</p>
				)}
			</div>
			<div className='avd-actions'>
				{stopped ? (
					<div
						className='avd-split'
						ref={menuRef}
						onKeyDown={(e) => {
							if (e.key === 'Escape' && menuOpen) {
								e.preventDefault()
								closeMenu()
							}
						}}
					>
						<button
							type='button'
							className='avd-start'
							disabled={working}
							onClick={() => onStart(avd)}
							title='Start with the saved snapshot (quick boot)'
						>
							<Icon name='play' />
							{busy === 'starting' ? 'Starting…' : 'Start'}
						</button>
						<button
							type='button'
							className='avd-more'
							disabled={working}
							aria-label='More ways to start'
							aria-haspopup='menu'
							aria-expanded={menuOpen}
							onClick={() =>
								menuOpen ? closeMenu() : setMenuOpen(true)
							}
						>
							<Icon name='chevronDown' />
						</button>
						{menuOpen && (
							<div className='avd-menu' role='menu'>
								<button
									type='button'
									role='menuitem'
									onClick={() => startWith(COLD_BOOT)}
									title='Boot from scratch, ignoring the saved snapshot'
								>
									Cold boot
								</button>
								<button
									type='button'
									role='menuitem'
									className={
										pending === 'wipe'
											? 'danger'
											: undefined
									}
									onClick={wipeAndStart}
								>
									{pending === 'wipe'
										? 'Click again to erase and start'
										: 'Wipe data and start'}
								</button>
							</div>
						)}
					</div>
				) : (
					<>
						{serial !== null && (
							<button
								type='button'
								onClick={() => onOpen(serial)}
							>
								Open
							</button>
						)}
						<button
							type='button'
							disabled={working || serial === null}
							onClick={() => onStop(avd)}
						>
							<Icon name='stop' />
							{busy === 'stopping' ? 'Stopping…' : 'Stop'}
						</button>
					</>
				)}
				<button
					type='button'
					className={pending === 'delete' ? 'danger' : undefined}
					disabled={!stopped || working}
					onClick={remove}
					title={
						stopped
							? 'Delete this emulator and its data'
							: 'Stop the emulator before deleting it'
					}
				>
					<Icon name='trash' />
					{busy === 'deleting'
						? 'Deleting…'
						: pending === 'delete'
							? 'Confirm delete'
							: 'Delete'}
				</button>
			</div>
			{pending && (
				<p className='avd-confirm' role='status'>
					{pending === 'delete'
						? `Click Confirm delete to remove ${title} and everything on it.`
						: `Click the menu item again to erase the apps and data of ${title}.`}
				</p>
			)}
		</li>
	)
}
