export interface Rect {
	x: number
	y: number
	w: number
	h: number
}

interface Size {
	width: number
	height: number
}

export interface Placement<T> {
	item: T
	rect: Rect
}

const fit = (size: Size, cell: Rect): Rect => {
	const scale = Math.min(cell.w / size.width, cell.h / size.height)
	const w = size.width * scale
	const h = size.height * scale
	return {
		x: Math.round(cell.x + (cell.w - w) / 2),
		y: Math.round(cell.y + (cell.h - h) / 2),
		w: Math.round(w),
		h: Math.round(h),
	}
}

const place = <T extends Size>(
	items: T[],
	cols: number,
	width: number,
	height: number,
	gap: number,
): Placement<T>[] => {
	const rows = Math.ceil(items.length / cols)
	const cellW = (width - gap * (cols + 1)) / cols
	const cellH = (height - gap * (rows + 1)) / rows
	return items.map((item, i) => {
		const row = Math.floor(i / cols)
		const inRow = Math.min(cols, items.length - row * cols)
		// A short last row is centered.
		const indent = ((cols - inRow) * (cellW + gap)) / 2
		const cell: Rect = {
			x: gap + indent + (i % cols) * (cellW + gap),
			y: gap + row * (cellH + gap),
			w: cellW,
			h: cellH,
		}
		return { item, rect: fit(item, cell) }
	})
}

// Tries every column count and keeps the one whose fitted tiles cover the most area.
export const layoutGrid = <T extends Size>(
	items: T[],
	width: number,
	height: number,
	gap: number,
): Placement<T>[] => {
	let best: Placement<T>[] = []
	let bestArea = -1
	for (let cols = 1; cols <= items.length; cols += 1) {
		const placed = place(items, cols, width, height, gap)
		const area = placed.reduce((sum, p) => sum + p.rect.w * p.rect.h, 0)
		if (area > bestArea) {
			bestArea = area
			best = placed
		}
	}
	return best
}
