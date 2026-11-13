import type { JSX } from 'react'

import type { ShellInfo } from '../lib/terminal'

interface ShellPickerProps {
	shells: ShellInfo[]
	value: string
	onChange: (id: string) => void
}

export const ShellPicker = ({
	shells,
	value,
	onChange,
}: ShellPickerProps): JSX.Element => (
	<select
		className='terminal-shell'
		value={value}
		aria-label='Shell for new project terminals'
		title='Shell for new project terminals'
		onChange={(e) => onChange(e.target.value)}
	>
		{shells.map((s) => (
			<option key={s.id} value={s.id}>
				{s.label}
			</option>
		))}
	</select>
)
