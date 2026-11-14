import type { Tone } from './device-state'
import type { Avd, DisplaySize, SystemImage } from './ipc'

export type AvdBusy = 'starting' | 'stopping' | 'deleting'

export const NAME_MAX = 64
export const SCREEN_MIN = 240
export const SCREEN_MAX = 4096
export const DENSITY_MIN = 120
export const DENSITY_MAX = 640
export const DEFAULT_RAM_GB = 2
export const DEFAULT_STORAGE_GB = 6
export const RAM_OPTIONS_GB: readonly number[] = [1, 2, 3, 4, 6, 8]
export const STORAGE_OPTIONS_GB: readonly number[] = [4, 6, 8, 16, 32]

export const CUSTOMER_PRESETS: readonly DisplaySize[] = [
	{ width: 1280, height: 800, density: 160 },
	{ width: 1920, height: 1080, density: 160 },
	{ width: 1024, height: 600, density: 160 },
	{ width: 800, height: 480, density: 120 },
]

export interface HardwareProfile {
	id: string
	label: string
	deviceName: string
	screen: DisplaySize | null
	tablet: boolean
	customerScreen: boolean
}

export const DEFAULT_SCREEN: DisplaySize = {
	width: 1080,
	height: 2400,
	density: 420,
}

const PHONE_PROFILE: HardwareProfile = {
	id: 'phone',
	label: 'Phone',
	deviceName: 'phone',
	screen: DEFAULT_SCREEN,
	tablet: false,
	customerScreen: false,
}

export const DEFAULT_PROFILE: HardwareProfile = PHONE_PROFILE

export const HARDWARE_PROFILES: readonly HardwareProfile[] = [
	PHONE_PROFILE,
	{
		id: 'small_phone',
		label: 'Small phone',
		deviceName: 'small_phone',
		screen: { width: 720, height: 1280, density: 320 },
		tablet: false,
		customerScreen: false,
	},
	{
		id: 'tablet',
		label: 'Tablet',
		deviceName: 'tablet',
		screen: { width: 2560, height: 1600, density: 320 },
		tablet: true,
		customerScreen: false,
	},
	{
		id: 'pos_15',
		label: 'POS terminal 15.6″',
		deviceName: 'pos_15',
		screen: { width: 1920, height: 1080, density: 160 },
		tablet: false,
		customerScreen: true,
	},
	{
		id: 'pos_10',
		label: 'POS terminal 10.1″',
		deviceName: 'pos_10',
		screen: { width: 1280, height: 800, density: 160 },
		tablet: false,
		customerScreen: true,
	},
	{
		id: 'pos_handheld',
		label: 'Handheld POS',
		deviceName: 'pos_handheld',
		screen: { width: 720, height: 1280, density: 320 },
		tablet: false,
		customerScreen: false,
	},
	{
		id: 'custom',
		label: 'Custom',
		deviceName: 'custom',
		screen: null,
		tablet: false,
		customerScreen: false,
	},
]

const ANDROID_VERSIONS: ReadonlyMap<number, string> = new Map([
	[24, '7.0'],
	[25, '7.1'],
	[26, '8.0'],
	[27, '8.1'],
	[28, '9'],
	[29, '10'],
	[30, '11'],
	[31, '12'],
	[32, '12L'],
	[33, '13'],
	[34, '14'],
	[35, '15'],
	[36, '16'],
	[37, '17'],
])

const PHONE_IMAGE_TAGS = /^(default|google_apis|google_apis_playstore)$/

export const androidLabel = (apiLevel: number): string => {
	const version = ANDROID_VERSIONS.get(apiLevel)
	return version ? `Android ${version}` : `API ${apiLevel}`
}

export const profileBaseName = ({ label }: HardwareProfile): string =>
	label.replace(/″/g, '')

export const versionLabel = (
	apiLevel: number,
	apiMinor: number | null = null,
): string =>
	apiMinor
		? `${androidLabel(apiLevel)} (API ${apiLevel}.${apiMinor})`
		: androidLabel(apiLevel)

export const imageLabel = (
	image: Pick<SystemImage, 'apiLevel' | 'tagDisplay' | 'abi'> & {
		apiMinor?: number | null
	},
): string =>
	`${versionLabel(image.apiLevel, image.apiMinor)} · ${image.tagDisplay} · ${image.abi}`

export const avdTitle = ({
	name,
	displayName,
}: Pick<Avd, 'name' | 'displayName'>): string => {
	const custom = displayName?.trim()
	return custom ? custom : name.replace(/_/g, ' ')
}

export const screenLabel = ({
	width,
	height,
}: Pick<DisplaySize, 'width' | 'height'>): string => `${width}×${height}`

export const presetKey = ({ width, height, density }: DisplaySize): string =>
	`${width}x${height}@${density}`

export const deriveAvdName = (text: string): string =>
	text
		.trim()
		.replace(/\s+/g, '_')
		.replace(/[^A-Za-z0-9._-]/g, '')
		.replace(/^[._-]+/, '')
		.slice(0, NAME_MAX)
		.replace(/\.+$/, '')

const sameName = (a: string, b: string): boolean =>
	a.toLowerCase() === b.toLowerCase()

export const isNameTaken = (
	avdName: string,
	existing: readonly string[],
): boolean => existing.some((name) => sameName(name, avdName))

export const suggestName = (
	base: string,
	existing: readonly string[],
): string => {
	for (let n = 1; n < 100; n += 1) {
		const candidate = n === 1 ? base : `${base} ${n}`
		if (!isNameTaken(deriveAvdName(candidate), existing)) return candidate
	}
	return base
}

export const nameProblem = (
	typed: string,
	avdName: string,
	existing: readonly string[],
): string | null => {
	if (typed.trim() === '') return 'Enter a name.'
	if (avdName === '') return 'Use at least one letter or number.'
	if (isNameTaken(avdName, existing)) {
		return `An emulator named ${avdName} already exists. Pick another name.`
	}
	return null
}

export const parseWhole = (
	text: string,
	min: number,
	max: number,
): number | null => {
	if (!/^\d{1,6}$/.test(text.trim())) return null
	const value = Number(text)
	return value >= min && value <= max ? value : null
}

const isPhoneImage = (image: SystemImage): boolean =>
	PHONE_IMAGE_TAGS.test(image.tag)

const isTabletImage = (image: SystemImage): boolean =>
	image.tag.includes('tablet')

export const pickDefaultImage = (
	images: readonly SystemImage[],
	tablet: boolean,
): SystemImage | null => {
	const tiers = tablet
		? [isTabletImage, isPhoneImage]
		: [isPhoneImage, (image: SystemImage): boolean => !isTabletImage(image)]
	for (const tier of tiers) {
		const group = images.filter(tier)
		const found = group.find((image) => image.abi === 'x86_64') ?? group[0]
		if (found) return found
	}
	return images.find((image) => image.abi === 'x86_64') ?? images[0] ?? null
}

export const avdDisplayText = (
	avd: Avd,
	busy: AvdBusy | null,
): { tone: Tone; text: string } => {
	if (busy === 'deleting') return { tone: 'idle', text: 'Deleting…' }
	if (busy === 'stopping' && avd.state !== 'stopped') {
		return { tone: 'wait', text: 'Stopping…' }
	}
	if (busy === 'starting' || avd.state === 'booting') {
		return { tone: 'wait', text: 'Starting…' }
	}
	if (avd.state === 'running') {
		return {
			tone: 'ok',
			text: avd.serial ? `Running · ${avd.serial}` : 'Running',
		}
	}
	return { tone: 'idle', text: 'Stopped' }
}
