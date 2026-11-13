import {
	type JSX,
	type PointerEvent as ReactPointerEvent,
	useEffect,
	useRef,
	useState,
} from 'react'

import type { DeviceView } from '../lib/ipc'
import { CustomerScreens, useCustomerDisplaysOf } from './CustomerScreens'
import { GridRecordBar } from './GridRecordBar'
import { ScreenView } from './ScreenView'

const GRID_MAX_SIZE = 1280
const GRID_CUSTOMER_MAX_SIZE = 640
// Must match the 30% flex-basis of `.customer-panel`.
const CUSTOMER_SHARE = 0.3
const WIDE_FACTOR = 1 / (1 - CUSTOMER_SHARE)
const GAP = 12
const MIN_W = 280
const MIN_H = 200
const TILE_CHROME_H = 44
const SIZES_KEY = 'tri.gridSizes'

interface Size {
	w: number
	h: number
}

const readSizes = (): Record<string, Size> => {
	try {
		const parsed: unknown = JSON.parse(
			window.localStorage.getItem(SIZES_KEY) ?? '{}',
		)
		if (typeof parsed !== 'object' || parsed === null) return {}
		const sizes: Record<string, Size> = {}
		for (const [serial, value] of Object.entries(parsed)) {
			if (
				typeof value === 'object' &&
				value !== null &&
				'w' in value &&
				'h' in value &&
				typeof value.w === 'number' &&
				typeof value.h === 'number'
			) {
				sizes[serial] = { w: value.w, h: value.h }
			}
		}
		return sizes
	} catch {
		return {}
	}
}

const saveSizes = (sizes: Record<string, Size>): void => {
	try {
		window.localStorage.setItem(SIZES_KEY, JSON.stringify(sizes))
	} catch {
		// Storage can be unavailable.
	}
}

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

interface DeviceGridProps {
	devices: DeviceView[]
	onOpen: (serial: string) => void
}

export const DeviceGrid = ({
	devices,
	onOpen,
}: DeviceGridProps): JSX.Element => {
	const gridRef = useRef<HTMLDivElement>(null)
	const [box, setBox] = useState<Size>({ w: 960, h: 600 })
	const [sizes, setSizes] = useState<Record<string, Size>>(readSizes)

	useEffect(() => {
		const grid = gridRef.current
		if (!grid) return
		const observer = new ResizeObserver(() => {
			setBox({ w: grid.clientWidth, h: grid.clientHeight })
		})
		observer.observe(grid)
		return (): void => observer.disconnect()
	}, [])

	const customers = useCustomerDisplaysOf(devices.map((d) => d.serial))
	const isWide = (serial: string): boolean =>
		(customers[serial] ?? []).length > 0
	const auto = autoSize(
		devices.map((d) => isWide(d.serial)),
		box,
	)

	const startResize = (
		sizeKey: string,
		minW: number,
		e: ReactPointerEvent<HTMLDivElement>,
	): void => {
		const tile = e.currentTarget.parentElement
		if (!tile) return
		e.preventDefault()
		e.currentTarget.setPointerCapture(e.pointerId)
		const rect = tile.getBoundingClientRect()
		const start = {
			x: e.clientX,
			y: e.clientY,
			w: rect.width,
			h: rect.height,
		}
		const maxW = Math.max(minW, box.w)
		let next: Size = { w: rect.width, h: rect.height }
		const onMove = (ev: PointerEvent): void => {
			next = {
				w: Math.round(
					Math.min(
						maxW,
						Math.max(minW, start.w + ev.clientX - start.x),
					),
				),
				h: Math.round(Math.max(MIN_H, start.h + ev.clientY - start.y)),
			}
			setSizes((all) => ({ ...all, [sizeKey]: next }))
		}
		const onUp = (): void => {
			window.removeEventListener('pointermove', onMove)
			window.removeEventListener('pointerup', onUp)
			window.removeEventListener('pointercancel', onUp)
			setSizes((all) => {
				const saved = { ...all, [sizeKey]: next }
				saveSizes(saved)
				return saved
			})
		}
		window.addEventListener('pointermove', onMove)
		window.addEventListener('pointerup', onUp)
		window.addEventListener('pointercancel', onUp)
	}

	const resetSize = (sizeKey: string): void => {
		setSizes((all) => {
			const rest = Object.fromEntries(
				Object.entries(all).filter(([key]) => key !== sizeKey),
			)
			saveSizes(rest)
			return rest
		})
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
	return (
		<div className='grid-view'>
			<GridRecordBar serials={devices.map((device) => device.serial)} />
			<div className='device-grid' ref={gridRef}>
				{devices.map((device) => {
					const wide = isWide(device.serial)
					// A size saved for one screen would squeeze two.
					const sizeKey = wide
						? `${device.serial}/customer`
						: device.serial
					const size = sizes[sizeKey] ?? {
						w: tileWidth(auto.w, wide),
						h: auto.h,
					}
					return (
						<div
							className='grid-tile'
							key={device.serial}
							style={{ width: size.w, height: size.h }}
						>
							<ScreenView
								serial={device.serial}
								displayId={0}
								role='main'
								compact
								maxSize={GRID_MAX_SIZE}
								tapLabel={device.name}
								toolbarStart={
									<button
										className='tile-name'
										onClick={() => onOpen(device.serial)}
										title={`${device.serial} · open its tab`}
									>
										{device.name}
									</button>
								}
							/>
							{wide && (
								<CustomerScreens
									serial={device.serial}
									displays={customers[device.serial] ?? []}
									compact
									maxSize={GRID_CUSTOMER_MAX_SIZE}
								/>
							)}
							<div
								className='tile-resize'
								title='Drag to resize · double-click to reset'
								onPointerDown={(e) =>
									startResize(
										sizeKey,
										tileWidth(MIN_W, wide),
										e,
									)
								}
								onDoubleClick={() => resetSize(sizeKey)}
							/>
						</div>
					)
				})}
			</div>
		</div>
	)
}
