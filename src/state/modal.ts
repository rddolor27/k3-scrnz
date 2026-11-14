import { type RefObject, useEffect } from 'react'

const FOCUSABLE =
	'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])'

export const useModal = (
	ref: RefObject<HTMLElement | null>,
	onClose: () => void,
): void => {
	useEffect(() => {
		const previous = document.activeElement
		ref.current?.focus()
		return (): void => {
			if (previous instanceof HTMLElement) previous.focus()
		}
	}, [ref])

	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent): void => {
			// A nested control (an open menu) claims Escape by preventing default.
			if (e.key === 'Escape' && !e.defaultPrevented) {
				onClose()
				return
			}
			const dialog = ref.current
			if (e.key !== 'Tab' || !dialog) return
			const items = Array.from(
				dialog.querySelectorAll<HTMLElement>(FOCUSABLE),
			)
			const first = items[0]
			const last = items[items.length - 1]
			if (!first || !last) return
			const active = document.activeElement
			if (!dialog.contains(active)) {
				e.preventDefault()
				first.focus()
			} else if (e.shiftKey && (active === first || active === dialog)) {
				e.preventDefault()
				last.focus()
			} else if (!e.shiftKey && active === last) {
				e.preventDefault()
				first.focus()
			}
		}
		window.addEventListener('keydown', onKeyDown)
		return (): void => window.removeEventListener('keydown', onKeyDown)
	}, [ref, onClose])
}
