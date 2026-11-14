import './EmulatorManager.css'

import { type JSX, useCallback, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { avdTitle } from '../lib/avd'
import type { Avd } from '../lib/ipc'
import { useAvdActions, useAvds } from '../state/avds'
import { useModal } from '../state/modal'
import { useSystemImageInstall } from '../state/system-image-install'
import { useSystemImages } from '../state/system-images'
import { AvdList } from './AvdList'
import { CreateAvdForm } from './CreateAvdForm'
import { Icon } from './Icon'
import { SystemImages } from './SystemImages'

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

type View = 'list' | 'create' | 'images'
type ImagesOrigin = 'list' | 'create'

const TITLES: Record<View, string> = {
	list: 'Emulators',
	create: 'Create emulator',
	images: 'System images',
}

interface EmulatorDialogProps {
	onOpen: (serial: string) => void
	onClose: () => void
}

const EmulatorDialog = ({
	onOpen,
	onClose,
}: EmulatorDialogProps): JSX.Element => {
	const [view, setView] = useState<View>('list')
	const [origin, setOrigin] = useState<ImagesOrigin>('list')
	const [imageChanges, setImageChanges] = useState(0)
	const { avds, error, refresh } = useAvds()
	const actions = useAvdActions({ avds, refresh, onOpen })
	const { load: imagesLoad, reload: reloadImages } = useSystemImages()
	const onImagesChanged = useCallback((): void => {
		reloadImages()
		setImageChanges((n) => n + 1)
	}, [reloadImages])
	const install = useSystemImageInstall(onImagesChanged)
	const dialogRef = useRef<HTMLDivElement>(null)
	const titleId = useId()
	useModal(dialogRef, onClose)

	const created = (avd: Avd, startAfter: boolean): void => {
		setView('list')
		actions.showNote(`Created ${avdTitle(avd)}.`)
		void refresh()
		if (startAfter) void actions.start(avd)
	}

	const showImages = (): void => {
		setOrigin(view === 'create' ? 'create' : 'list')
		setView('images')
	}

	const goBack = (): void => setView(view === 'images' ? origin : 'list')

	const backLabel =
		view === 'images' && origin === 'create'
			? 'Back to the new emulator'
			: 'Back to the emulator list'
	const keepForm =
		view === 'create' || (view === 'images' && origin === 'create')

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
					{view !== 'list' && (
						<button
							type='button'
							className='icon-button'
							aria-label={backLabel}
							title={backLabel}
							onClick={goBack}
						>
							<Icon name='chevronLeft' />
						</button>
					)}
					<h2 id={titleId}>{TITLES[view]}</h2>
					{view === 'list' && (
						<>
							<button
								type='button'
								onClick={showImages}
								title='Download, update and remove Android system images'
							>
								<Icon name='download' />
								System images
							</button>
							<button
								type='button'
								className='primary'
								onClick={() => setView('create')}
							>
								<Icon name='plus' />
								Create emulator
							</button>
						</>
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
					{keepForm && (
						<div hidden={view !== 'create'}>
							<CreateAvdForm
								existingNames={(avds ?? []).map(
									(avd) => avd.name,
								)}
								imagesLoad={imagesLoad}
								onReloadImages={reloadImages}
								onDownloadImages={showImages}
								onCancel={() => setView('list')}
								onCreated={created}
							/>
						</div>
					)}
					{view === 'images' && (
						<SystemImages
							install={install}
							changes={imageChanges}
							onChanged={onImagesChanged}
						/>
					)}
					{view === 'list' && (
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
