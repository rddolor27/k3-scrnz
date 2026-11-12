import { type JSX, useEffect, useRef, useState } from 'react'

import { type AppAction, appAction, installApkBytes } from '../lib/ipc'
import { warn } from '../lib/log'
import { getLogcatInfo } from '../lib/logcat'
import { useNote } from '../state/note'

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
	const [busy, setBusy] = useState(false)
	const [appPackage, setAppPackage] = useState<string | null>(null)
	const { note, showNote } = useNote()
	const rootRef = useRef<HTMLSpanElement>(null)
	const fileInput = useRef<HTMLInputElement>(null)

	useEffect(() => {
		let live = true
		getLogcatInfo(serial)
			.then((info) => {
				if (live) setAppPackage(info.appPackage)
			})
			.catch((e: unknown) => {
				void warn(
					`app menu: package of ${serial} unknown: ${String(e)}`,
				)
			})
		return (): void => {
			live = false
		}
	}, [serial])

	useEffect(() => {
		if (!open) return
		const onPointerDown = (e: PointerEvent): void => {
			const root = rootRef.current
			if (root && e.target instanceof Node && !root.contains(e.target)) {
				setOpen(false)
			}
		}
		const onKeyDown = (e: KeyboardEvent): void => {
			if (e.key === 'Escape') setOpen(false)
		}
		window.addEventListener('pointerdown', onPointerDown)
		window.addEventListener('keydown', onKeyDown)
		return (): void => {
			window.removeEventListener('pointerdown', onPointerDown)
			window.removeEventListener('keydown', onKeyDown)
		}
	}, [open])

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
		setOpen(false)
		run(BUSY_TEXT[action], () => appAction(serial, appPackage, action))
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

	return (
		<span className='app-menu' ref={rootRef}>
			<button
				onClick={() => setOpen((shown) => !shown)}
				disabled={!appPackage}
				aria-expanded={open}
				aria-haspopup='menu'
				title={appPackage ?? 'Looking up the app package…'}
			>
				App ▾
			</button>
			{open && appPackage && (
				<AppMenuPopover
					appPackage={appPackage}
					busy={busy}
					onAction={act}
					onInstall={() => {
						setOpen(false)
						fileInput.current?.click()
					}}
				/>
			)}
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
	onInstall: () => void
}

const AppMenuPopover = ({
	appPackage,
	busy,
	onAction,
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
			<button role='menuitem' disabled={busy} onClick={onInstall}>
				Install APK…
			</button>
		</div>
	)
}
