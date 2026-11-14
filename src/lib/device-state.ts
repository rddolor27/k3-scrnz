import { type DeviceView, isEmulator } from './ipc'

export type Tone = 'ok' | 'wait' | 'bad' | 'idle'

type StateFields = Pick<DeviceView, 'serial' | 'state' | 'gone'>

export const isStartingEmulator = ({
	serial,
	state,
	gone,
}: StateFields): boolean => !gone && state === 'offline' && isEmulator(serial)

export const stateTone = (device: StateFields): Tone => {
	if (device.gone) return 'idle'
	if (isStartingEmulator(device)) return 'wait'
	switch (device.state) {
		case 'device':
			return 'ok'
		case 'authorizing':
		case 'connecting':
			return 'wait'
		case 'offline':
		case 'unauthorized':
		case 'no-permissions':
			return 'bad'
		default:
			return 'idle'
	}
}

export const stateLabel = (device: StateFields): string | null => {
	if (device.gone) return 'disconnected'
	if (isStartingEmulator(device)) return 'starting'
	return device.state === 'device' ? null : device.state
}

export const stateHint = (device: StateFields): string | null => {
	if (device.gone) {
		return 'Disconnected. This tab closes shortly unless the device comes back.'
	}
	if (isStartingEmulator(device)) {
		return 'The emulator is starting. Its screen appears once Android has booted, usually within a minute; the first boot of a new emulator takes longer.'
	}
	switch (device.state) {
		case 'device':
			return null
		case 'unauthorized':
			return 'Accept the USB debugging prompt on the device.'
		case 'authorizing':
		case 'connecting':
			return 'Waiting for the device to finish connecting…'
		case 'offline':
			return 'The device is offline. Reconnect the USB cable; ports directly on the PC are more reliable than hub ports.'
		case 'no-permissions':
			return 'adb has no permission to talk to this device.'
		default:
			return `The device is in ${device.state} mode.`
	}
}
