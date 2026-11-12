export const toDevice = (
	e: { clientX: number; clientY: number },
	el: Element,
	vw: number,
	vh: number,
): { x: number; y: number; inside: boolean } => {
	const r = el.getBoundingClientRect()
	const s = Math.min(r.width / vw, r.height / vh)
	const left = r.left + (r.width - vw * s) / 2
	const top = r.top + (r.height - vh * s) / 2
	const x = (e.clientX - left) / s
	const y = (e.clientY - top) / s
	return {
		x: Math.round(Math.min(Math.max(x, 0), vw - 1)),
		y: Math.round(Math.min(Math.max(y, 0), vh - 1)),
		inside: x >= 0 && y >= 0 && x < vw && y < vh,
	}
}

export const wheelToScroll = (
	e: WheelEvent,
): { hscroll: number; vscroll: number } => {
	const unit = e.deltaMode === 1 ? 1 / 3 : e.deltaMode === 2 ? 1 : 1 / 100
	const clamp = (v: number): number => Math.min(16, Math.max(-16, v))
	return {
		hscroll: clamp(-e.deltaX * unit),
		vscroll: clamp(-e.deltaY * unit),
	}
}
