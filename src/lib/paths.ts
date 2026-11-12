export const joinPath = (dir: string, name: string): string =>
	dir === '/' ? `/${name}` : `${dir}/${name}`

export const parentPath = (path: string): string => {
	const cut = path.lastIndexOf('/')
	return cut <= 0 ? '/' : path.slice(0, cut)
}

export const appDataRoot = (pkg: string): string => `/data/data/${pkg}`

export const formatSize = (bytes: number): string => {
	if (bytes < 1024) return `${bytes} B`
	const units = ['KB', 'MB', 'GB']
	let value = bytes / 1024
	let unit = 0
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024
		unit += 1
	}
	return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`
}

const pad = (n: number): string => String(n).padStart(2, '0')

export const formatTime = (epochSeconds: number): string => {
	const d = new Date(epochSeconds * 1000)
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
