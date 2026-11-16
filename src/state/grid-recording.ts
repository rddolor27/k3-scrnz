import { gridRecordingName } from '../lib/capture'
import { type FrameTap, tapKey } from '../video/frame-taps'
import {
	type CompositePlan,
	type CompositeRecording,
	useCompositeRecording,
} from './composite-recording'
import type { ShowNote } from './note'

const OUTPUT_WIDTH = 1920
const OUTPUT_HEIGHT = 1080

interface UseGridRecordingOptions {
	serials: string[]
	showNote: ShowNote
}

export type GridRecording = CompositeRecording

const acceptsMain = (tap: FrameTap): boolean => tap.role === 'main'

const planGrid = (): Promise<CompositePlan> =>
	Promise.resolve({
		name: gridRecordingName(),
		width: OUTPUT_WIDTH,
		height: OUTPUT_HEIGHT,
	})

export const useGridRecording = ({
	serials,
	showNote,
}: UseGridRecordingOptions): GridRecording =>
	useCompositeRecording({
		accepts: acceptsMain,
		order: serials.map((serial) => tapKey(serial, 0)),
		plan: planGrid,
		showNote,
	})
