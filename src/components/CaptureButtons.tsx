import { type JSX, useEffect, useState } from 'react'

import { formatElapsed } from '../lib/capture'
import { Icon } from './Icon'

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
	<span className='tool-group'>
		<button
			className='icon-button'
			onClick={onScreenshot}
			disabled={!canCapture || shooting}
			title='Screenshot: saved to Downloads and copied'
			aria-label='Screenshot'
		>
			<Icon name='camera' />
		</button>
		{recordingSince === null ? (
			<button
				className={
					compact ? 'icon-button record-button' : 'record-button'
				}
				onClick={onToggleRecording}
				disabled={!canCapture || recordingBusy}
				title='Record the screen to an MP4'
				aria-label='Record'
			>
				<Icon name='record' />
				{!compact && 'Record'}
			</button>
		) : (
			<button
				className='recording'
				onClick={onToggleRecording}
				disabled={recordingBusy}
				title='Stop recording'
			>
				<Icon name='stop' />
				<RecordingTimer since={recordingSince} />
			</button>
		)}
	</span>
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
