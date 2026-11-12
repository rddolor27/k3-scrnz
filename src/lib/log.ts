import { error } from '@tauri-apps/plugin-log'

export { debug, error, info, trace, warn } from '@tauri-apps/plugin-log'

export const logUncaughtErrors = (): void => {
	window.addEventListener('error', (ev) => {
		void error(`uncaught: ${ev.message} (${ev.filename}:${ev.lineno})`)
	})
	window.addEventListener('unhandledrejection', (ev) => {
		void error(`unhandled rejection: ${String(ev.reason)}`)
	})
}
