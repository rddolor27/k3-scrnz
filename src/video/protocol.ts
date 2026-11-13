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

export interface WorkerTapRequest {
	type: 'tap'
	// Receives a TapFrame after drawn frames, at most every 33 ms.
	port: MessagePort
}

export interface WorkerUntapRequest {
	type: 'untap'
}

export interface WorkerVisibilityRequest {
	type: 'visibility'
	visible: boolean
}

export type WorkerRequest =
	| WorkerInit
	| WorkerScreenshotRequest
	| WorkerTapRequest
	| WorkerUntapRequest
	| WorkerVisibilityRequest

export interface TapFrame {
	bitmap: ImageBitmap
	width: number
	height: number
}

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
