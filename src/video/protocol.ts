export interface WorkerInit {
	type: 'init'
	canvas: OffscreenCanvas
	port: number
	token: string
	sessionId: string
}

export interface WorkerScreenshotRequest {
	type: 'screenshot'
	id: number
}

export type WorkerRequest = WorkerInit | WorkerScreenshotRequest

export interface ScreenshotFrame {
	png: ArrayBuffer
	// width * height * 4 bytes, the same frame as the PNG.
	rgba: ArrayBuffer
	width: number
	height: number
}

export type WorkerEvent =
	// Latest session packet size: the server drops touches with another w,h.
	| { type: 'size'; width: number; height: number }
	| { type: 'need-key' }
	| { type: 'stats'; lag: number; queue: number; software: boolean }
	| { type: 'notice'; message: string }
	| { type: 'frame' }
	| { type: 'closed' }
	| { type: 'decoder-error'; message: string }
	| { type: 'failed'; message: string }
	| ({ type: 'screenshot'; id: number } & ScreenshotFrame)
	| { type: 'screenshot'; id: number; error: string }
