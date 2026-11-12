/**
 * Video worker, one per mirror session (spec section 8.2): owns the WebSocket,
 * the WebCodecs `VideoDecoder` and the `OffscreenCanvas`, so video never
 * touches the main thread.
 */
import { connect } from '../lib/ws'
import { avcCodecString } from './codec-string'
import type { WorkerEvent, WorkerInit } from './protocol'

const K_SESSION = 1
const K_CONFIG = 2
const K_FRAME = 3
const MAX_QUEUE = 10
const FRAME_NOTICE_MS = 500

let canvas: OffscreenCanvas | null = null
let ctx: OffscreenCanvasRenderingContext2D | null = null
let decoder: VideoDecoder | null = null
let config: Uint8Array | null = null
let codec: string | null = null
let preferSoftware = false
let needKey = true
let prependNext = true
let chunksIn = 0
let framesOut = 0
let lastFrameNotice = 0

const post = (event: WorkerEvent): void => {
	self.postMessage(event)
}

const onFrame = (frame: VideoFrame): void => {
	framesOut += 1
	try {
		if (canvas && ctx) {
			if (
				canvas.width !== frame.displayWidth ||
				canvas.height !== frame.displayHeight
			) {
				canvas.width = frame.displayWidth
				canvas.height = frame.displayHeight
			}
			ctx.drawImage(frame, 0, 0)
		}
	} finally {
		frame.close() // always: hardware output buffers are finite
	}
	const now = performance.now()
	if (now - lastFrameNotice > FRAME_NOTICE_MS) {
		lastFrameNotice = now
		post({ type: 'frame' })
	}
	if ((framesOut & 63) === 0) {
		post({
			type: 'stats',
			lag: chunksIn - framesOut,
			queue: decoder?.decodeQueueSize ?? 0,
		})
	}
}

const onDecoderError = (e: DOMException): void => {
	post({ type: 'decoder-error', message: `${e.name}: ${e.message}` })
	// Retry in software once if hardware decoding fails, then ask for a key frame.
	preferSoftware = true
	decoder = null
	needKey = true
	prependNext = true
	post({ type: 'need-key' })
}

const configure = (): void => {
	if (!codec) return
	if (!decoder || decoder.state === 'closed') {
		decoder = new VideoDecoder({ output: onFrame, error: onDecoderError })
	} else if (decoder.state === 'configured') {
		decoder.reset() // drop frames of the old size/orientation
	}
	// No `description`: the stream is Annex B.
	decoder.configure({
		codec,
		optimizeForLatency: true,
		hardwareAcceleration: preferSoftware
			? 'prefer-software'
			: 'no-preference',
	})
	needKey = true
	prependNext = true
}

const decode = (data: Uint8Array, key: boolean): void => {
	if (!decoder || decoder.state !== 'configured') {
		configure()
		if (!decoder || decoder.state !== 'configured') return
	}
	if (needKey && !key) return
	if (decoder.decodeQueueSize > MAX_QUEUE) {
		needKey = true
		prependNext = true
		post({ type: 'need-key' })
		return
	}
	let chunk = data
	if (key && prependNext && config) {
		// SPS/PPS and the IDR frame go into one "key" chunk.
		chunk = new Uint8Array(config.length + data.length)
		chunk.set(config, 0)
		chunk.set(data, config.length)
		prependNext = false
	}
	decoder.decode(
		new EncodedVideoChunk({
			type: key ? 'key' : 'delta',
			// The device PTS isn't needed for live display.
			timestamp: Math.round(performance.now() * 1000),
			data: chunk,
		}),
	)
	if (key) needKey = false
	chunksIn += 1
}

const onEnvelope = (buf: ArrayBuffer): void => {
	if (buf.byteLength < 12) return
	const view = new DataView(buf)
	const kind = view.getUint8(0)
	const payload = new Uint8Array(buf, 12)
	if (kind === K_SESSION) {
		post({
			type: 'size',
			width: view.getUint32(4),
			height: view.getUint32(8),
		})
	} else if (kind === K_CONFIG) {
		config = payload.slice()
		codec = avcCodecString(config)
		configure()
	} else if (kind === K_FRAME) {
		decode(payload, (view.getUint8(1) & 1) === 1)
	}
}

self.onmessage = (e: MessageEvent<WorkerInit>): void => {
	const init = e.data
	if (init.type !== 'init') return
	canvas = init.canvas
	ctx = canvas.getContext('2d', { alpha: false, desynchronized: true })
	const ws = connect(
		{ port: init.port, token: init.token },
		'video',
		init.sessionId,
	)
	ws.addEventListener('message', (ev: MessageEvent<unknown>) => {
		if (ev.data instanceof ArrayBuffer) onEnvelope(ev.data)
	})
	ws.addEventListener('close', () => post({ type: 'closed' }))
}
