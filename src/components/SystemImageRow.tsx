import { type JSX, useEffect, useState } from 'react'

import { imageLabel } from '../lib/avd'
import type { InstallProgress, RemoteImage } from '../lib/ipc'
import {
	emulatorWarning,
	imageMeta,
	imageStatus,
	installPercent,
	installText,
} from '../lib/system-images'
import { Icon } from './Icon'

const CONFIRM_MS = 4000
const ONE_AT_A_TIME =
	'One download runs at a time. Wait for the current one to finish.'

interface SystemImageRowProps {
	image: RemoteImage
	progress: InstallProgress | null
	installRunning: boolean
	uninstallBusyId: string | null
	failure: string | null
	onInstall: (image: RemoteImage) => void
	onCancel: () => void
	onUninstall: (image: RemoteImage) => void
}

export const SystemImageRow = ({
	image,
	progress,
	installRunning,
	uninstallBusyId,
	failure,
	onInstall,
	onCancel,
	onUninstall,
}: SystemImageRowProps): JSX.Element => {
	const [confirming, setConfirming] = useState(false)
	const title = imageLabel(image)
	const status = imageStatus(image)
	const meta = imageMeta(image)
	const uninstalling = uninstallBusyId === image.id
	const installLabel = image.updateAvailable ? 'Update' : 'Download'
	const canInstall = !image.installed || image.updateAvailable

	useEffect(() => {
		if (!confirming) return
		const timer = window.setTimeout(() => setConfirming(false), CONFIRM_MS)
		return (): void => window.clearTimeout(timer)
	}, [confirming])

	const remove = (): void => {
		if (confirming) {
			setConfirming(false)
			onUninstall(image)
		} else {
			setConfirming(true)
		}
	}

	return (
		<li className='avd-row'>
			<div className='avd-info'>
				<div className='avd-head'>
					<strong
						className='avd-name'
						title={`${title}\n${image.id}`}
					>
						{title}
					</strong>
					<span className='avd-state'>
						<span className={`dot ${status.tone}`} />
						{status.text}
					</span>
				</div>
				{meta !== '' && <p className='avd-meta'>{meta}</p>}
				{image.emulatorTooOld && (
					<p className='image-warn'>{emulatorWarning(image)}</p>
				)}
			</div>
			{progress === null && (
				<div className='avd-actions'>
					{canInstall && (
						<button
							type='button'
							disabled={installRunning || uninstalling}
							title={
								installRunning
									? ONE_AT_A_TIME
									: `${installLabel} ${title}`
							}
							onClick={() => onInstall(image)}
						>
							<Icon name='download' />
							{installLabel}
						</button>
					)}
					{image.installed && (
						<button
							type='button'
							className={confirming ? 'danger' : undefined}
							disabled={uninstallBusyId !== null}
							title={`Remove ${title} from the Android SDK`}
							onClick={remove}
						>
							<Icon name='trash' />
							{uninstalling
								? 'Uninstalling…'
								: confirming
									? 'Confirm uninstall'
									: 'Uninstall'}
						</button>
					)}
				</div>
			)}
			{progress !== null && (
				<InstallProgressView
					label={title}
					progress={progress}
					onCancel={onCancel}
				/>
			)}
			{confirming && !uninstalling && (
				<p className='avd-confirm' role='status'>
					Click Confirm uninstall to remove {title}.
				</p>
			)}
			{failure !== null && (
				<p className='avd-error image-failure' role='alert'>
					{failure}
				</p>
			)}
		</li>
	)
}

interface InstallProgressViewProps {
	label: string
	progress: InstallProgress
	onCancel: () => void
}

const InstallProgressView = ({
	label,
	progress,
	onCancel,
}: InstallProgressViewProps): JSX.Element => {
	const percent = installPercent(progress)
	const text = installText(progress)

	return (
		<div className='image-progress'>
			<div
				className={
					percent === null ? 'image-bar indeterminate' : 'image-bar'
				}
				role='progressbar'
				aria-label={`Installing ${label}`}
				aria-valuemin={0}
				aria-valuemax={100}
				aria-valuenow={percent ?? undefined}
				aria-valuetext={text}
			>
				<div
					className='image-bar-fill'
					style={
						percent === null ? undefined : { width: `${percent}%` }
					}
				/>
			</div>
			<div className='image-progress-line'>
				<span className='image-progress-text'>{text}</span>
				<button type='button' onClick={onCancel}>
					Cancel
				</button>
			</div>
		</div>
	)
}
