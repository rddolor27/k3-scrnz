import { useCallback, useSyncExternalStore } from 'react'

import { screensRecordingName } from '../lib/capture'
import { info } from '../lib/log'
import { encodesInHardware } from '../video/encoder-config'
import {
	type FrameTap,
	listTaps,
	subscribeTapChanges,
} from '../video/frame-taps'
import { layoutRow, type RowLayout } from '../video/grid-layout'
import {
	type CompositePlan,
	useCompositeRecording,
} from './composite-recording'
import type { ShowNote } from './note'

const GAP = 8
// WebView2 encodes H.264 on the GPU up to 3840 px wide; wider frames fall to the software encoder.
const NATIVE_MAX_WIDTH = 3840
const NATIVE_MAX_HEIGHT = 2160
const SCALED_MAX_WIDTH = 1920
const SCALED_MAX_HEIGHT = 1080
const NOT_STREAMING = 'Both screens must be streaming first.'

interface UseDeviceRecordingOptions {
	serial: string
	showNote: ShowNote
}

export interface DeviceRecording {
	since: number | null
	busy: boolean
	ready: boolean
	toggle: () => void
}

const deviceTaps = (serial: string): FrameTap[] =>
	listTaps().filter((tap) => tap.serial === serial)

const orderedTaps = (serial: string): FrameTap[] =>
	deviceTaps(serial).sort(
		(a, b) =>
			Number(b.role === 'main') - Number(a.role === 'main') ||
			a.displayId - b.displayId,
	)

const isReady = (serial: string): boolean => {
	const taps = deviceTaps(serial)
	return (
		taps.some((tap) => tap.role === 'main') &&
		taps.some((tap) => tap.role === 'customer')
	)
}

const planRow = async (serial: string): Promise<CompositePlan> => {
	const taps = orderedTaps(serial)
	const [main, ...customers] = taps
	if (main?.role !== 'main' || customers.length === 0) {
		throw new Error(NOT_STREAMING)
	}
	const sizes = taps.map((tap) => tap.size())
	const known = sizes.filter((size) => size !== null)
	if (known.length !== sizes.length) throw new Error(NOT_STREAMING)
	// Two 1920 px screens fill the native width: the gap gives way before the scale does.
	const spare =
		NATIVE_MAX_WIDTH - known.reduce((sum, size) => sum + size.width, 0)
	const gap = Math.max(
		0,
		Math.min(GAP, Math.floor(spare / (known.length - 1))),
	)
	let layout: RowLayout = layoutRow(
		known,
		gap,
		NATIVE_MAX_WIDTH,
		NATIVE_MAX_HEIGHT,
	)
	const native = await encodesInHardware(layout.width, layout.height).catch(
		() => false,
	)
	if (!native) {
		layout = layoutRow(known, GAP, SCALED_MAX_WIDTH, SCALED_MAX_HEIGHT)
	}
	void info(
		`screens recording ${serial}: ${layout.width}x${layout.height} (${native ? 'native size, GPU encoder' : 'fitted to 1920x1080, no GPU encoder for the native size'})`,
	)
	return {
		name: screensRecordingName(),
		width: layout.width,
		height: layout.height,
		serial,
		cells: taps.map((tap, i) => ({
			key: tap.key,
			rect: layout.cells[i] ?? { x: 0, y: 0, w: 0, h: 0 },
		})),
	}
}

export const useDeviceRecording = ({
	serial,
	showNote,
}: UseDeviceRecordingOptions): DeviceRecording => {
	const getReady = useCallback((): boolean => isReady(serial), [serial])
	const ready = useSyncExternalStore(subscribeTapChanges, getReady)
	const accepts = useCallback(
		(tap: FrameTap): boolean => tap.serial === serial,
		[serial],
	)
	const plan = useCallback(() => planRow(serial), [serial])
	const { since, busy, toggle } = useCompositeRecording({
		accepts,
		order: [],
		plan,
		showNote,
	})
	return { since, busy, ready, toggle }
}
