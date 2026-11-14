import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export interface Endpoint {
	port: number
	token: string
}

export type DeviceState =
	| 'device'
	| 'offline'
	| 'unauthorized'
	| 'authorizing'
	| 'connecting'
	| 'recovery'
	| 'sideload'
	| 'rescue'
	| 'bootloader'
	| 'host'
	| 'detached'
	| 'no-permissions'
	| 'unknown'

export interface DeviceView {
	serial: string
	name: string
	pinned: boolean
	state: DeviceState
	model: string | null
	product: string | null
	device: string | null
	transportId: number
	gone: boolean
}

export interface AdbStatus {
	connected: boolean
	version: number | null
	error: string | null
}

export const getEndpoint = (): Promise<Endpoint> =>
	invoke<Endpoint>('get_endpoint')

export const listDevices = (): Promise<DeviceView[]> =>
	invoke<DeviceView[]>('list_devices')

export const getAdbStatus = (): Promise<AdbStatus> =>
	invoke<AdbStatus>('get_adb_status')

export interface AppStats {
	cpuPercent: number
	memoryBytes: number
	processes: number
	emulatorCpuPercent: number
	emulatorMemoryBytes: number
}

export const getAppStats = (): Promise<AppStats> =>
	invoke<AppStats>('get_app_stats')

export type AvdState = 'stopped' | 'booting' | 'running'

export interface DisplaySize {
	width: number
	height: number
	density: number
}

export interface Avd {
	name: string
	serial: string | null
	state: AvdState
	displayName: string | null
	apiLevel: number | null
	tag: string | null
	tagDisplay: string | null
	abi: string | null
	width: number | null
	height: number | null
	density: number | null
	ramMb: number | null
	playStore: boolean
	customerDisplay: DisplaySize | null
	path: string | null
}

export interface SystemImage {
	id: string
	apiLevel: number
	tag: string
	tagDisplay: string
	abi: string
	playStore: boolean
	description: string | null
}

export interface AvdSpec {
	name: string
	displayName: string | null
	image: string
	width: number
	height: number
	density: number
	ramMb: number
	storageGb: number
	deviceName: string | null
	customerDisplay: DisplaySize | null
}

export interface StartOptions {
	coldBoot: boolean
	wipeData: boolean
}

export const listAvds = (): Promise<Avd[]> => invoke<Avd[]>('list_avds')

export const listSystemImages = (): Promise<SystemImage[]> =>
	invoke<SystemImage[]>('list_system_images')

export const createAvd = (spec: AvdSpec): Promise<Avd> =>
	invoke<Avd>('create_avd', { spec })

export const deleteAvd = (name: string): Promise<void> =>
	invoke<void>('delete_avd', { name })

export const startEmulator = (
	avd: string,
	options?: StartOptions,
): Promise<string> =>
	invoke<string>('start_emulator', { avd, options: options ?? null })

export const stopEmulator = (serial: string): Promise<void> =>
	invoke<void>('stop_emulator', { serial })

export interface RemoteImage {
	id: string
	apiLevel: number
	apiMinor: number | null
	extensionLevel: number | null
	tag: string
	tagDisplay: string
	abi: string
	playStore: boolean
	revision: string
	displayName: string
	sizeBytes: number
	licenseId: string
	minEmulator: string | null
	emulatorTooOld: boolean
	installed: boolean
	installedRevision: string | null
	updateAvailable: boolean
}

export interface License {
	id: string
	text: string
	accepted: boolean
}

export interface RemoteCatalog {
	images: RemoteImage[]
	licenses: License[]
	errors: string[]
}

export type InstallPhase =
	| 'downloading'
	| 'verifying'
	| 'extracting'
	| 'installing'
	| 'done'
	| 'failed'
	| 'cancelled'

export interface InstallProgress {
	id: string
	phase: InstallPhase
	received: number
	total: number
	error: string | null
}

export const listRemoteImages = (refresh: boolean): Promise<RemoteCatalog> =>
	invoke<RemoteCatalog>('list_remote_images', { refresh })

export const installSystemImage = (
	id: string,
	acceptLicense: boolean,
): Promise<void> => invoke<void>('install_system_image', { id, acceptLicense })

export const cancelSystemImageInstall = (): Promise<void> =>
	invoke<void>('cancel_system_image_install')

export const getSystemImageInstall = (): Promise<InstallProgress | null> =>
	invoke<InstallProgress | null>('get_system_image_install')

export const uninstallSystemImage = (id: string): Promise<void> =>
	invoke<void>('uninstall_system_image', { id })

export const onSystemImageProgress = (
	handler: (progress: InstallProgress) => void,
): Promise<UnlistenFn> =>
	listen<InstallProgress>('system-image-progress', (event) =>
		handler(event.payload),
	)

export const isEmulator = (serial: string): boolean =>
	serial.startsWith('emulator-')

export const setDeviceName = (serial: string, name: string): Promise<void> =>
	invoke<void>('set_device_name', { serial, name })

export const onDevicesChanged = (
	handler: (devices: DeviceView[]) => void,
): Promise<UnlistenFn> =>
	listen<DeviceView[]>('devices-changed', (event) => handler(event.payload))

export type FileKind = 'dir' | 'file' | 'link' | 'other'

export interface FileEntry {
	name: string
	kind: FileKind
	size: number
	modified: number
	mode: string
}

export interface Listing {
	path: string
	entries: FileEntry[]
	error: string | null
}

export interface FileLocation {
	path: string
	runAs: string | null
}

export const listDir = (serial: string, at: FileLocation): Promise<Listing> =>
	invoke<Listing>('list_dir', { serial, path: at.path, runAs: at.runAs })

export const downloadFile = (
	serial: string,
	file: FileLocation,
): Promise<string> =>
	invoke<string>('download_file', {
		serial,
		path: file.path,
		runAs: file.runAs,
	})

export interface FolderSaved {
	path: string
	files: number
	failed: string[]
}

export const downloadFolder = (
	serial: string,
	folder: FileLocation,
): Promise<FolderSaved> =>
	invoke<FolderSaved>('download_folder', {
		serial,
		path: folder.path,
		runAs: folder.runAs,
	})

export const uploadPath = (
	serial: string,
	localPath: string,
	dir: FileLocation,
): Promise<string> =>
	invoke<string>('upload_path', {
		serial,
		localPath,
		remoteDir: dir.path,
		runAs: dir.runAs,
	})

const toHex = (text: string): string =>
	Array.from(new TextEncoder().encode(text), (b) =>
		b.toString(16).padStart(2, '0'),
	).join('')

export const uploadBytes = (
	serial: string,
	dir: FileLocation,
	name: string,
	bytes: Uint8Array,
): Promise<string> =>
	invoke<string>('upload_bytes', bytes, {
		headers: {
			'x-tri-upload': toHex(
				JSON.stringify({
					serial,
					dir: dir.path,
					name,
					runAs: dir.runAs,
				}),
			),
		},
	})

export const makeDir = (serial: string, at: FileLocation): Promise<void> =>
	invoke<void>('make_dir', { serial, path: at.path, runAs: at.runAs })

export const deletePath = (serial: string, at: FileLocation): Promise<void> =>
	invoke<void>('delete_path', { serial, path: at.path, runAs: at.runAs })

export const revealFile = (path: string): Promise<void> =>
	invoke<void>('reveal_file', { path })

export const listPackages = (serial: string): Promise<string[]> =>
	invoke<string[]>('list_packages', { serial })

export type AppAction = 'restart' | 'forceStop' | 'clearData'

export const installApkPath = (
	serial: string,
	localPath: string,
): Promise<string> => invoke<string>('install_apk_path', { serial, localPath })

export const installApkBytes = (
	serial: string,
	name: string,
	bytes: Uint8Array,
): Promise<string> =>
	invoke<string>('install_apk_bytes', bytes, {
		headers: { 'x-tri-install': toHex(JSON.stringify({ serial, name })) },
	})

export const appAction = (
	serial: string,
	appPackage: string,
	action: AppAction,
): Promise<string> =>
	invoke<string>('app_action', { serial, package: appPackage, action })

export type MirrorRole = 'main' | 'customer'

export interface MirrorStarted {
	sessionId: string
	width: number
	height: number
}

export interface SessionState {
	sessionId: string
	serial: string
	state: 'starting' | 'streaming' | 'stopped' | 'error'
	error: string | null
}

export const startMirror = (
	serial: string,
	displayId: number,
	role: MirrorRole,
	maxSize?: number,
): Promise<MirrorStarted> =>
	invoke<MirrorStarted>('start_mirror', {
		serial,
		displayId,
		role,
		maxSize: maxSize ?? null,
	})

export const stopMirror = (sessionId: string): Promise<void> =>
	invoke<void>('stop_mirror', { sessionId })

export const devicePower = (
	serial: string,
	action: 'toggle' | 'wake' | 'sleep',
): Promise<'Awake' | 'Asleep'> =>
	invoke<'Awake' | 'Asleep'>('device_power', { serial, action })

export const onSessionState = (
	handler: (state: SessionState) => void,
): Promise<UnlistenFn> =>
	listen<SessionState>('session-state', (event) => handler(event.payload))

export const onDeviceClipboard = (
	handler: (clip: { serial: string; text: string }) => void,
): Promise<UnlistenFn> =>
	listen<{ serial: string; text: string }>('device-clipboard', (event) =>
		handler(event.payload),
	)

export interface ScreenshotCapture {
	serial: string
	name: string
	width: number
	height: number
	pngLength: number
}

export interface ScreenshotSaved {
	path: string
	copied: boolean
	copyError: string | null
}

// Body: the PNG bytes immediately followed by width * height * 4 RGBA bytes.
export const saveScreenshot = (
	capture: ScreenshotCapture,
	body: Uint8Array,
): Promise<ScreenshotSaved> =>
	invoke<ScreenshotSaved>('save_screenshot', body, {
		headers: { 'x-tri-capture': toHex(JSON.stringify(capture)) },
	})

export type RecordingEndReason =
	| 'stopped'
	| 'sessionEnded'
	| 'sizeChanged'
	| 'limit'
	| 'failed'

export interface RecordingEnded {
	sessionId: string
	path: string
	durationMs: number
	bytes: number
	reason: RecordingEndReason
	error: string | null
}

export const startRecording = (
	sessionId: string,
	name: string,
): Promise<string> => invoke<string>('start_recording', { sessionId, name })

export const stopRecording = (sessionId: string): Promise<RecordingEnded> =>
	invoke<RecordingEnded>('stop_recording', { sessionId })

export interface GridRecordingStarted {
	id: string
	path: string
}

export const startGridRecording = (
	name: string,
	width: number,
	height: number,
): Promise<GridRecordingStarted> =>
	invoke<GridRecordingStarted>('start_grid_recording', {
		name,
		width,
		height,
	})

export const stopGridRecording = (id: string): Promise<RecordingEnded> =>
	invoke<RecordingEnded>('stop_grid_recording', { id })

export const onRecordingEnded = (
	handler: (ended: RecordingEnded) => void,
): Promise<UnlistenFn> =>
	listen<RecordingEnded>('recording-ended', (event) => handler(event.payload))

export interface DisplayInfo {
	id: number
	name: string
	width: number
	height: number
	state: string
	kind: string
	uniqueId: string | null
	owner: string | null
	flags: string[]
	touch: string | null
	customer: boolean
}

export const getDisplays = (serial: string): Promise<DisplayInfo[]> =>
	invoke<DisplayInfo[]>('get_displays', { serial })

export const setVisibleDevice = (serial: string | null): Promise<void> =>
	invoke<void>('set_visible_device', { serial })

export const onDisplaysChanged = (
	handler: (change: { serial: string; displays: DisplayInfo[] }) => void,
): Promise<UnlistenFn> =>
	listen<{ serial: string; displays: DisplayInfo[] }>(
		'displays-changed',
		(event) => handler(event.payload),
	)

export const onAdbStatus = (
	handler: (status: AdbStatus) => void,
): Promise<UnlistenFn> =>
	listen<AdbStatus>('adb-status', (event) => handler(event.payload))
