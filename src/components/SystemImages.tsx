import { type JSX, useState } from 'react'

import { imageLabel } from '../lib/avd'
import type { License, RemoteImage } from '../lib/ipc'
import {
	DEFAULT_FILTER,
	filterImages,
	groupByAndroid,
	groupTitle,
	type ImageFilter,
	imageShortLabel,
	KIND_OPTIONS,
} from '../lib/system-images'
import { useRemoteCatalog, useUninstallImage } from '../state/remote-images'
import type { SystemImageInstall } from '../state/system-image-install'
import { Icon } from './Icon'
import { LicenseDialog } from './LicenseDialog'
import { SystemImageRow } from './SystemImageRow'

interface PendingLicense {
	image: RemoteImage
	license: License
}

interface SystemImagesProps {
	install: SystemImageInstall
	changes: number
	onChanged: () => void
}

export const SystemImages = ({
	install,
	changes,
	onChanged,
}: SystemImagesProps): JSX.Element => {
	const { catalog, loading, error, refresh } = useRemoteCatalog(changes)
	const removal = useUninstallImage(onChanged)
	const [filter, setFilter] = useState<ImageFilter>(DEFAULT_FILTER)
	const [pending, setPending] = useState<PendingLicense | null>(null)

	if (pending) {
		return (
			<LicenseDialog
				title={imageLabel(pending.image)}
				license={pending.license}
				onCancel={() => setPending(null)}
				onAccept={() => {
					install.start(pending.image.id, true)
					setPending(null)
				}}
			/>
		)
	}

	const images = catalog?.images ?? []
	const groups = groupByAndroid(filterImages(images, filter))
	const { active, outcome } = install
	const installed =
		outcome?.kind === 'done'
			? images.find((image) => image.id === outcome.id)
			: undefined

	const requestInstall = (image: RemoteImage): void => {
		const license = catalog?.licenses.find((l) => l.id === image.licenseId)
		if (license && !license.accepted) setPending({ image, license })
		else install.start(image.id, false)
	}

	const failureFor = (id: string): string | null => {
		if (outcome?.kind === 'failed' && outcome.id === id)
			return outcome.error
		return removal.failure?.id === id ? removal.failure.text : null
	}

	return (
		<>
			<div className='images-toolbar'>
				<select
					className='avd-input images-kind'
					aria-label='System image type'
					value={filter.kind}
					onChange={(e) => {
						const picked = KIND_OPTIONS.find(
							(option) => option.value === e.target.value,
						)
						if (picked) setFilter({ ...filter, kind: picked.value })
					}}
				>
					{KIND_OPTIONS.map((option) => (
						<option key={option.value} value={option.value}>
							{option.label}
						</option>
					))}
				</select>
				<label className='avd-check'>
					<input
						type='checkbox'
						checked={filter.tablets}
						onChange={(e) =>
							setFilter({ ...filter, tablets: e.target.checked })
						}
					/>
					Tablet images
				</label>
				<label className='avd-check'>
					<input
						type='checkbox'
						checked={filter.installedOnly}
						onChange={(e) =>
							setFilter({
								...filter,
								installedOnly: e.target.checked,
							})
						}
					/>
					Installed only
				</label>
				<button
					type='button'
					className='images-refresh'
					disabled={loading}
					onClick={refresh}
					title="Check Google's servers for new and updated images"
				>
					<Icon name='refresh' />
					{loading ? 'Loading…' : 'Refresh'}
				</button>
			</div>
			{outcome?.kind === 'done' && (
				<p className='emulator-note' role='status'>
					Installed{' '}
					{installed ? imageShortLabel(installed) : outcome.id}. You
					can use it when creating an emulator.
				</p>
			)}
			{error && <p className='emulator-note err'>{error}</p>}
			{catalog !== null && catalog.errors.length > 0 && (
				<div className='image-warnings' role='status'>
					<strong>Some images could not be listed:</strong>
					<ul>
						{catalog.errors.map((text, index) => (
							<li key={`${index}-${text}`}>{text}</li>
						))}
					</ul>
				</div>
			)}
			{catalog === null && loading && (
				<p className='muted'>
					Loading the system images… this can take a few seconds.
				</p>
			)}
			{catalog !== null && images.length === 0 && (
				<p className='muted'>
					No downloadable system images were found.
				</p>
			)}
			{images.length > 0 && groups.length === 0 && (
				<p className='muted'>No system images match the filters.</p>
			)}
			{groups.map((group) => (
				<section key={group.apiLevel} className='image-group'>
					<h3 className='image-group-title'>
						{groupTitle(group.apiLevel)}
					</h3>
					<ul className='avd-list'>
						{group.images.map((image) => (
							<SystemImageRow
								key={image.id}
								image={image}
								progress={
									active?.id === image.id ? active : null
								}
								installRunning={active !== null}
								uninstallBusyId={removal.busyId}
								failure={failureFor(image.id)}
								onInstall={requestInstall}
								onCancel={install.cancel}
								onUninstall={removal.uninstall}
							/>
						))}
					</ul>
				</section>
			))}
			<p className='emulator-foot muted'>
				Images are installed into your Android SDK, so Android
				Studio&apos;s SDK Manager sees them too. A download keeps
				running if you close this window.
			</p>
		</>
	)
}
