import type { MirrorRole } from './ipc'

const pad = (n: number): string => String(n).padStart(2, '0')

const stamp = (): string => {
	const d = new Date()
	const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
	const time = `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
	return `${date} ${time}`
}

export const captureName = (
	kind: 'screenshot' | 'recording',
	role: MirrorRole,
): string => {
	const suffix = role === 'customer' ? ' customer' : ''
	return kind === 'screenshot'
		? `Screenshot ${stamp()}${suffix}.png`
		: `Recording ${stamp()}${suffix}.mp4`
}

export const gridRecordingName = (): string => `Grid recording ${stamp()}.mp4`

export const formatElapsed = (ms: number): string => {
	const seconds = Math.max(0, Math.floor(ms / 1000))
	return `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`
}
