import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

/** Loopback WebSocket endpoint for video and control streams (spec section 8.1). */
export interface Endpoint {
	port: number
	token: string
}

/** adb connection states (src-tauri/src/adb/host.rs `DeviceState::as_str`). */
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

/** One device tab (src-tauri/src/devices.rs `DeviceView`). */
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

/** src-tauri/src/devices.rs `AdbStatus`. */
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

/** Saves a friendly name; an empty name clears it. */
export const setDeviceName = (serial: string, name: string): Promise<void> =>
	invoke<void>('set_device_name', { serial, name })

export const onDevicesChanged = (
	handler: (devices: DeviceView[]) => void,
): Promise<UnlistenFn> =>
	listen<DeviceView[]>('devices-changed', (event) => handler(event.payload))

/** src-tauri/src/files.rs `FileKind`. */
export type FileKind = 'dir' | 'file' | 'link' | 'other'

/** src-tauri/src/files.rs `FileEntry`. */
export interface FileEntry {
	name: string
	kind: FileKind
	size: number
	/** Seconds since the epoch. */
	modified: number
	/** `ls -l` style, e.g. `drwxrwx--x`. */
	mode: string
}

/** src-tauri/src/files.rs `Listing`. */
export interface Listing {
	path: string
	entries: FileEntry[]
	error: string | null
}

/** A device path, optionally inside a debuggable app via `run-as`. */
export interface FileLocation {
	path: string
	runAs: string | null
}

export const listDir = (serial: string, at: FileLocation): Promise<Listing> =>
	invoke<Listing>('list_dir', { serial, path: at.path, runAs: at.runAs })

/** Saves to Downloads\k3-scrnz\<serial>\ and resolves to the local path. */
export const downloadFile = (
	serial: string,
	file: FileLocation,
): Promise<string> =>
	invoke<string>('download_file', {
		serial,
		path: file.path,
		runAs: file.runAs,
	})

/** Uploads a local file (from drag and drop) into `dir`. */
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

/** Uploads picked file bytes into `dir` (raw body + metadata header). */
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

/** Shows a downloaded file in Windows Explorer. */
export const revealFile = (path: string): Promise<void> =>
	invoke<void>('reveal_file', { path })

/** Third-party packages, for opening app data with `run-as`. */
export const listPackages = (serial: string): Promise<string[]> =>
	invoke<string[]>('list_packages', { serial })

export const onAdbStatus = (
	handler: (status: AdbStatus) => void,
): Promise<UnlistenFn> =>
	listen<AdbStatus>('adb-status', (event) => handler(event.payload))
