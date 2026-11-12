import type { ControlMessage } from '../lib/control'
import { KEYCODE, META } from './keycodes'

export const metaState = (e: KeyboardEvent): number => {
	let meta = 0
	if (e.shiftKey) meta |= META.SHIFT_ON | META.SHIFT_LEFT_ON
	if (e.ctrlKey) meta |= META.CTRL_ON | META.CTRL_LEFT_ON
	if (e.altKey) meta |= META.ALT_ON | META.ALT_LEFT_ON
	if (e.metaKey) meta |= META.META_ON | META.META_LEFT_ON
	if (e.getModifierState('CapsLock')) meta |= META.CAPS_LOCK_ON
	if (e.getModifierState('NumLock')) meta |= META.NUM_LOCK_ON
	return meta
}

export type KeyAction =
	| { kind: 'send'; message: ControlMessage }
	/** Ctrl+V: paste the host clipboard into the device. */
	| { kind: 'paste' }
	| { kind: 'ignore' }

/**
 * scrcpy "mixed" keyboard mode (spec section 9.3): special keys, letters,
 * space and anything with Ctrl/Alt/Meta become keycodes; printable ASCII
 * digits and punctuation become INJECT_TEXT (independent of the device's
 * layout); other characters go through the clipboard with paste.
 */
export const mapKey = (
	e: KeyboardEvent,
	action: 0 | 1,
	repeat: number,
): KeyAction => {
	if (e.isComposing) return { kind: 'ignore' }
	if (action === 0 && e.ctrlKey && !e.altKey && e.code === 'KeyV') {
		return { kind: 'paste' }
	}
	const keycode = KEYCODE[e.code]
	const altGr = e.getModifierState('AltGraph')
	const command = (e.ctrlKey || e.altKey || e.metaKey) && !altGr
	const letterOrSpace = /^Key[A-Z]$/.test(e.code) || e.code === 'Space'
	const printable = [...e.key].length === 1
	if (
		keycode !== undefined &&
		(command || (letterOrSpace && !altGr) || !printable)
	) {
		return {
			kind: 'send',
			message: { t: 'key', action, keycode, repeat, meta: metaState(e) },
		}
	}
	if (action === 0 && printable) {
		return {
			kind: 'send',
			message: /^[\x20-\x7e]$/.test(e.key)
				? { t: 'text', text: e.key }
				: { t: 'setClipboard', text: e.key, paste: true },
		}
	}
	return { kind: 'ignore' }
}
