import { error } from '@tauri-apps/plugin-log'

// App logger: writes through tauri-plugin-log into the same stdout + log file
// as the Rust side. Use these instead of console.*.
export { debug, error, info, trace, warn } from '@tauri-apps/plugin-log'

/** Sends uncaught errors and unhandled promise rejections to the app log. */
export const logUncaughtErrors = (): void => {
	window.addEventListener('error', (ev) => {
		void error(`uncaught: ${ev.message} (${ev.filename}:${ev.lineno})`)
	})
	window.addEventListener('unhandledrejection', (ev) => {
		void error(`unhandled rejection: ${String(ev.reason)}`)
	})
}
