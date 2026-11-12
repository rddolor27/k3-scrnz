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
/** Key-frame requests at most this often (RESET_VIDEO restarts the encoder). */
const NEED_KEY_EVERY_MS = 1000
/** Consecutive decoder errors before giving up with a visible error. */
const MAX_ERRORS = 5
/**
 * Lag above this in two stats samples in a row means the decoder holds frames
 * back: an SPS without VUI `bitstream_restriction` makes Chromium's hardware
 * decoder use the whole DPB as a reorder window (spec section 8.2).
 */
const MAX_LAG = 2

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
let lastNeedKey = 0
let errors = 0
let failed = false
let highLag = 0
let lagReported = false

const post = (event: WorkerEvent): void => {
	self.postMessage(event)
}

const requestKey = (): void => {
	needKey = true
	prependNext = true
	const now = performance.now()
	if (now - lastNeedKey < NEED_KEY_EVERY_MS) return
	lastNeedKey = now
	post({ type: 'need-key' })
}

const onFrame = (frame: VideoFrame): void => {
	framesOut += 1
	errors = 0
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
		const lag = chunksIn - framesOut
		post({
			type: 'stats',
			lag,
			queue: decoder?.decodeQueueSize ?? 0,
			software: preferSoftware,
		})
		highLag = lag > MAX_LAG ? highLag + 1 : 0
		if (highLag >= 2) {
			highLag = 0
			// Not from inside the decoder's own output callback.
			if (!preferSoftware) setTimeout(() => switchToSoftware(lag), 0)
			else if (!lagReported) {
				lagReported = true
				post({
					type: 'notice',
					message: `lag stays at ${lag} with software decoding`,
				})
			}
		}
	}
}

/** Spec section 8.2: a decoder that holds frames back gets `prefer-software`. */
const switchToSoftware = (lag: number): void => {
	if (preferSoftware || failed) return
	preferSoftware = true
	const old = decoder
	decoder = null
	if (old && old.state !== 'closed') old.close()
	post({
		type: 'notice',
		message: `lag stayed at ${lag}; switching to software decoding`,
	})
	requestKey()
}

const onDecoderError = (which: VideoDecoder, message: string): void => {
	// A late error from a decoder that was already replaced changes nothing.
	if (which !== decoder) return
	decoder = null
	errors += 1
	post({ type: 'decoder-error', message })
	if (errors >= MAX_ERRORS) {
		failed = true
		post({
			type: 'failed',
			message: `The video decoder keeps failing (${message})`,
		})
		return
	}
	// Retry in software after a hardware failure, from a fresh key frame.
	preferSoftware = true
	requestKey()
}

const configure = (): void => {
	if (!codec || failed) return
	try {
		if (!decoder || decoder.state === 'closed') {
			const created: VideoDecoder = new VideoDecoder({
				output: onFrame,
				error: (e: DOMException) =>
					onDecoderError(created, `${e.name}: ${e.message}`),
			})
			decoder = created
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
	} catch (e) {
		if (decoder) onDecoderError(decoder, String(e))
		return
	}
	// Chunks in flight at reset() never come out; restart the lag count.
	chunksIn = 0
	framesOut = 0
	highLag = 0
	needKey = true
	prependNext = true
}

const decode = (data: Uint8Array, key: boolean): void => {
	if (failed) return
	if (!decoder || decoder.state !== 'configured') {
		configure()
		if (!decoder || decoder.state !== 'configured') return
	}
	if (needKey && !key) return
	if (decoder.decodeQueueSize > MAX_QUEUE) {
		requestKey()
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
	try {
		decoder.decode(
			new EncodedVideoChunk({
				type: key ? 'key' : 'delta',
				// The device PTS isn't needed for live display.
				timestamp: Math.round(performance.now() * 1000),
				data: chunk,
			}),
		)
	} catch (e) {
		onDecoderError(decoder, String(e))
		return
	}
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
