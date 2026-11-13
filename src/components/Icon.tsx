import type { JSX } from 'react'

const FOLDER_OUTLINE =
	'M2.5 4.5a1 1 0 0 1 1-1h2.8l1.4 1.5h4.8a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z'
const TRAY = 'M3 10.5V12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-1.5'

const GLYPHS = {
	back: <path d='M11 3.5v9L4.5 8z' />,
	home: <circle cx='8' cy='8' r='4.5' />,
	recents: <rect x='3.5' y='3.5' width='9' height='9' rx='2' />,
	power: (
		<>
			<path d='M8 2.5V8' />
			<path d='M4.46 5.46A5 5 0 1 0 11.54 5.46' />
		</>
	),
	volumeDown: (
		<>
			<path d='M2.5 6.2h2.2L7.5 4v8L4.7 9.8H2.5z' />
			<path d='M10 6.2a2.6 2.6 0 0 1 0 3.6' />
		</>
	),
	volumeUp: (
		<>
			<path d='M2.5 6.2h2.2L7.5 4v8L4.7 9.8H2.5z' />
			<path d='M10 6.2a2.6 2.6 0 0 1 0 3.6' />
			<path d='M11.8 4.4a5.2 5.2 0 0 1 0 7.2' />
		</>
	),
	refresh: (
		<>
			<path d='M13.5 8A5.5 5.5 0 1 1 11.89 4.11' />
			<path d='M13.5 2.2v2.6h-2.6' />
		</>
	),
	rotate: (
		<>
			<rect x='2.5' y='6.5' width='5.5' height='7' rx='1.2' />
			<path d='M7 3a6 6 0 0 1 6 6' />
			<path d='M11.5 7.6 13 9.1l1.5-1.5' />
		</>
	),
	camera: (
		<>
			<path d='M2.5 5.5a1 1 0 0 1 1-1h1.8l1-1.5h3.4l1 1.5h1.8a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z' />
			<circle cx='8' cy='8.5' r='2.2' />
		</>
	),
	record: <circle cx='8' cy='8' r='4' fill='currentColor' stroke='none' />,
	stop: (
		<rect
			x='4.5'
			y='4.5'
			width='7'
			height='7'
			rx='1.5'
			fill='currentColor'
			stroke='none'
		/>
	),
	chevronDown: <path d='M4.5 6.5 8 10l3.5-3.5' />,
	chevronRight: <path d='M6.5 4.5 10 8l-3.5 3.5' />,
	chevronLeft: <path d='M9.5 4.5 6 8l3.5 3.5' />,
	collapse: <path d='M3.5 8h9M5.5 2.5 8 5l2.5-2.5M5.5 13.5 8 11l2.5 2.5' />,
	close: <path d='M4.5 4.5l7 7M11.5 4.5l-7 7' />,
	plus: <path d='M8 3.5v9M3.5 8h9' />,
	devices: (
		<>
			<rect x='2.5' y='2.5' width='11' height='4.2' rx='1' />
			<rect x='2.5' y='8.6' width='4.9' height='4.9' rx='1' />
			<rect x='8.6' y='8.6' width='4.9' height='4.9' rx='1' />
		</>
	),
	phone: (
		<>
			<rect x='4.5' y='2' width='7' height='12' rx='1.6' />
			<path d='M7 11.6h2' />
		</>
	),
	folder: <path d={FOLDER_OUTLINE} />,
	folderOpen: (
		<>
			<path d='M2.5 11.5V4.5a1 1 0 0 1 1-1h2.8l1.4 1.5h4.3a1 1 0 0 1 1 1v.8' />
			<path d='M2.5 11.5 4 7.6a1 1 0 0 1 .94-.65h8.3a.6.6 0 0 1 .56.81l-1.5 3.9a1 1 0 0 1-.94.64H3.5a1 1 0 0 1-1-1z' />
		</>
	),
	folderPlus: (
		<>
			<path d={FOLDER_OUTLINE} />
			<path d='M8 7v3.5M6.25 8.75h3.5' />
		</>
	),
	file: (
		<>
			<path d='M4 2.5h5l3 3v8H4z' />
			<path d='M9 2.5v3h3' />
		</>
	),
	link: (
		<>
			<path d='M7 9a2.5 2.5 0 0 0 3.5 0l2-2A2.5 2.5 0 0 0 9 3.5l-.6.6' />
			<path d='M9 7a2.5 2.5 0 0 0-3.5 0l-2 2A2.5 2.5 0 0 0 7 12.5l.6-.6' />
		</>
	),
	special: (
		<>
			<rect x='3' y='3' width='10' height='10' rx='2.5' />
			<circle cx='8' cy='8' r='1.6' />
		</>
	),
	upload: (
		<>
			<path d='M8 10.5V2.8M5 5.5l3-3 3 3' />
			<path d={TRAY} />
		</>
	),
	download: (
		<>
			<path d='M8 2.5v7.7M5 7.5l3 3 3-3' />
			<path d={TRAY} />
		</>
	),
	trash: (
		<path d='M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8' />
	),
	copy: (
		<>
			<rect x='5.5' y='5.5' width='7.5' height='7.5' rx='1.2' />
			<path d='M10.5 5.5V4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v5.5a1 1 0 0 0 1 1h1.5' />
		</>
	),
	terminal: (
		<>
			<rect x='2' y='3' width='12' height='10' rx='1.6' />
			<path d='M4.8 6.3 6.8 8l-2 1.7M8.5 10h2.7' />
		</>
	),
	play: <path d='M5 3.5v9l7-4.5z' />,
	grip: <path d='M6 4h.01M10 4h.01M6 8h.01M10 8h.01M6 12h.01M10 12h.01' />,
} satisfies Record<string, JSX.Element>

export type IconName = keyof typeof GLYPHS

interface IconProps {
	name: IconName
	size?: number
}

export const Icon = ({ name, size = 16 }: IconProps): JSX.Element => (
	<svg
		className='icon'
		width={size}
		height={size}
		viewBox='0 0 16 16'
		fill='none'
		stroke='currentColor'
		strokeWidth={1.5}
		strokeLinecap='round'
		strokeLinejoin='round'
		aria-hidden='true'
		focusable='false'
	>
		{GLYPHS[name]}
	</svg>
)
