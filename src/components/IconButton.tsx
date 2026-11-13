import type { JSX } from 'react'

import { Icon, type IconName } from './Icon'

interface IconButtonProps {
	icon: IconName
	label: string
	hint?: string
	disabled?: boolean
	onClick: () => void
}

export const IconButton = ({
	icon,
	label,
	hint,
	disabled,
	onClick,
}: IconButtonProps): JSX.Element => (
	<button
		className='icon-button'
		onClick={onClick}
		disabled={disabled}
		title={hint ?? label}
		aria-label={label}
	>
		<Icon name={icon} />
	</button>
)
