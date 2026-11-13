import {
	type JSX,
	type PointerEvent as ReactPointerEvent,
	useEffect,
	useRef,
	useState,
} from 'react'

import type { DeviceView } from '../lib/ipc'
import { GridRecordBar } from './GridRecordBar'
import { ScreenView } from './ScreenView'

const GRID_MAX_SIZE = 1280
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

const autoSize = (count: number, box: Size): Size => {
	let best: Size = { w: MIN_W, h: MIN_H }
	let bestArea = 0
	for (let cols = 1; cols <= Math.max(1, count); cols += 1) {
		const rows = Math.ceil(count / cols)
		const w = Math.max(MIN_W, Math.floor((box.w - GAP * (cols - 1)) / cols))
		const h = Math.max(MIN_H, Math.floor((box.h - GAP * (rows - 1)) / rows))
		const scale = Math.min(w / 16, (h - TILE_CHROME_H) / 9)
		const area = scale * scale
		if (area > bestArea) {
			bestArea = area
			best = { w, h }
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

	const auto = autoSize(devices.length, box)

	const startResize = (
		serial: string,
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
		const maxW = Math.max(MIN_W, box.w)
		let next: Size = { w: rect.width, h: rect.height }
		const onMove = (ev: PointerEvent): void => {
			next = {
				w: Math.round(
					Math.min(
						maxW,
						Math.max(MIN_W, start.w + ev.clientX - start.x),
					),
				),
				h: Math.round(Math.max(MIN_H, start.h + ev.clientY - start.y)),
			}
			setSizes((all) => ({ ...all, [serial]: next }))
		}
		const onUp = (): void => {
			window.removeEventListener('pointermove', onMove)
			window.removeEventListener('pointerup', onUp)
			window.removeEventListener('pointercancel', onUp)
			setSizes((all) => {
				const saved = { ...all, [serial]: next }
				saveSizes(saved)
				return saved
			})
		}
		window.addEventListener('pointermove', onMove)
		window.addEventListener('pointerup', onUp)
		window.addEventListener('pointercancel', onUp)
	}

	const resetSize = (serial: string): void => {
		setSizes((all) => {
			const rest = Object.fromEntries(
				Object.entries(all).filter(([key]) => key !== serial),
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
					const size = sizes[device.serial] ?? auto
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
							<div
								className='tile-resize'
								title='Drag to resize · double-click to reset'
								onPointerDown={(e) =>
									startResize(device.serial, e)
								}
								onDoubleClick={() => resetSize(device.serial)}
							/>
						</div>
					)
				})}
			</div>
		</div>
	)
}
