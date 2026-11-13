import { type JSX, useEffect, useState } from 'react'

import { listPackages } from '../lib/ipc'
import { warn } from '../lib/log'

const PACKAGE_PATTERN = /^[A-Za-z]\w*(\.[A-Za-z]\w*)+$/

interface AppPickerProps {
	serial: string
	current: string | null
	busy: boolean
	onPick: (appPackage: string) => void
	onBack: (() => void) | null
	onInstall: () => void
}

export const AppPicker = ({
	serial,
	current,
	busy,
	onPick,
	onBack,
	onInstall,
}: AppPickerProps): JSX.Element => {
	const [packages, setPackages] = useState<string[] | null>(null)
	const [loadError, setLoadError] = useState<string | null>(null)
	const [query, setQuery] = useState('')

	useEffect(() => {
		let live = true
		listPackages(serial)
			.then((list) => {
				if (live) setPackages(list)
			})
			.catch((e: unknown) => {
				void warn(
					`app picker: listing apps on ${serial} failed: ${String(e)}`,
				)
				if (live) setLoadError(String(e))
			})
		return (): void => {
			live = false
		}
	}, [serial])

	const typed = query.trim()
	const needle = typed.toLowerCase()
	const shown = (packages ?? []).filter((p) =>
		p.toLowerCase().includes(needle),
	)
	const canUseTyped =
		PACKAGE_PATTERN.test(typed) && !(packages ?? []).includes(typed)

	return (
		<div className='app-popover app-picker' aria-label='Choose your app'>
			<div className='app-picker-head'>
				{onBack && (
					<button onClick={onBack} title='Back to the app menu'>
						Back
					</button>
				)}
				<span>Choose your app</span>
			</div>
			<input
				className='app-picker-filter'
				autoFocus
				spellCheck={false}
				placeholder='Filter, or type a package name'
				aria-label='Filter apps'
				value={query}
				onChange={(e) => setQuery(e.target.value)}
				onKeyDown={(e) => {
					if (e.key !== 'Enter' || busy) return
					if (shown.length === 1) onPick(shown[0] ?? typed)
					else if (canUseTyped) onPick(typed)
				}}
			/>
			<div className='app-picker-list'>
				{loadError && <span className='err'>{loadError}</span>}
				{!loadError && packages === null && (
					<span className='muted'>Loading installed apps…</span>
				)}
				{packages !== null && shown.length === 0 && !canUseTyped && (
					<span className='muted'>
						{packages.length === 0
							? 'No installed apps on this device'
							: 'No app matches'}
					</span>
				)}
				{shown.map((p) => (
					<button
						key={p}
						className={p === current ? 'current' : undefined}
						aria-current={p === current}
						disabled={busy}
						title={p}
						onClick={() => onPick(p)}
					>
						{p}
					</button>
				))}
				{canUseTyped && (
					<button disabled={busy} onClick={() => onPick(typed)}>
						Use {typed}
					</button>
				)}
			</div>
			<hr />
			<button disabled={busy} onClick={onInstall}>
				Install APK…
			</button>
		</div>
	)
}
