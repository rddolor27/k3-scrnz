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

export interface Avd {
	name: string
	serial: string | null
}

export const listAvds = (): Promise<Avd[]> => invoke<Avd[]>('list_avds')

export const startEmulator = (avd: string): Promise<string> =>
	invoke<string>('start_emulator', { avd })

export const stopEmulator = (serial: string): Promise<void> =>
	invoke<void>('stop_emulator', { serial })

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
			'x-k3-upload': toHex(
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
