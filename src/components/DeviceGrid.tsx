import {
	type JSX,
	type PointerEvent as ReactPointerEvent,
	useEffect,
	useRef,
	useState,
} from 'react'

import type { DeviceView } from '../lib/ipc'
import { CustomerScreens, useCustomerDisplaysOf } from './CustomerScreens'
import { GridTools } from './GridTools'
import { Icon } from './Icon'
import { ScreenView } from './ScreenView'

const GRID_MAX_SIZE = 1280
const GRID_CUSTOMER_MAX_SIZE = 640
// Rust polls only the device of the visible tab, and the grid has none.
const DISPLAYS_EVERY_MS = 5000
// Must match the 30% flex-basis of `.customer-panel`.
const CUSTOMER_SHARE = 0.3
const MIN_SHARE = 0.15
const MAX_SHARE = 0.6
const WIDE_FACTOR = 1 / (1 - CUSTOMER_SHARE)
const GAP = 12
const MIN_W = 280
const MIN_H = 200
const TILE_CHROME_H = 44
// Must match the padding and border of `.grid-tile`, both sides.
const TILE_CHROME_W = 18
const DRAG_START_PX = 3
const RECTS_KEY = 'tri.gridRects'
const SPLITS_KEY = 'tri.gridSplits'
const EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const

type Edge = (typeof EDGES)[number]

interface Size {
	w: number
	h: number
}

interface Rect extends Size {
	x: number
	y: number
}

const readStored = <T,>(
	key: string,
	parse: (value: unknown) => T | null,
): Record<string, T> => {
	try {
		const parsed: unknown = JSON.parse(
			window.localStorage.getItem(key) ?? '{}',
		)
		if (typeof parsed !== 'object' || parsed === null) return {}
		const stored: Record<string, T> = {}
		for (const [id, value] of Object.entries(parsed)) {
			const item = parse(value)
			if (item !== null) stored[id] = item
		}
		return stored
	} catch {
		return {}
	}
}

const saveStored = (key: string, value: Record<string, unknown>): void => {
	try {
		window.localStorage.setItem(key, JSON.stringify(value))
	} catch {
		// Storage can be unavailable.
	}
}

const parseRect = (value: unknown): Rect | null => {
	if (typeof value !== 'object' || value === null) return null
	if (!('x' in value && 'y' in value && 'w' in value && 'h' in value)) {
		return null
	}
	const { x, y, w, h } = value
	return typeof x === 'number' &&
		typeof y === 'number' &&
		typeof w === 'number' &&
		typeof h === 'number'
		? {
				x: Math.max(0, x),
				y: Math.max(0, y),
				w: Math.max(MIN_W, w),
				h: Math.max(MIN_H, h),
			}
		: null
}

const parseShare = (value: unknown): number | null =>
	typeof value === 'number' && value >= MIN_SHARE && value <= MAX_SHARE
		? value
		: null

const without = <T,>(all: Record<string, T>, id: string): Record<string, T> =>
	Object.fromEntries(Object.entries(all).filter(([key]) => key !== id))

const tileWidth = (unit: number, wide: boolean): number =>
	Math.round(unit * (wide ? WIDE_FACTOR : 1))

const rowsNeeded = (wide: boolean[], unit: number, boxW: number): number => {
	let rows = 1
	let used = 0
	for (const isWide of wide) {
		const w = tileWidth(unit, isWide)
		if (used > 0 && used + GAP + w > boxW) {
			rows += 1
			used = w
		} else {
			used += (used > 0 ? GAP : 0) + w
		}
	}
	return rows
}

const widestUnit = (wide: boolean[], rows: number, boxW: number): number => {
	let low = MIN_W
	const widest = wide.includes(true) ? WIDE_FACTOR : 1
	let high = Math.max(MIN_W, Math.floor(boxW / widest))
	while (low < high) {
		const mid = Math.ceil((low + high) / 2)
		if (rowsNeeded(wide, mid, boxW) <= rows) low = mid
		else high = mid - 1
	}
	return low
}

const autoSize = (wide: boolean[], box: Size): Size => {
	let best: Size = { w: MIN_W, h: MIN_H }
	let bestScale = 0
	for (let rows = 1; rows <= Math.max(1, wide.length); rows += 1) {
		const unit = widestUnit(wide, rows, box.w)
		const h = Math.max(MIN_H, Math.floor((box.h - GAP * (rows - 1)) / rows))
		const scale = Math.min(unit / 16, (h - TILE_CHROME_H) / 9)
		if (scale > bestScale) {
			bestScale = scale
			best = { w: unit, h }
		}
	}
	return best
}

const autoRects = (wide: boolean[], box: Size): Rect[] => {
	const size = autoSize(wide, box)
	const rects: Rect[] = []
	let x = 0
	let y = 0
	for (const isWide of wide) {
		const w = tileWidth(size.w, isWide)
		if (x > 0 && x + w > box.w) {
			x = 0
			y += size.h + GAP
		}
		rects.push({ x, y, w, h: size.h })
		x += w + GAP
	}
	return rects
}

const resized = (
	from: Rect,
	edge: Edge,
	minW: number,
	dx: number,
	dy: number,
): Rect => {
	let { x, y, w, h } = from
	if (edge.includes('e')) w = Math.max(minW, from.w + dx)
	if (edge.includes('w')) {
		w = Math.min(from.x + from.w, Math.max(minW, from.w - dx))
		x = from.x + from.w - w
	}
	if (edge.includes('s')) h = Math.max(MIN_H, from.h + dy)
	if (edge.includes('n')) {
		h = Math.min(from.y + from.h, Math.max(MIN_H, from.h - dy))
		y = from.y + from.h - h
	}
	return {
		x: Math.round(x),
		y: Math.round(y),
		w: Math.round(w),
		h: Math.round(h),
	}
}

const trackDrag = (
	e: ReactPointerEvent<HTMLElement>,
	onDelta: (dx: number, dy: number) => void,
	onEnd: () => void,
): void => {
	e.preventDefault()
	e.currentTarget.setPointerCapture(e.pointerId)
	const start = { x: e.clientX, y: e.clientY }
	let dragging = false
	const onMove = (ev: PointerEvent): void => {
		// A button released outside the window is never reported.
		if (ev.buttons === 0) {
			onUp()
			return
		}
		const dx = Math.round(ev.clientX - start.x)
		const dy = Math.round(ev.clientY - start.y)
		if (!dragging && Math.hypot(dx, dy) < DRAG_START_PX) return
		dragging = true
		onDelta(dx, dy)
	}
	const onUp = (): void => {
		window.removeEventListener('pointermove', onMove)
		window.removeEventListener('pointerup', onUp)
		window.removeEventListener('pointercancel', onUp)
		if (dragging) onEnd()
	}
	window.addEventListener('pointermove', onMove)
	window.addEventListener('pointerup', onUp)
	window.addEventListener('pointercancel', onUp)
}

const isTileChrome = (target: EventTarget, tile: EventTarget): boolean =>
	target === tile ||
	(target instanceof Element &&
		target.closest('button') === null &&
		target.closest('.screen-toolbar, .screen-label') !== null)

interface DeviceGridProps {
	devices: DeviceView[]
	onOpen: (serial: string) => void
	toolsSlot: HTMLElement | null
}

export const DeviceGrid = ({
	devices,
	onOpen,
	toolsSlot,
}: DeviceGridProps): JSX.Element => {
	const gridRef = useRef<HTMLDivElement>(null)
	const [box, setBox] = useState<Size>({ w: 960, h: 600 })
	const [rects, setRects] = useState(() => readStored(RECTS_KEY, parseRect))
	const [splits, setSplits] = useState(() =>
		readStored(SPLITS_KEY, parseShare),
	)
	const [front, setFront] = useState<string | null>(null)

	useEffect(() => {
		const grid = gridRef.current
		if (!grid) return
		const observer = new ResizeObserver(() => {
			setBox({ w: grid.clientWidth, h: grid.clientHeight })
		})
		observer.observe(grid)
		return (): void => observer.disconnect()
	}, [])

	const customers = useCustomerDisplaysOf(
		devices.map((d) => d.serial),
		DISPLAYS_EVERY_MS,
	)
	const isWide = (serial: string): boolean =>
		(customers[serial] ?? []).length > 0
	const auto = autoRects(
		devices.map((d) => isWide(d.serial)),
		box,
	)

	const dragRect = (
		id: string,
		e: ReactPointerEvent<HTMLElement>,
		at: (dx: number, dy: number) => Rect,
	): void => {
		let next: Rect | null = null
		trackDrag(
			e,
			(dx, dy) => {
				const rect = at(dx, dy)
				next = rect
				setRects((all) => ({ ...all, [id]: rect }))
			},
			() => {
				if (next) saveStored(RECTS_KEY, { ...rects, [id]: next })
			},
		)
	}

	const startMove = (
		id: string,
		from: Rect,
		e: ReactPointerEvent<HTMLElement>,
	): void => {
		if (e.button !== 0 || !isTileChrome(e.target, e.currentTarget)) return
		dragRect(id, e, (dx, dy) => ({
			...from,
			x: Math.max(0, from.x + dx),
			y: Math.max(0, from.y + dy),
		}))
	}

	const startResize = (
		id: string,
		from: Rect,
		edge: Edge,
		minW: number,
		e: ReactPointerEvent<HTMLElement>,
	): void => {
		e.stopPropagation()
		if (e.button !== 0) return
		dragRect(id, e, (dx, dy) => resized(from, edge, minW, dx, dy))
	}

	const resetRect = (id: string): void => {
		const rest = without(rects, id)
		setRects(rest)
		saveStored(RECTS_KEY, rest)
	}

	const startSplit = (
		serial: string,
		from: number,
		e: ReactPointerEvent<HTMLElement>,
	): void => {
		e.stopPropagation()
		const tile = e.currentTarget.parentElement
		if (e.button !== 0 || !tile) return
		const inner = tile.getBoundingClientRect().width - TILE_CHROME_W
		let next: number | null = null
		trackDrag(
			e,
			(dx) => {
				const share = Math.min(
					MAX_SHARE,
					Math.max(MIN_SHARE, from - dx / inner),
				)
				next = share
				setSplits((all) => ({ ...all, [serial]: share }))
			},
			() => {
				if (next !== null) {
					saveStored(SPLITS_KEY, { ...splits, [serial]: next })
				}
			},
		)
	}

	const resetSplit = (serial: string): void => {
		const rest = without(splits, serial)
		setSplits(rest)
		saveStored(SPLITS_KEY, rest)
	}

	const resetLayout = (): void => {
		setRects({})
		setSplits({})
		saveStored(RECTS_KEY, {})
		saveStored(SPLITS_KEY, {})
	}

	if (devices.length === 0) {
		return (
			<section className='empty'>
				<h1>No devices</h1>
				<p className='muted'>
					Each connected device shows up here as a tile.
				</p>
			</section>
		)
	}
	const arranged = devices.some(
		({ serial }) =>
			rects[serial] !== undefined || splits[serial] !== undefined,
	)
	return (
		<div className='grid-view'>
			<GridTools
				serials={devices.map((device) => device.serial)}
				slot={toolsSlot}
			>
				{arranged && (
					<button
						onClick={resetLayout}
						title='Put every tile back in its automatic place and size'
					>
						Reset layout
					</button>
				)}
			</GridTools>
			<div className='device-grid' ref={gridRef}>
				{devices.map((device, index) => {
					const wide = isWide(device.serial)
					const id = device.serial
					const rect = rects[id] ?? auto[index]
					if (!rect) return null
					const share = splits[device.serial] ?? CUSTOMER_SHARE
					const minW = tileWidth(MIN_W, wide)
					return (
						<div
							className={
								front === device.serial
									? 'grid-tile front'
									: 'grid-tile'
							}
							key={device.serial}
							style={{
								left: rect.x,
								top: rect.y,
								width: rect.w,
								height: rect.h,
							}}
							onPointerDownCapture={() => setFront(device.serial)}
							onPointerDown={(e) => startMove(id, rect, e)}
							onDoubleClick={(e) => {
								if (isTileChrome(e.target, e.currentTarget)) {
									resetRect(id)
								}
							}}
						>
							<ScreenView
								serial={device.serial}
								displayId={0}
								role='main'
								compact
								maxSize={GRID_MAX_SIZE}
								tapLabel={device.name}
								toolbarStart={
									<>
										<span
											className='tile-grip'
											title='Drag to move · double-click to reset'
										>
											<Icon name='grip' />
										</span>
										<button
											className='tile-name'
											onClick={() =>
												onOpen(device.serial)
											}
											title={`${device.serial} · open its tab`}
										>
											{device.name}
										</button>
									</>
								}
							/>
							{wide && (
								<>
									<div
										className='tile-split'
										role='separator'
										aria-orientation='vertical'
										title='Drag to resize the two screens · double-click to reset'
										onPointerDown={(e) =>
											startSplit(device.serial, share, e)
										}
										onDoubleClick={() =>
											resetSplit(device.serial)
										}
									/>
									<CustomerScreens
										serial={device.serial}
										displays={
											customers[device.serial] ?? []
										}
										compact
										maxSize={GRID_CUSTOMER_MAX_SIZE}
										share={share}
									/>
								</>
							)}
							{EDGES.map((edge) => (
								<div
									key={edge}
									className={`tile-edge ${edge}`}
									onPointerDown={(e) =>
										startResize(id, rect, edge, minW, e)
									}
									onDoubleClick={() => resetRect(id)}
								/>
							))}
							<div className='tile-corner' />
						</div>
					)
				})}
			</div>
		</div>
	)
}
