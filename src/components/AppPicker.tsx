import { type JSX, useEffect, useState } from 'react'

import { type InstalledApp, listApps } from '../lib/ipc'
import { warn } from '../lib/log'

const PACKAGE_PATTERN = /^[A-Za-z]\w*(\.[A-Za-z]\w*)+$/

const matches = (app: InstalledApp, needle: string): boolean =>
	app.package.toLowerCase().includes(needle) ||
	(app.label?.toLowerCase().includes(needle) ?? false)

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
	const [apps, setApps] = useState<InstalledApp[] | null>(null)
	const [loadError, setLoadError] = useState<string | null>(null)
	const [query, setQuery] = useState('')

	useEffect(() => {
		let live = true
		listApps(serial)
			.then((list) => {
				if (live) setApps(list)
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
	const shown = (apps ?? []).filter((app) => matches(app, needle))
	const canUseTyped =
		PACKAGE_PATTERN.test(typed) &&
		!(apps ?? []).some((app) => app.package === typed)

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
				placeholder='App name or package'
				aria-label='Filter apps'
				value={query}
				onChange={(e) => setQuery(e.target.value)}
				onKeyDown={(e) => {
					if (e.key !== 'Enter' || busy) return
					const only = shown.length === 1 ? shown[0] : undefined
					if (only) onPick(only.package)
					else if (canUseTyped) onPick(typed)
				}}
			/>
			<div className='app-picker-list'>
				{loadError && <span className='err'>{loadError}</span>}
				{!loadError && apps === null && (
					<span className='muted'>Loading installed apps…</span>
				)}
				{apps !== null && shown.length === 0 && !canUseTyped && (
					<span className='muted'>
						{apps.length === 0
							? 'No installed apps on this device'
							: 'No app matches'}
					</span>
				)}
				{shown.map((app) => (
					<button
						key={app.package}
						className={
							app.package === current
								? 'app-choice current'
								: 'app-choice'
						}
						aria-current={app.package === current}
						disabled={busy}
						title={app.package}
						onClick={() => onPick(app.package)}
					>
						<span className='app-choice-name'>
							{app.label ?? app.package}
						</span>
						{app.label !== null && (
							<span className='app-choice-package'>
								{app.package}
							</span>
						)}
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
