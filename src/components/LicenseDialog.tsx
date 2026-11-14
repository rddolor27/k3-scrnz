import { type JSX, useEffect, useId, useRef } from 'react'

import type { License } from '../lib/ipc'

interface LicenseDialogProps {
	title: string
	license: License
	onAccept: () => void
	onCancel: () => void
}

export const LicenseDialog = ({
	title,
	license,
	onAccept,
	onCancel,
}: LicenseDialogProps): JSX.Element => {
	const textRef = useRef<HTMLPreElement>(null)
	const headingId = useId()

	useEffect(() => {
		textRef.current?.focus()
	}, [])

	return (
		<section
			className='license'
			aria-labelledby={headingId}
			onKeyDown={(e) => {
				if (e.key !== 'Escape') return
				e.preventDefault()
				onCancel()
			}}
		>
			<h3 id={headingId}>License agreement</h3>
			<p className='muted'>
				Read and accept the license to download {title}.
			</p>
			<pre
				className='license-text'
				ref={textRef}
				tabIndex={0}
				aria-label='License text'
			>
				{license.text}
			</pre>
			<div className='avd-form-actions'>
				<button type='button' onClick={onCancel}>
					Cancel
				</button>
				<button type='button' className='primary' onClick={onAccept}>
					Accept and download
				</button>
			</div>
		</section>
	)
}
