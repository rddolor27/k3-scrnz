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

export const onAdbStatus = (
	handler: (status: AdbStatus) => void,
): Promise<UnlistenFn> =>
	listen<AdbStatus>('adb-status', (event) => handler(event.payload))
