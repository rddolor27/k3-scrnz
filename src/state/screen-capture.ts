import { type RefObject, useCallback, useEffect, useState } from 'react'

import { captureName, formatElapsed } from '../lib/capture'
import {
	type MirrorRole,
	onRecordingEnded,
	type RecordingEnded,
	type RecordingEndReason,
	saveScreenshot,
	startRecording,
	stopRecording,
} from '../lib/ipc'
import { warn } from '../lib/log'
import { requestScreenshot } from '../video/screenshot'
import type { NoteOptions, ShowNote } from './note'

const AUTO_END_NOTE: Record<RecordingEndReason, string> = {
	stopped: '',
	failed: '',
	sessionEnded: ' (the mirror stopped)',
	sizeChanged: ' (the screen size changed)',
	limit: ' (limit reached)',
}

interface Recording {
	sessionId: string
	since: number
}

interface UseScreenCaptureOptions {
	serial: string
	role: MirrorRole
	sessionId: string | null
	workerRef: RefObject<Worker | null>
	showNote: ShowNote
}

export interface ScreenCapture {
	shooting: boolean
	recordingSince: number | null
	recordingBusy: boolean
	takeScreenshot: () => void
	toggleRecording: () => void
}

export const describeEnd = (
	ended: RecordingEnded,
): { text: string; options: NoteOptions } => {
	const { reason, bytes, error, durationMs, path } = ended
	if (bytes === 0) {
		return {
			text: `Recording failed: ${error ?? 'nothing was recorded'}`,
			options: { error: true },
		}
	}
	const length = formatElapsed(durationMs)
	if (reason === 'failed') {
		return {
			text: `Recording cut short after ${length}: ${error ?? 'unknown error'}`,
			options: { error: true, revealPath: path },
		}
	}
	return {
		text: `Recording saved · ${length}${AUTO_END_NOTE[reason]}`,
		options: { revealPath: path },
	}
}

export const useScreenCapture = ({
	serial,
	role,
	sessionId,
	workerRef,
	showNote,
}: UseScreenCaptureOptions): ScreenCapture => {
	const [recording, setRecording] = useState<Recording | null>(null)
	const [recordingBusy, setRecordingBusy] = useState(false)
	const [shooting, setShooting] = useState(false)
	// A recording belongs to the session it started on.
	const active = recording?.sessionId === sessionId ? recording : null

	const endRecording = useCallback(
		(ended: RecordingEnded): void => {
			setRecording(null)
			const { text, options } = describeEnd(ended)
			showNote(text, options)
		},
		[showNote],
	)

	useEffect(() => {
		if (!sessionId) return
		let live = true
		let unlisten: (() => void) | null = null
		onRecordingEnded((ended) => {
			if (ended.sessionId === sessionId) endRecording(ended)
		})
			.then((fn) => {
				if (live) unlisten = fn
				else fn()
			})
			.catch((e: unknown) => {
				void warn(`recording events unavailable: ${String(e)}`)
			})
		return (): void => {
			live = false
			unlisten?.()
		}
	}, [sessionId, endRecording])

	const takeScreenshot = (): void => {
		const worker = workerRef.current
		if (!worker || shooting) return
		setShooting(true)
		const name = captureName('screenshot', role)
		requestScreenshot(worker)
			.then(async ({ png, rgba, width, height }) => {
				const body = new Uint8Array(png.byteLength + rgba.byteLength)
				body.set(new Uint8Array(png), 0)
				body.set(new Uint8Array(rgba), png.byteLength)
				const saved = await saveScreenshot(
					{ serial, name, width, height, pngLength: png.byteLength },
					body,
				)
				showNote(
					saved.copied
						? 'Screenshot saved and copied'
						: `Screenshot saved (not copied: ${saved.copyError ?? 'unknown error'})`,
					{ revealPath: saved.path },
				)
			})
			.catch((e: unknown) => {
				void warn(`screenshot of ${serial} failed: ${String(e)}`)
				showNote(`Screenshot failed: ${String(e)}`, { error: true })
			})
			.finally(() => setShooting(false))
	}

	const toggleRecording = (): void => {
		if (!sessionId || recordingBusy) return
		setRecordingBusy(true)
		const request = active
			? stopRecording(sessionId).then(endRecording)
			: startRecording(sessionId, captureName('recording', role)).then(
					() => setRecording({ sessionId, since: Date.now() }),
				)
		request
			.catch((e: unknown) => {
				void warn(`recording on ${serial} failed: ${String(e)}`)
				showNote(`Recording failed: ${String(e)}`, { error: true })
			})
			.finally(() => setRecordingBusy(false))
	}

	return {
		shooting,
		recordingSince: active?.since ?? null,
		recordingBusy,
		takeScreenshot,
		toggleRecording,
	}
}
