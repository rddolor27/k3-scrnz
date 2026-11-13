import { connect } from '../lib/ws'
import { avcCodecString } from './codec-string'
import type { TapFrame, WorkerEvent, WorkerRequest } from './protocol'

const K_SESSION = 1
const K_CONFIG = 2
const K_FRAME = 3
const MAX_QUEUE = 10
const FRAME_NOTICE_MS = 500
// RESET_VIDEO restarts the encoder, so don't request key frames more often.
const NEED_KEY_EVERY_MS = 1000
const MAX_ERRORS = 5
// An SPS without VUI `bitstream_restriction` makes Chromium's hardware decoder
// reorder across the whole DPB (lag); sustained lag above this goes software.
const MAX_LAG = 2
const TAP_EVERY_MS = 33

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
let drawn = false
let tapPort: MessagePort | null = null
let tapTimer = 0
let tapSentAt = 0
let tapPending = false
let visible = true
let keyRetry = 0

const post = (event: WorkerEvent, transfer: Transferable[] = []): void => {
	self.postMessage(event, { transfer })
}

const stopTap = (): void => {
	self.clearTimeout(tapTimer)
	tapTimer = 0
	tapPending = false
	tapPort?.close()
	tapPort = null
}

const sendTap = (): void => {
	tapTimer = 0
	const port = tapPort
	if (!port || !canvas || !tapPending) return
	tapPending = false
	tapSentAt = performance.now()
	// Bitmaps, not VideoFrames: the hardware decoder's buffers are finite.
	createImageBitmap(canvas)
		.then((bitmap) => {
			if (tapPort !== port) {
				bitmap.close()
				return
			}
			const frame: TapFrame = {
				bitmap,
				width: bitmap.width,
				height: bitmap.height,
			}
			port.postMessage(frame, [bitmap])
		})
		.catch((e: unknown) => {
			if (tapPort === port) stopTap()
			post({ type: 'notice', message: `frame tap failed: ${String(e)}` })
		})
}

// Throttled, with a trailing send so the last frame before a still screen goes out.
const queueTap = (): void => {
	if (!tapPort) return
	tapPending = true
	if (tapTimer) return
	const wait = Math.max(0, TAP_EVERY_MS - (performance.now() - tapSentAt))
	tapTimer = self.setTimeout(sendTap, wait)
}

const startTap = (port: MessagePort): void => {
	stopTap()
	tapPort = port
	if (!drawn) return
	tapPending = true
	sendTap()
}

const requestKey = (): void => {
	needKey = true
	prependNext = true
	const wait = NEED_KEY_EVERY_MS - (performance.now() - lastNeedKey)
	if (wait > 0) {
		// A still screen sends no frame that could trigger the request later.
		keyRetry ||= self.setTimeout(() => {
			keyRetry = 0
			if (needKey && visible) requestKey()
		}, wait)
		return
	}
	lastNeedKey = performance.now()
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
			drawn = true
			queueTap()
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
			decoder.reset()
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
	// Hidden: skip decoding; showing again asks for a key frame.
	if (!visible) {
		needKey = true
		prependNext = true
		return
	}
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

const takeScreenshot = async (id: number): Promise<void> => {
	try {
		if (!canvas || !ctx || !drawn) throw new Error('No frame drawn yet.')
		const { width, height } = canvas
		// Read synchronously: no frame can land between the PNG and the RGBA.
		const image = ctx.getImageData(0, 0, width, height)
		const copy = new OffscreenCanvas(width, height)
		const copyCtx = copy.getContext('2d')
		if (!copyCtx) throw new Error('No 2D context for the screenshot.')
		copyCtx.putImageData(image, 0, 0)
		const blob = await copy.convertToBlob({ type: 'image/png' })
		const png = await blob.arrayBuffer()
		const rgba = image.data.buffer
		post({ type: 'screenshot', id, png, rgba, width, height }, [png, rgba])
	} catch (e) {
		post({ type: 'screenshot', id, error: String(e) })
	}
}

self.onmessage = (e: MessageEvent<WorkerRequest>): void => {
	const request = e.data
	if (request.type === 'screenshot') {
		void takeScreenshot(request.id)
		return
	}
	if (request.type === 'tap') {
		startTap(request.port)
		return
	}
	if (request.type === 'untap') {
		stopTap()
		return
	}
	if (request.type === 'visibility') {
		visible = request.visible
		if (visible && needKey && config) requestKey()
		return
	}
	canvas = request.canvas
	ctx = canvas.getContext('2d', { alpha: false, desynchronized: true })
	const ws = connect(
		{ port: request.port, token: request.token },
		'video',
		request.sessionId,
	)
	ws.addEventListener('message', (ev: MessageEvent<unknown>) => {
		if (ev.data instanceof ArrayBuffer) onEnvelope(ev.data)
	})
	ws.addEventListener('close', () => post({ type: 'closed' }))
}
