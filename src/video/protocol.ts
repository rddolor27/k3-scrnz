/** Messages between ScreenView (main thread) and the video worker. */

export interface WorkerInit {
	type: 'init'
	canvas: OffscreenCanvas
	port: number
	token: string
	sessionId: string
}

export type WorkerEvent =
	/** Session size from the latest session packet; input must use it. */
	| { type: 'size'; width: number; height: number }
	/** The decoder needs a fresh config + key frame: send RESET_VIDEO. */
	| { type: 'need-key' }
	/** Every 64 frames; `lag` should stay at 0–1 (spec section 8.2). */
	| { type: 'stats'; lag: number; queue: number }
	/** A frame was drawn (throttled to twice a second). */
	| { type: 'frame' }
	| { type: 'closed' }
	| { type: 'decoder-error'; message: string }
