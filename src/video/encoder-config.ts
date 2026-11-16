const LEVEL_4_CODECS = ['avc1.4D0028', 'avc1.42E028']
const LEVEL_5_1_CODECS = ['avc1.4D0033', 'avc1.42E033']
const LEVEL_4_MAX_MACROBLOCKS = 8192
const BASE_BITRATE = 8_000_000
const MAX_BITRATE = 20_000_000
const BASE_AREA = 1920 * 1080
const FRAMERATE = 30

const codecsFor = (width: number, height: number): string[] => {
	const macroblocks = Math.ceil(width / 16) * Math.ceil(height / 16)
	return macroblocks <= LEVEL_4_MAX_MACROBLOCKS
		? LEVEL_4_CODECS
		: LEVEL_5_1_CODECS
}

const bitrateFor = (width: number, height: number): number =>
	Math.round(
		Math.min(
			MAX_BITRATE,
			Math.max(BASE_BITRATE, (BASE_BITRATE * width * height) / BASE_AREA),
		),
	)

export const pickEncoderConfig = async (
	width: number,
	height: number,
): Promise<VideoEncoderConfig> => {
	const codecs = codecsFor(width, height)
	for (const codec of codecs) {
		const config: VideoEncoderConfig = {
			codec,
			width,
			height,
			bitrate: bitrateFor(width, height),
			framerate: FRAMERATE,
			avc: { format: 'annexb' },
		}
		const { supported } = await VideoEncoder.isConfigSupported(config)
		if (supported) return config
	}
	throw new Error(
		`This system cannot encode H.264 at ${width}x${height} (tried ${codecs.join(', ')}).`,
	)
}

export const encodesInHardware = async (
	width: number,
	height: number,
): Promise<boolean> => {
	const config = await pickEncoderConfig(width, height)
	const { supported } = await VideoEncoder.isConfigSupported({
		...config,
		hardwareAcceleration: 'prefer-hardware',
	})
	return supported === true
}
