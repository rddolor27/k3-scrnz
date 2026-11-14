import { androidLabel, versionLabel } from './avd'
import type { Tone } from './device-state'
import type { InstallProgress, RemoteImage } from './ipc'
import { formatSize } from './paths'

export type ImageKind = 'play' | 'apis' | 'aosp'
export type KindFilter = 'all' | ImageKind

export interface ImageFilter {
	kind: KindFilter
	tablets: boolean
	installedOnly: boolean
}

export interface ImageGroup {
	apiLevel: number
	images: RemoteImage[]
}

export const DEFAULT_FILTER: ImageFilter = {
	kind: 'all',
	tablets: true,
	installedOnly: false,
}

export const KIND_OPTIONS: readonly { value: KindFilter; label: string }[] = [
	{ value: 'all', label: 'All types' },
	{ value: 'play', label: 'Google Play' },
	{ value: 'apis', label: 'Google APIs' },
	{ value: 'aosp', label: 'AOSP' },
]

const KIND_ORDER: readonly (ImageKind | null)[] = ['play', 'apis', 'aosp', null]

const tagIds = (tag: string): string[] =>
	tag
		.split(',')
		.map((id) => id.trim())
		.filter((id) => id !== '')

export const imageKind = ({
	tag,
	playStore,
}: Pick<RemoteImage, 'tag' | 'playStore'>): ImageKind | null => {
	const ids = tagIds(tag)
	if (playStore || ids.some((id) => id.includes('playstore'))) return 'play'
	if (ids.some((id) => id.includes('google_apis'))) return 'apis'
	if (ids.some((id) => id === 'default' || id.includes('aosp'))) return 'aosp'
	return null
}

export const isTabletImage = ({ tag }: Pick<RemoteImage, 'tag'>): boolean =>
	tagIds(tag).some((id) => id.includes('tablet'))

export const filterImages = (
	images: readonly RemoteImage[],
	filter: ImageFilter,
): RemoteImage[] =>
	images.filter(
		(image) =>
			(filter.kind === 'all' || imageKind(image) === filter.kind) &&
			(filter.tablets || !isTabletImage(image)) &&
			(!filter.installedOnly || image.installed),
	)

const abiRank = (abi: string): number => (abi === 'x86_64' ? 0 : 1)

const compareImages = (a: RemoteImage, b: RemoteImage): number =>
	(b.apiMinor ?? 0) - (a.apiMinor ?? 0) ||
	(b.extensionLevel ?? 0) - (a.extensionLevel ?? 0) ||
	KIND_ORDER.indexOf(imageKind(a)) - KIND_ORDER.indexOf(imageKind(b)) ||
	a.tagDisplay.localeCompare(b.tagDisplay) ||
	abiRank(a.abi) - abiRank(b.abi) ||
	a.abi.localeCompare(b.abi)

export const groupByAndroid = (
	images: readonly RemoteImage[],
): ImageGroup[] => {
	const groups = new Map<number, RemoteImage[]>()
	for (const image of images) {
		const group = groups.get(image.apiLevel)
		if (group) group.push(image)
		else groups.set(image.apiLevel, [image])
	}
	return [...groups]
		.sort(([a], [b]) => b - a)
		.map(([apiLevel, list]) => ({
			apiLevel,
			images: list.sort(compareImages),
		}))
}

export const groupTitle = (apiLevel: number): string => {
	const label = androidLabel(apiLevel)
	return label.startsWith('API') ? label : `${label} · API ${apiLevel}`
}

export const imageShortLabel = ({
	apiLevel,
	apiMinor,
	tagDisplay,
}: Pick<RemoteImage, 'apiLevel' | 'apiMinor' | 'tagDisplay'>): string =>
	`${versionLabel(apiLevel, apiMinor)} · ${tagDisplay}`

export const revisionLabel = (revision: string): string =>
	/^r/i.test(revision) ? revision : `r${revision}`

export const imageStatus = (
	image: RemoteImage,
): { tone: Tone; text: string } => {
	if (!image.installed) return { tone: 'idle', text: 'Not installed' }
	const current =
		image.installedRevision === null
			? null
			: revisionLabel(image.installedRevision)
	if (image.updateAvailable) {
		return {
			tone: 'wait',
			text: current
				? `Update available ${current} → ${revisionLabel(image.revision)}`
				: 'Update available',
		}
	}
	return { tone: 'ok', text: current ? `Installed ${current}` : 'Installed' }
}

export const imageMeta = (image: RemoteImage): string =>
	[
		image.sizeBytes > 0 ? formatSize(image.sizeBytes) : null,
		image.extensionLevel === null
			? null
			: `Extension ${image.extensionLevel}`,
	]
		.filter((part): part is string => part !== null)
		.join(' · ')

export const emulatorWarning = ({
	minEmulator,
}: Pick<RemoteImage, 'minEmulator'>): string =>
	minEmulator === null
		? 'Needs a newer emulator; update it in Android Studio.'
		: `Needs emulator ${minEmulator} or newer; update it in Android Studio.`

export const isInstallFinished = ({
	phase,
}: Pick<InstallProgress, 'phase'>): boolean =>
	phase === 'done' || phase === 'failed' || phase === 'cancelled'

export const installPercent = ({
	phase,
	received,
	total,
}: InstallProgress): number | null => {
	if ((phase !== 'downloading' && phase !== 'extracting') || total <= 0) {
		return null
	}
	return Math.min(100, Math.floor((received / total) * 100))
}

export const installText = (progress: InstallProgress): string => {
	const percent = installPercent(progress)
	switch (progress.phase) {
		case 'downloading':
			return percent === null
				? 'Downloading…'
				: `Downloading ${formatSize(progress.received)} of ${formatSize(progress.total)} (${percent}%)`
		case 'verifying':
			return 'Checking the download…'
		case 'extracting':
			return percent === null ? 'Unpacking…' : `Unpacking… ${percent}%`
		case 'installing':
			return 'Installing…'
		case 'done':
			return 'Installed'
		case 'cancelled':
			return 'Cancelled'
		case 'failed':
			return progress.error ?? 'The install failed.'
	}
}
