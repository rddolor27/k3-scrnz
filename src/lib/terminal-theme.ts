import type { ITheme } from '@xterm/xterm'

export const TERMINAL_FONT =
	'"Cascadia Mono", "Cascadia Code", Consolas, "Courier New", monospace'

export const TERMINAL_THEME: ITheme = {
	background: '#111317',
	foreground: '#e6e8eb',
	cursor: '#4c8dff',
	cursorAccent: '#111317',
	selectionBackground: 'rgba(76, 141, 255, 0.38)',
	selectionInactiveBackground: 'rgba(144, 151, 161, 0.26)',
	scrollbarSliderBackground: 'rgba(144, 151, 161, 0.28)',
	scrollbarSliderHoverBackground: 'rgba(144, 151, 161, 0.5)',
	scrollbarSliderActiveBackground: 'rgba(144, 151, 161, 0.65)',
	black: '#3a3f47',
	red: '#f85149',
	green: '#3fb950',
	yellow: '#d29922',
	blue: '#4c8dff',
	magenta: '#bc8cff',
	cyan: '#39c5cf',
	white: '#c9d1d9',
	brightBlack: '#7d8590',
	brightRed: '#ff7b72',
	brightGreen: '#56d364',
	brightYellow: '#e3b341',
	brightBlue: '#79a8ff',
	brightMagenta: '#d2a8ff',
	brightCyan: '#56d4dd',
	brightWhite: '#f0f3f6',
}
