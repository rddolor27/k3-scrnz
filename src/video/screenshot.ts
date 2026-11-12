import type { ScreenshotFrame, WorkerEvent, WorkerRequest } from './protocol'

const TIMEOUT_MS = 10_000

let lastId = 0

export const requestScreenshot = (worker: Worker): Promise<ScreenshotFrame> =>
	new Promise((resolve, reject) => {
		lastId += 1
		const id = lastId
		const settle = (): void => {
			window.clearTimeout(timer)
			worker.removeEventListener('message', onMessage)
		}
		const onMessage = (e: MessageEvent<WorkerEvent>): void => {
			const event = e.data
			if (event.type !== 'screenshot' || event.id !== id) return
			settle()
			if ('error' in event) reject(new Error(event.error))
			else resolve(event)
		}
		const timer = window.setTimeout(() => {
			settle()
			reject(new Error('The video worker did not answer.'))
		}, TIMEOUT_MS)
		worker.addEventListener('message', onMessage)
		const request: WorkerRequest = { type: 'screenshot', id }
		worker.postMessage(request)
	})
