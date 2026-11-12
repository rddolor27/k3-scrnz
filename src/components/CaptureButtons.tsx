import { type JSX, useEffect, useState } from 'react'

import { formatElapsed } from '../lib/capture'

interface CaptureButtonsProps {
	compact: boolean
	canCapture: boolean
	shooting: boolean
	recordingSince: number | null
	recordingBusy: boolean
	onScreenshot: () => void
	onToggleRecording: () => void
}

export const CaptureButtons = ({
	compact,
	canCapture,
	shooting,
	recordingSince,
	recordingBusy,
	onScreenshot,
	onToggleRecording,
}: CaptureButtonsProps): JSX.Element => (
	<>
		<button
			onClick={onScreenshot}
			disabled={!canCapture || shooting}
			title='Screenshot: saved to Downloads and copied'
		>
			📷
		</button>
		{recordingSince === null ? (
			<button
				onClick={onToggleRecording}
				disabled={!canCapture || recordingBusy}
				title='Record the screen to an MP4'
			>
				{compact ? '⏺' : '⏺ Record'}
			</button>
		) : (
			<button
				className='recording'
				onClick={onToggleRecording}
				disabled={recordingBusy}
				title='Stop recording'
			>
				⏹ <RecordingTimer since={recordingSince} />
			</button>
		)}
	</>
)

interface RecordingTimerProps {
	since: number
}

export const RecordingTimer = ({ since }: RecordingTimerProps): JSX.Element => {
	const [now, setNow] = useState(since)

	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), 1000)
		return (): void => window.clearInterval(timer)
	}, [])

	return <span>{formatElapsed(now - since)}</span>
}
