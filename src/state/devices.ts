import type { UnlistenFn } from '@tauri-apps/api/event'
import { useEffect, useState } from 'react'

import {
	type AdbStatus,
	type DeviceView,
	getAdbStatus,
	listDevices,
	onAdbStatus,
	onDevicesChanged,
} from '../lib/ipc'
import { error } from '../lib/log'

export interface DevicesState {
	devices: DeviceView[]
	adb: AdbStatus
}

const NO_STATUS: AdbStatus = { connected: false, version: null, error: null }

/**
 * Live device list and adb server status. Subscribes to the Rust events first,
 * then fetches the current state; a snapshot never overwrites a newer event.
 */
export const useDevices = (): DevicesState => {
	const [devices, setDevices] = useState<DeviceView[]>([])
	const [adb, setAdb] = useState<AdbStatus>(NO_STATUS)

	useEffect(() => {
		let live = true
		let gotDevices = false
		let gotStatus = false
		const unlisteners: UnlistenFn[] = []
		const keep = (unlisten: UnlistenFn): void => {
			if (live) unlisteners.push(unlisten)
			else unlisten()
		}

		const init = async (): Promise<void> => {
			keep(
				await onDevicesChanged((next) => {
					gotDevices = true
					if (live) setDevices(next)
				}),
			)
			keep(
				await onAdbStatus((next) => {
					gotStatus = true
					if (live) setAdb(next)
				}),
			)
			const [snapshot, status] = await Promise.all([
				listDevices(),
				getAdbStatus(),
			])
			if (!live) return
			if (!gotDevices) setDevices(snapshot)
			if (!gotStatus) setAdb(status)
		}
		init().catch((e: unknown) => {
			void error(`device list unavailable: ${String(e)}`)
		})

		return (): void => {
			live = false
			unlisteners.forEach((unlisten) => unlisten())
		}
	}, [])

	return { devices, adb }
}
