import { type JSX, useEffect, useRef, useState } from 'react'

import { type AppAction, appAction, installApkBytes } from '../lib/ipc'
import { warn } from '../lib/log'
import { APP_PACKAGE_EVENT, getLogcatInfo, setAppPackage } from '../lib/logcat'
import { useNote } from '../state/note'
import { AppPicker } from './AppPicker'

const CONFIRM_MS = 4000
const APK_ACCEPT = '.apk,application/vnd.android.package-archive'
const BUSY_TEXT: Record<AppAction, string> = {
	restart: 'Restarting…',
	forceStop: 'Stopping…',
	clearData: 'Clearing data…',
}

interface AppMenuProps {
	serial: string
}

export const AppMenu = ({ serial }: AppMenuProps): JSX.Element => {
	const [open, setOpen] = useState(false)
	const [picking, setPicking] = useState(false)
	const [busy, setBusy] = useState(false)
	const [appPackage, setCurrentPackage] = useState<string | null>(null)
	const { note, showNote } = useNote()
	const rootRef = useRef<HTMLSpanElement>(null)
	const fileInput = useRef<HTMLInputElement>(null)

	useEffect(() => {
		let live = true
		const load = (): void => {
			getLogcatInfo(serial)
				.then((info) => {
					if (live) setCurrentPackage(info.appPackage)
				})
				.catch((e: unknown) => {
					void warn(
						`app menu: package of ${serial} unknown: ${String(e)}`,
					)
				})
		}
		load()
		window.addEventListener(APP_PACKAGE_EVENT, load)
		return (): void => {
			live = false
			window.removeEventListener(APP_PACKAGE_EVENT, load)
		}
	}, [serial])

	useEffect(() => {
		if (!open) return
		const onPointerDown = (e: PointerEvent): void => {
			const root = rootRef.current
			if (root && e.target instanceof Node && !root.contains(e.target)) {
				setOpen(false)
				setPicking(false)
			}
		}
		const onKeyDown = (e: KeyboardEvent): void => {
			if (e.key !== 'Escape') return
			setOpen(false)
			setPicking(false)
		}
		window.addEventListener('pointerdown', onPointerDown)
		window.addEventListener('keydown', onKeyDown)
		return (): void => {
			window.removeEventListener('pointerdown', onPointerDown)
			window.removeEventListener('keydown', onKeyDown)
		}
	}, [open])

	const close = (): void => {
		setOpen(false)
		setPicking(false)
	}

	const run = (busyText: string, action: () => Promise<string>): void => {
		if (busy) return
		setBusy(true)
		showNote(busyText, { busy: true })
		action()
			.then((message) => showNote(message))
			.catch((e: unknown) => {
				void warn(
					`app menu on ${serial}: ${busyText} failed: ${String(e)}`,
				)
				showNote(String(e), { error: true })
			})
			.finally(() => setBusy(false))
	}

	const act = (action: AppAction): void => {
		if (!appPackage) return
		close()
		run(BUSY_TEXT[action], () => appAction(serial, appPackage, action))
	}

	const pick = (next: string): void => {
		close()
		if (next === appPackage) return
		run(`Switching to ${next}…`, async () => {
			await setAppPackage(next)
			return `Your app is now ${next}`
		})
	}

	const install = (): void => {
		close()
		fileInput.current?.click()
	}

	const installPicked = (file: File): void => {
		run(`Installing ${file.name}…`, async () =>
			installApkBytes(
				serial,
				file.name,
				new Uint8Array(await file.arrayBuffer()),
			),
		)
	}

	const popover = !open ? null : appPackage && !picking ? (
		<AppMenuPopover
			appPackage={appPackage}
			busy={busy}
			onAction={act}
			onChange={() => setPicking(true)}
			onInstall={install}
		/>
	) : (
		<AppPicker
			serial={serial}
			current={appPackage}
			busy={busy}
			onPick={pick}
			onBack={appPackage ? (): void => setPicking(false) : null}
			onInstall={install}
		/>
	)

	return (
		<span className='app-menu' ref={rootRef}>
			<button
				onClick={() => (open ? close() : setOpen(true))}
				aria-expanded={open}
				aria-haspopup='menu'
				title={appPackage ?? 'Choose the app you are testing'}
			>
				App ▾
			</button>
			{popover}
			{note && (
				<span
					className={note.error ? 'err' : 'muted'}
					title={note.text}
				>
					{note.text}
				</span>
			)}
			<input
				ref={fileInput}
				type='file'
				accept={APK_ACCEPT}
				hidden
				onChange={(e) => {
					const file = e.target.files?.[0]
					e.target.value = ''
					if (file) installPicked(file)
				}}
			/>
		</span>
	)
}

interface AppMenuPopoverProps {
	appPackage: string
	busy: boolean
	onAction: (action: AppAction) => void
	onChange: () => void
	onInstall: () => void
}

const AppMenuPopover = ({
	appPackage,
	busy,
	onAction,
	onChange,
	onInstall,
}: AppMenuPopoverProps): JSX.Element => {
	const [confirming, setConfirming] = useState(false)

	useEffect(() => {
		if (!confirming) return
		const timer = window.setTimeout(() => setConfirming(false), CONFIRM_MS)
		return (): void => window.clearTimeout(timer)
	}, [confirming])

	return (
		<div className='app-popover' role='menu'>
			<code className='app-package' title={appPackage}>
				{appPackage}
			</code>
			<button
				role='menuitem'
				disabled={busy}
				onClick={() => onAction('restart')}
			>
				Restart app
			</button>
			<button
				role='menuitem'
				disabled={busy}
				onClick={() => onAction('forceStop')}
			>
				Force stop
			</button>
			<button
				role='menuitem'
				className={confirming ? 'danger' : undefined}
				disabled={busy}
				onClick={() =>
					confirming ? onAction('clearData') : setConfirming(true)
				}
			>
				{confirming
					? `Click again to delete all data of ${appPackage}`
					: 'Clear data…'}
			</button>
			<hr />
			<button role='menuitem' disabled={busy} onClick={onChange}>
				Change app…
			</button>
			<button role='menuitem' disabled={busy} onClick={onInstall}>
				Install APK…
			</button>
		</div>
	)
}
