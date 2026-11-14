import {
	type FormEvent,
	type JSX,
	type ReactNode,
	useId,
	useState,
} from 'react'

import {
	CUSTOMER_PRESETS,
	DEFAULT_PROFILE,
	DEFAULT_RAM_GB,
	DEFAULT_SCREEN,
	DEFAULT_STORAGE_GB,
	DENSITY_MAX,
	DENSITY_MIN,
	deriveAvdName,
	HARDWARE_PROFILES,
	imageLabel,
	NAME_MAX,
	nameProblem,
	parseWhole,
	pickDefaultImage,
	presetKey,
	profileBaseName,
	RAM_OPTIONS_GB,
	SCREEN_MAX,
	SCREEN_MIN,
	screenLabel,
	STORAGE_OPTIONS_GB,
	suggestName,
} from '../lib/avd'
import { type Avd, createAvd } from '../lib/ipc'
import { warn } from '../lib/log'
import type { ImagesLoad } from '../state/system-images'
import { Icon } from './Icon'

interface CreateAvdFormProps {
	existingNames: readonly string[]
	imagesLoad: ImagesLoad
	onReloadImages: () => void
	onDownloadImages: () => void
	onCancel: () => void
	onCreated: (avd: Avd, startAfter: boolean) => void
}

export const CreateAvdForm = ({
	existingNames,
	imagesLoad: load,
	onReloadImages,
	onDownloadImages,
	onCancel,
	onCreated,
}: CreateAvdFormProps): JSX.Element => {
	const [profileId, setProfileId] = useState(DEFAULT_PROFILE.id)
	const [typedName, setTypedName] = useState<string | null>(null)
	const [imageId, setImageId] = useState<string | null>(null)
	const [width, setWidth] = useState(String(DEFAULT_SCREEN.width))
	const [height, setHeight] = useState(String(DEFAULT_SCREEN.height))
	const [density, setDensity] = useState(String(DEFAULT_SCREEN.density))
	const [ramGb, setRamGb] = useState(DEFAULT_RAM_GB)
	const [storageGb, setStorageGb] = useState(DEFAULT_STORAGE_GB)
	const [customerChoice, setCustomerChoice] = useState<boolean | null>(null)
	const [customerKey, setCustomerKey] = useState(
		presetKey(CUSTOMER_PRESETS[0]),
	)
	const [startAfter, setStartAfter] = useState(true)
	const [creating, setCreating] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const profile =
		HARDWARE_PROFILES.find((p) => p.id === profileId) ?? DEFAULT_PROFILE
	const name =
		typedName ?? suggestName(profileBaseName(profile), existingNames)
	const avdName = deriveAvdName(name)
	const problem = nameProblem(name, avdName, existingNames)

	const widthValue = parseWhole(width, SCREEN_MIN, SCREEN_MAX)
	const heightValue = parseWhole(height, SCREEN_MIN, SCREEN_MAX)
	const densityValue = parseWhole(density, DENSITY_MIN, DENSITY_MAX)
	const screenProblem =
		widthValue === null || heightValue === null
			? `Width and height must be whole numbers from ${SCREEN_MIN} to ${SCREEN_MAX}.`
			: densityValue === null
				? `Density must be a whole number from ${DENSITY_MIN} to ${DENSITY_MAX}.`
				: null

	const images = load.kind === 'ready' ? load.images : []
	const image =
		images.find((i) => i.id === imageId) ??
		pickDefaultImage(images, profile.tablet)

	const customerOn = customerChoice ?? profile.customerScreen
	const customerSize =
		CUSTOMER_PRESETS.find((p) => presetKey(p) === customerKey) ??
		CUSTOMER_PRESETS[0]

	const pickProfile = (id: string): void => {
		setProfileId(id)
		const next = HARDWARE_PROFILES.find((p) => p.id === id)
		if (!next?.screen) return
		setWidth(String(next.screen.width))
		setHeight(String(next.screen.height))
		setDensity(String(next.screen.density))
	}

	const submit = (e: FormEvent<HTMLFormElement>): void => {
		e.preventDefault()
		if (
			creating ||
			problem !== null ||
			widthValue === null ||
			heightValue === null ||
			densityValue === null ||
			image === null
		) {
			return
		}
		setCreating(true)
		setError(null)
		createAvd({
			name: avdName,
			displayName: name.trim(),
			image: image.id,
			width: widthValue,
			height: heightValue,
			density: densityValue,
			ramMb: ramGb * 1024,
			storageGb,
			deviceName: profile.deviceName,
			customerDisplay: customerOn ? customerSize : null,
		})
			.then((avd) => onCreated(avd, startAfter))
			.catch((err: unknown) => {
				void warn(`creating emulator ${avdName} failed: ${String(err)}`)
				setError(String(err))
				setCreating(false)
			})
	}

	if (load.kind === 'ready' && load.images.length === 0) {
		return (
			<NoSystemImages
				onRetry={onReloadImages}
				onDownload={onDownloadImages}
				onBack={onCancel}
			/>
		)
	}

	const canCreate =
		!creating &&
		problem === null &&
		screenProblem === null &&
		image !== null

	return (
		<form className='avd-form' onSubmit={submit}>
			<Field
				label='Name'
				wide
				note={
					problem ? (
						<span className='avd-note err' role='alert'>
							{problem}
						</span>
					) : (
						<span className='avd-note'>Saved as {avdName}</span>
					)
				}
				control={(id) => (
					<input
						id={id}
						className='avd-input'
						type='text'
						value={name}
						maxLength={NAME_MAX}
						autoFocus
						autoComplete='off'
						spellCheck={false}
						disabled={creating}
						aria-invalid={problem !== null}
						onChange={(e) => setTypedName(e.target.value)}
					/>
				)}
			/>
			<Field
				label='Hardware profile'
				control={(id) => (
					<select
						id={id}
						className='avd-input'
						value={profile.id}
						disabled={creating}
						onChange={(e) => pickProfile(e.target.value)}
					>
						{HARDWARE_PROFILES.map((p) => (
							<option key={p.id} value={p.id}>
								{p.label}
							</option>
						))}
					</select>
				)}
			/>
			<Field
				label='System image'
				note={
					<>
						{load.kind === 'failed' && (
							<span className='avd-note err'>
								{load.message}{' '}
								<button
									type='button'
									className='link'
									onClick={onReloadImages}
								>
									Try again
								</button>
							</span>
						)}
						<span className='avd-note'>
							<button
								type='button'
								className='link'
								onClick={onDownloadImages}
							>
								Download more…
							</button>
						</span>
					</>
				}
				control={(id) => (
					<select
						id={id}
						className='avd-input'
						value={image?.id ?? ''}
						disabled={creating || image === null}
						onChange={(e) => setImageId(e.target.value)}
					>
						{image === null && (
							<option value=''>
								{load.kind === 'loading'
									? 'Looking for system images…'
									: 'No system image available'}
							</option>
						)}
						{images.map((i) => (
							<option
								key={i.id}
								value={i.id}
								title={i.description ?? i.id}
							>
								{imageLabel(i)}
							</option>
						))}
					</select>
				)}
			/>
			<div className='avd-field wide' role='group' aria-label='Screen'>
				<span className='avd-field-label'>Screen</span>
				<div className='avd-inline'>
					<input
						className='avd-input avd-number'
						type='text'
						inputMode='numeric'
						aria-label='Width in pixels'
						aria-invalid={widthValue === null}
						value={width}
						disabled={creating}
						onChange={(e) => setWidth(e.target.value)}
					/>
					<span className='avd-unit'>×</span>
					<input
						className='avd-input avd-number'
						type='text'
						inputMode='numeric'
						aria-label='Height in pixels'
						aria-invalid={heightValue === null}
						value={height}
						disabled={creating}
						onChange={(e) => setHeight(e.target.value)}
					/>
					<span className='avd-unit'>px at</span>
					<input
						className='avd-input avd-number'
						type='text'
						inputMode='numeric'
						aria-label='Density in dpi'
						aria-invalid={densityValue === null}
						value={density}
						disabled={creating}
						onChange={(e) => setDensity(e.target.value)}
					/>
					<span className='avd-unit'>dpi</span>
				</div>
				{screenProblem && (
					<span className='avd-note err' role='alert'>
						{screenProblem}
					</span>
				)}
			</div>
			<Field
				label='Memory'
				control={(id) => (
					<select
						id={id}
						className='avd-input'
						value={ramGb}
						disabled={creating}
						onChange={(e) => setRamGb(Number(e.target.value))}
					>
						{RAM_OPTIONS_GB.map((gb) => (
							<option key={gb} value={gb}>
								{gb} GB
							</option>
						))}
					</select>
				)}
			/>
			<Field
				label='Storage'
				control={(id) => (
					<select
						id={id}
						className='avd-input'
						value={storageGb}
						disabled={creating}
						onChange={(e) => setStorageGb(Number(e.target.value))}
					>
						{STORAGE_OPTIONS_GB.map((gb) => (
							<option key={gb} value={gb}>
								{gb} GB
							</option>
						))}
					</select>
				)}
			/>
			<div className='avd-field wide'>
				<div className='avd-inline'>
					<label className='avd-check'>
						<input
							type='checkbox'
							checked={customerOn}
							disabled={creating}
							onChange={(e) =>
								setCustomerChoice(e.target.checked)
							}
						/>
						Customer screen (second display)
					</label>
					{customerOn && (
						<select
							className='avd-input avd-preset'
							aria-label='Customer screen size'
							value={presetKey(customerSize)}
							disabled={creating}
							onChange={(e) => setCustomerKey(e.target.value)}
						>
							{CUSTOMER_PRESETS.map((p) => (
								<option key={presetKey(p)} value={presetKey(p)}>
									{screenLabel(p)} at {p.density} dpi
								</option>
							))}
						</select>
					)}
				</div>
				<span className='avd-note'>
					tri.scrnz shows it next to the main screen, like a real
					customer display.
				</span>
			</div>
			<label className='avd-check wide'>
				<input
					type='checkbox'
					checked={startAfter}
					disabled={creating}
					onChange={(e) => setStartAfter(e.target.checked)}
				/>
				Start after creating
			</label>
			{error && (
				<p className='avd-error wide' role='alert'>
					{error}
				</p>
			)}
			<div className='avd-form-actions wide'>
				<button type='button' onClick={onCancel} disabled={creating}>
					Cancel
				</button>
				<button type='submit' className='primary' disabled={!canCreate}>
					{creating ? 'Creating…' : 'Create'}
				</button>
			</div>
		</form>
	)
}

interface FieldProps {
	label: string
	wide?: boolean
	note?: ReactNode
	control: (id: string) => JSX.Element
}

const Field = ({
	label,
	wide = false,
	note = null,
	control,
}: FieldProps): JSX.Element => {
	const id = useId()
	return (
		<div className={wide ? 'avd-field wide' : 'avd-field'}>
			<label className='avd-field-label' htmlFor={id}>
				{label}
			</label>
			{control(id)}
			{note}
		</div>
	)
}

interface NoSystemImagesProps {
	onRetry: () => void
	onDownload: () => void
	onBack: () => void
}

const NoSystemImages = ({
	onRetry,
	onDownload,
	onBack,
}: NoSystemImagesProps): JSX.Element => (
	<div className='avd-empty'>
		<strong>No system images are installed</strong>
		<p className='muted'>
			An emulator needs one. Download one here, or install it with Android
			Studio&apos;s SDK Manager and check again.
		</p>
		<div className='avd-form-actions'>
			<button type='button' onClick={onBack}>
				Back
			</button>
			<button type='button' onClick={onRetry}>
				Check again
			</button>
			<button type='button' className='primary' onClick={onDownload}>
				<Icon name='download' />
				Download a system image
			</button>
		</div>
	</div>
)
