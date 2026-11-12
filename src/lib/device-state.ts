import type { DeviceView } from './ipc'

export type Tone = 'ok' | 'wait' | 'bad' | 'idle'

type StateFields = Pick<DeviceView, 'state' | 'gone'>

export const stateTone = ({ state, gone }: StateFields): Tone => {
	if (gone) return 'idle'
	switch (state) {
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

export const stateLabel = ({ state, gone }: StateFields): string | null => {
	if (gone) return 'disconnected'
	return state === 'device' ? null : state
}

export const stateHint = ({ state, gone }: StateFields): string | null => {
	if (gone) {
		return 'Disconnected. This tab closes shortly unless the device comes back.'
	}
	switch (state) {
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
			return `The device is in ${state} mode.`
	}
}
