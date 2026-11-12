import { useCallback, useEffect, useRef, useState } from 'react'

export interface Note {
	text: string
	revealPath: string | null
	error: boolean
}

export interface NoteOptions {
	revealPath?: string
	error?: boolean
	// Stays until the next note replaces it.
	busy?: boolean
}

export type ShowNote = (text: string, options?: NoteOptions) => void

const NOTE_MS = 3000
const LONG_NOTE_MS = 8000

export const useNote = (): { note: Note | null; showNote: ShowNote } => {
	const [note, setNote] = useState<Note | null>(null)
	const timer = useRef(0)

	useEffect(() => {
		return (): void => window.clearTimeout(timer.current)
	}, [])

	const showNote = useCallback<ShowNote>((text, options = {}) => {
		window.clearTimeout(timer.current)
		const { revealPath = null, error = false, busy = false } = options
		setNote({ text, revealPath, error })
		if (busy) return
		timer.current = window.setTimeout(
			() => setNote(null),
			revealPath !== null || error ? LONG_NOTE_MS : NOTE_MS,
		)
	}, [])

	return { note, showNote }
}
