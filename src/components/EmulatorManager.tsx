import './EmulatorManager.css'

import { type JSX, useCallback, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { avdTitle } from '../lib/avd'
import type { Avd } from '../lib/ipc'
import { useAvdActions, useAvds } from '../state/avds'
import { useModal } from '../state/modal'
import { AvdList } from './AvdList'
import { CreateAvdForm } from './CreateAvdForm'
import { Icon } from './Icon'

interface EmulatorManagerProps {
	onOpen: (serial: string) => void
}

export const EmulatorManager = ({
	onOpen,
}: EmulatorManagerProps): JSX.Element => {
	const [open, setOpen] = useState(false)
	const close = useCallback((): void => setOpen(false), [])

	return (
		<div className='emulator-menu'>
			<button
				onClick={() => setOpen(true)}
				aria-haspopup='dialog'
				aria-expanded={open}
				title='Create and manage Android emulators'
			>
				<Icon name='phone' />
				Emulators
			</button>
			{open &&
				createPortal(
					<EmulatorDialog onOpen={onOpen} onClose={close} />,
					document.body,
				)}
		</div>
	)
}

type View = 'list' | 'create'

interface EmulatorDialogProps {
	onOpen: (serial: string) => void
	onClose: () => void
}

const EmulatorDialog = ({
	onOpen,
	onClose,
}: EmulatorDialogProps): JSX.Element => {
	const [view, setView] = useState<View>('list')
	const { avds, error, refresh } = useAvds()
	const actions = useAvdActions({ avds, refresh, onOpen })
	const dialogRef = useRef<HTMLDivElement>(null)
	const titleId = useId()
	useModal(dialogRef, onClose)

	const created = (avd: Avd, startAfter: boolean): void => {
		setView('list')
		actions.showNote(`Created ${avdTitle(avd)}.`)
		void refresh()
		if (startAfter) void actions.start(avd)
	}

	return (
		<div
			className='emulator-backdrop'
			onPointerDown={(e) => {
				if (e.target === e.currentTarget) onClose()
			}}
		>
			<div
				className='emulator-dialog'
				role='dialog'
				aria-modal='true'
				aria-labelledby={titleId}
				tabIndex={-1}
				ref={dialogRef}
			>
				<header className='emulator-head'>
					{view === 'create' && (
						<button
							type='button'
							className='icon-button'
							aria-label='Back to the emulator list'
							title='Back to the emulator list'
							onClick={() => setView('list')}
						>
							<Icon name='chevronLeft' />
						</button>
					)}
					<h2 id={titleId}>
						{view === 'list' ? 'Emulators' : 'Create emulator'}
					</h2>
					{view === 'list' && (
						<button
							type='button'
							className='primary'
							onClick={() => setView('create')}
						>
							<Icon name='plus' />
							Create emulator
						</button>
					)}
					<button
						type='button'
						className='icon-button emulator-close'
						aria-label='Close'
						title='Close (Esc)'
						onClick={onClose}
					>
						<Icon name='close' />
					</button>
				</header>
				<div className='emulator-body'>
					{view === 'create' ? (
						<CreateAvdForm
							existingNames={(avds ?? []).map((avd) => avd.name)}
							onCancel={() => setView('list')}
							onCreated={created}
						/>
					) : (
						<>
							{actions.note && (
								<p
									className={
										actions.note.error
											? 'emulator-note err'
											: 'emulator-note'
									}
									role='status'
								>
									{actions.note.text}
								</p>
							)}
							{error && (
								<p className='emulator-note err'>{error}</p>
							)}
							{avds === null && !error && (
								<p className='muted'>Looking for emulators…</p>
							)}
							{avds?.length === 0 && (
								<div className='avd-empty'>
									<strong>No emulators yet</strong>
									<p className='muted'>
										Create one with the profile and system
										image you need.
									</p>
								</div>
							)}
							{avds && avds.length > 0 && (
								<AvdList
									avds={avds}
									busy={actions.busy}
									onStart={(avd, options) =>
										void actions.start(avd, options)
									}
									onStop={(avd) => void actions.stop(avd)}
									onDelete={(avd) => void actions.remove(avd)}
									onOpen={(serial) => {
										onOpen(serial)
										onClose()
									}}
								/>
							)}
							<p className='emulator-foot muted'>
								Emulators boot without a window (host GPU) and
								show up as a tab like a device. Closing
								tri.scrnz stops the emulators it started.
							</p>
						</>
					)}
				</div>
			</div>
		</div>
	)
}
