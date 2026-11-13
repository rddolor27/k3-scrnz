import type { JSX } from 'react'

import { revealFile } from '../lib/ipc'
import { error } from '../lib/log'
import { useGridRecording } from '../state/grid-recording'
import { useNote } from '../state/note'
import { RecordingTimer } from './CaptureButtons'
import { Icon } from './Icon'

interface GridRecordBarProps {
	serials: string[]
}

export const GridRecordBar = ({ serials }: GridRecordBarProps): JSX.Element => {
	const { note, showNote } = useNote()
	const recording = useGridRecording({ serials, showNote })
	const revealPath = note?.revealPath ?? null

	const reveal = (path: string): void => {
		revealFile(path).catch((e: unknown) => {
			void error(`reveal failed: ${String(e)}`)
		})
	}

	return (
		<div className='screen-toolbar grid-bar'>
			{recording.since === null ? (
				<button
					className='record-button'
					onClick={recording.toggle}
					disabled={recording.busy}
					title='Record all tiles as one MP4'
				>
					<Icon name='record' />
					Record grid
				</button>
			) : (
				<button
					className='recording'
					onClick={recording.toggle}
					disabled={recording.busy}
					title='Stop recording'
				>
					<Icon name='stop' />
					<RecordingTimer since={recording.since} />
				</button>
			)}
			{note && (
				<span className={note.error ? 'grid-note err' : 'grid-note'}>
					<span>{note.text}</span>
					{revealPath !== null && (
						<button
							className='link'
							onClick={() => reveal(revealPath)}
						>
							Show in folder
						</button>
					)}
				</span>
			)}
		</div>
	)
}
