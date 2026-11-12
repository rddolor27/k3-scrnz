import { connect } from '../lib/ws'
import { layoutGrid, type Rect } from './grid-layout'
import type {
	GridLogLevel,
	GridRecorderAdd,
	GridRecorderEvent,
	GridRecorderInit,
	GridRecorderRequest,
} from './grid-protocol'
import type { TapFrame } from './protocol'

const K_FRAME = 3
const ENVELOPE_BYTES = 12
const END_MESSAGE = '{"t":"end"}'
const CODECS = ['avc1.4D0028', 'avc1.42E028']
const BITRATE = 8_000_000
const FRAMERATE = 30
const TICK_MS = 33
const KEEPALIVE_MS = 1000
const KEY_EVERY_MS = 2000
const MAX_ENCODE_QUEUE = 4
const MAX_BUFFERED_BYTES = 32 * 1024 * 1024
const CLOSE_WAIT_MS = 5000
const GAP = 8
const BACKGROUND = '#000'
const LABEL_FONT = '600 18px "Segoe UI", system-ui, sans-serif'
const LABEL_H = 30
const LABEL_PAD = 8
const LABEL_BACKGROUND = 'rgb(0 0 0 / 70%)'
const LABEL_COLOR = '#fff'

interface Tile {
	label: string
	port: MessagePort
	frame: TapFrame | null
}

interface ReadyTile extends TapFrame {
	label: string
}

interface Pipeline {
	encoder: VideoEncoder
	canvas: OffscreenCanvas
	ctx: OffscreenCanvasRenderingContext2D
}

const tiles = new Map<string, Tile>()
let order: string[] = []
let socket: WebSocket | null = null
let pipeline: Pipeline | null = null
let ticker = 0
let dirty = false
let stopRequested = false
let stopping = false
let finished = false
let origin: number | null = null
let lastEncodeAt = 0
let lastKeyAt = Number.NEGATIVE_INFINITY
let lastTimestamp = -1
let encoded = 0

const post = (event: GridRecorderEvent): void => {
	self.postMessage(event)
}

const log = (level: GridLogLevel, message: string): void => {
	post({ type: 'log', level, message })
}

const errorText = (e: unknown): string =>
	e instanceof Error ? e.message : String(e)

const closeTile = (tile: Tile): void => {
	tile.port.close()
	tile.frame?.bitmap.close()
}

const teardown = (): void => {
	self.clearInterval(ticker)
	if (pipeline && pipeline.encoder.state !== 'closed')
		pipeline.encoder.close()
	pipeline = null
	socket?.close()
	socket = null
	for (const tile of tiles.values()) closeTile(tile)
	tiles.clear()
}

const fail = (message: string): void => {
	if (finished) return
	finished = true
	teardown()
	post({ type: 'error', message })
}

const orderedKeys = (): string[] => [
	...order.filter((key) => tiles.has(key)),
	...[...tiles.keys()].filter((key) => !order.includes(key)),
]

const readyTiles = (): ReadyTile[] => {
	const ready: ReadyTile[] = []
	for (const key of orderedKeys()) {
		const tile = tiles.get(key)
		if (tile?.frame) ready.push({ label: tile.label, ...tile.frame })
	}
	return ready
}

const drawLabel = (
	ctx: OffscreenCanvasRenderingContext2D,
	label: string,
	rect: Rect,
): void => {
	ctx.font = LABEL_FONT
	const textW = Math.max(
		0,
		Math.min(ctx.measureText(label).width, rect.w - 2 * LABEL_PAD),
	)
	ctx.fillStyle = LABEL_BACKGROUND
	ctx.fillRect(rect.x, rect.y, textW + 2 * LABEL_PAD, LABEL_H)
	ctx.fillStyle = LABEL_COLOR
	ctx.textBaseline = 'middle'
	ctx.fillText(label, rect.x + LABEL_PAD, rect.y + LABEL_H / 2, textW)
}

const drawTiles = ({ canvas, ctx }: Pipeline): void => {
	ctx.fillStyle = BACKGROUND
	ctx.fillRect(0, 0, canvas.width, canvas.height)
	const placed = layoutGrid(readyTiles(), canvas.width, canvas.height, GAP)
	for (const { item, rect } of placed) {
		ctx.drawImage(item.bitmap, rect.x, rect.y, rect.w, rect.h)
		drawLabel(ctx, item.label, rect)
	}
}

const encodeFrame = (p: Pipeline, now: number): void => {
	drawTiles(p)
	if (origin === null) origin = now
	const timestamp = Math.max(
		lastTimestamp + 1,
		Math.round((now - origin) * 1000),
	)
	const keyFrame = now - lastKeyAt >= KEY_EVERY_MS
	const frame = new VideoFrame(p.canvas, { timestamp })
	try {
		p.encoder.encode(frame, { keyFrame })
	} finally {
		frame.close()
	}
	lastTimestamp = timestamp
	lastEncodeAt = now
	if (keyFrame) lastKeyAt = now
	dirty = false
	encoded += 1
}

const tick = (): void => {
	if (!pipeline || stopping || finished) return
	const now = performance.now()
	if (!dirty && now - lastEncodeAt < KEEPALIVE_MS) return
	if (pipeline.encoder.encodeQueueSize > MAX_ENCODE_QUEUE) return
	try {
		encodeFrame(pipeline, now)
	} catch (e) {
		fail(`Encoding a frame failed: ${errorText(e)}`)
	}
}

const sendChunk = (chunk: EncodedVideoChunk): void => {
	if (!socket || finished) return
	try {
		const message = new Uint8Array(ENVELOPE_BYTES + chunk.byteLength)
		const view = new DataView(message.buffer)
		view.setUint8(0, K_FRAME)
		view.setUint8(1, chunk.type === 'key' ? 1 : 0)
		view.setBigUint64(4, BigInt(chunk.timestamp))
		chunk.copyTo(message.subarray(ENVELOPE_BYTES))
		socket.send(message)
		if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
			fail('The recording connection cannot keep up with the encoder.')
		}
	} catch (e) {
		fail(`Sending a chunk failed: ${errorText(e)}`)
	}
}

const pickEncoderConfig = async (
	width: number,
	height: number,
): Promise<VideoEncoderConfig> => {
	for (const codec of CODECS) {
		const config: VideoEncoderConfig = {
			codec,
			width,
			height,
			bitrate: BITRATE,
			framerate: FRAMERATE,
			avc: { format: 'annexb' },
		}
		const { supported } = await VideoEncoder.isConfigSupported(config)
		if (supported) return config
	}
	throw new Error(
		`This system cannot encode H.264 at ${width}x${height} (tried ${CODECS.join(', ')}).`,
	)
}

const openSocket = (init: GridRecorderInit): Promise<WebSocket> =>
	new Promise((resolve, reject) => {
		const ws = connect(
			{ port: init.port, token: init.token },
			'record',
			init.recordingId,
		)
		socket = ws
		ws.addEventListener('open', () => resolve(ws), { once: true })
		ws.addEventListener(
			'error',
			() => reject(new Error('The recording connection failed.')),
			{ once: true },
		)
	})

const closeSocket = (ws: WebSocket): Promise<void> =>
	new Promise((resolve) => {
		if (ws.readyState === WebSocket.CLOSED) {
			resolve()
			return
		}
		const timer = self.setTimeout(resolve, CLOSE_WAIT_MS)
		ws.addEventListener(
			'close',
			() => {
				self.clearTimeout(timer)
				resolve()
			},
			{ once: true },
		)
		ws.close()
	})

const finish = async (): Promise<void> => {
	if (!pipeline || !socket || stopping || finished) return
	stopping = true
	self.clearInterval(ticker)
	try {
		// A last frame at the stop time keeps a still screen's tail in the file.
		encodeFrame(pipeline, performance.now())
		await pipeline.encoder.flush()
		if (finished) return
		socket.send(END_MESSAGE)
		await closeSocket(socket)
		if (finished) return
		log('info', `stopped after ${encoded} frames`)
		finished = true
		teardown()
		post({ type: 'stopped' })
	} catch (e) {
		fail(`Finishing the recording failed: ${errorText(e)}`)
	}
}

const start = async (init: GridRecorderInit): Promise<void> => {
	try {
		const config = await pickEncoderConfig(init.width, init.height)
		const ws = await openSocket(init)
		const canvas = new OffscreenCanvas(init.width, init.height)
		const ctx = canvas.getContext('2d', { alpha: false })
		if (!ctx) throw new Error('No 2D context for the compositor.')
		const encoder = new VideoEncoder({
			output: sendChunk,
			error: (e: DOMException): void => {
				fail(`The H.264 encoder failed: ${e.name}: ${e.message}`)
			},
		})
		pipeline = { encoder, canvas, ctx }
		encoder.configure(config)
		ws.addEventListener('close', () => {
			if (!stopping) fail('The recording connection closed.')
		})
		ws.addEventListener('error', () => {
			if (!stopping) fail('The recording connection failed.')
		})
		lastEncodeAt = performance.now()
		ticker = self.setInterval(tick, TICK_MS)
		log('info', `encoding ${config.codec} ${init.width}x${init.height}`)
		post({ type: 'started' })
		if (stopRequested) void finish()
	} catch (e) {
		fail(errorText(e))
	}
}

const addTile = ({ key, label, port }: GridRecorderAdd): void => {
	if (stopping || finished) {
		port.close()
		return
	}
	const previous = tiles.get(key)
	if (previous) closeTile(previous)
	const tile: Tile = { label, port, frame: null }
	port.onmessage = (e: MessageEvent<TapFrame>): void => {
		tile.frame?.bitmap.close()
		tile.frame = e.data
		dirty = true
	}
	tiles.set(key, tile)
	dirty = true
	log('debug', `tile added: ${key}`)
}

const removeTile = (key: string): void => {
	const tile = tiles.get(key)
	if (!tile) return
	closeTile(tile)
	tiles.delete(key)
	dirty = true
	log('debug', `tile removed: ${key}`)
}

self.onmessage = (e: MessageEvent<GridRecorderRequest>): void => {
	const request = e.data
	if (request.type === 'init') {
		void start(request)
	} else if (request.type === 'add') {
		addTile(request)
	} else if (request.type === 'remove') {
		removeTile(request.key)
	} else if (request.type === 'order') {
		order = request.keys
		dirty = true
	} else {
		stopRequested = true
		void finish()
	}
}
