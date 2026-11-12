export interface WorkerInit {
	type: 'init'
	canvas: OffscreenCanvas
	port: number
	token: string
	sessionId: string
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
