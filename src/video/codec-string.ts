// `avc1.PPCCLL`: the three bytes after the SPS NAL header of the Annex-B config.
export const avcCodecString = (config: Uint8Array): string | null => {
	let i = 0
	while (i + 4 < config.length) {
		const start =
			config[i] === 0 &&
			config[i + 1] === 0 &&
			config[i + 2] === 0 &&
			config[i + 3] === 1
				? 4
				: config[i] === 0 && config[i + 1] === 0 && config[i + 2] === 1
					? 3
					: 0
		if (start === 0) {
			i += 1
			continue
		}
		const nal = i + start
		if (((config[nal] ?? 0) & 0x1f) === 7 && nal + 3 < config.length) {
			const hex = Array.from(config.subarray(nal + 1, nal + 4), (b) =>
				b.toString(16).padStart(2, '0'),
			)
				.join('')
				.toUpperCase()
			return `avc1.${hex}`
		}
		i = nal
	}
	return null
}
