import './TerminalPanel.css'

import { open } from '@tauri-apps/plugin-dialog'
import { type JSX, useRef, useState } from 'react'

import { warn } from '../lib/log'
import {
	startTerminal,
	stopTerminal,
	type TerminalSpec,
	type TerminalStarted,
} from '../lib/terminal'
import { useAppPackage } from '../state/app-package'
import { useFolderDrop } from '../state/folder-drop'
import {
	activateTerminal,
	addTerminal,
	clearTerminal,
	removeTerminal,
	replaceTerminal,
	typeInto,
	useDeviceTerminals,
} from '../state/terminals'
import { Icon } from './Icon'
import { TerminalView } from './TerminalView'

const PACKAGE_PATTERN = /^[A-Za-z]\w*(\.[A-Za-z]\w*)+$/

interface QuickCommand {
	label: string
	command: string
}

const DEVICE_COMMANDS: readonly QuickCommand[] = [
	{
		label: 'Android version',
		command:
			'getprop ro.product.model; getprop ro.build.version.release; getprop ro.build.version.sdk',
	},
	{ label: 'Battery', command: 'dumpsys battery' },
	{ label: 'Installed apps', command: 'pm list packages -3' },
	{ label: 'top', command: 'top -m 15' },
]

const appCommands = (appPackage: string | null): QuickCommand[] =>
	appPackage && PACKAGE_PATTERN.test(appPackage)
		? [
				{
					label: 'Start app',
					command: `am start -n "$(cmd package resolve-activity --brief ${appPackage} | tail -n 1)"`,
				},
				{ label: 'Stop app', command: `am force-stop ${appPackage}` },
				{
					label: 'App process',
					command: `ps -A | grep ${appPackage}`,
				},
			]
		: []

const projectLabel = (session: TerminalStarted): string =>
	session.project === 'reactNative'
		? 'React Native'
		: session.project === 'expo'
			? 'Expo'
			: 'Folder'

interface TerminalPanelProps {
	serial: string
	deviceName: string
}

export const TerminalPanel = ({
	serial,
	deviceName,
}: TerminalPanelProps): JSX.Element => {
	const { sessions, active } = useDeviceTerminals(serial)
	const appPackage = useAppPackage(serial)
	const [busy, setBusy] = useState(false)
	const [failure, setFailure] = useState<string | null>(null)
	const panelRef = useRef<HTMLDivElement>(null)

	const start = (spec: TerminalSpec, replacing: string | null): void => {
		if (busy) return
		setBusy(true)
		setFailure(null)
		startTerminal(serial, spec)
			.then((started) => {
				if (replacing) {
					replaceTerminal(replacing, started)
					void stopTerminal(replacing)
				} else {
					addTerminal(started)
				}
			})
			.catch((e: unknown) => {
				void warn(`terminal on ${serial}: start failed: ${String(e)}`)
				setFailure(String(e))
			})
			.finally(() => setBusy(false))
	}

	const openProject = (path: string): void =>
		start({ kind: 'project', path, run: true }, null)

	const pickFolder = (): void => {
		open({
			directory: true,
			multiple: false,
			title: `Open a project to run on ${deviceName}`,
		})
			.then((path) => {
				if (typeof path === 'string') openProject(path)
			})
			.catch((e: unknown) => {
				void warn(`terminal: folder picker failed: ${String(e)}`)
				setFailure(String(e))
			})
	}

	const restart = (session: TerminalStarted): void => {
		const spec: TerminalSpec =
			session.kind === 'device' || session.cwd === null
				? { kind: 'device' }
				: { kind: 'project', path: session.cwd, run: false }
		start(spec, session.id)
	}

	const close = (id: string): void => {
		removeTerminal(serial, id)
		stopTerminal(id).catch((e: unknown) => {
			void warn(`terminal ${id}: stop failed: ${String(e)}`)
		})
	}

	const dragging = useFolderDrop(panelRef, openProject)
	const current = sessions.find((s) => s.id === active) ?? null
	const quick =
		current?.kind === 'device'
			? [...DEVICE_COMMANDS, ...appCommands(appPackage)]
			: []

	return (
		<div className='terminal-panel' ref={panelRef}>
			<div className='terminal-bar'>
				<span
					className='terminal-link'
					title={`Commands here run only on ${deviceName} (${serial})`}
				>
					Linked to <strong>{deviceName}</strong>
					<span className='muted'> · {serial}</span>
				</span>
				<div className='terminal-tabs' role='tablist'>
					{sessions.map((s) => (
						<span
							key={s.id}
							className={
								s.id === active
									? 'terminal-tab active'
									: 'terminal-tab'
							}
						>
							<button
								role='tab'
								aria-selected={s.id === active}
								title={s.cwd ?? `Shell on ${deviceName}`}
								onClick={() => activateTerminal(serial, s.id)}
							>
								<Icon
									name={
										s.kind === 'device'
											? 'terminal'
											: 'folder'
									}
								/>
								{s.title}
							</button>
							<button
								className='terminal-tab-close'
								aria-label={`Close ${s.title}`}
								title='Close this terminal'
								onClick={() => close(s.id)}
							>
								<Icon name='close' size={14} />
							</button>
						</span>
					))}
				</div>
				<button
					disabled={busy}
					onClick={() => start({ kind: 'device' }, null)}
				>
					<Icon name='terminal' />
					Device shell
				</button>
				<button disabled={busy} onClick={pickFolder}>
					<Icon name='folderOpen' />
					Open project folder…
				</button>
			</div>
			{current && (
				<div className='terminal-actions'>
					{current.kind === 'device' ? (
						quick.map((q) => (
							<button
								key={q.label}
								title={q.command}
								onClick={() =>
									typeInto(current.id, `${q.command}\r`)
								}
							>
								{q.label}
							</button>
						))
					) : (
						<>
							<span className='terminal-badge'>
								{projectLabel(current)}
							</span>
							<span
								className='terminal-cwd'
								title={current.cwd ?? ''}
							>
								{current.cwd}
							</span>
							{current.command && (
								<button
									title={current.command}
									onClick={() =>
										typeInto(
											current.id,
											`${current.command ?? ''}\r`,
										)
									}
								>
									<Icon name='play' />
									Run again
								</button>
							)}
							<span
								className='muted'
								title='adb, Gradle and the React Native CLI target this device; adb is the Android SDK one'
							>
								ANDROID_SERIAL={serial}
							</span>
						</>
					)}
					<button
						className='terminal-clear'
						onClick={() => clearTerminal(current.id)}
					>
						Clear
					</button>
				</div>
			)}
			{failure && <p className='terminal-error err'>{failure}</p>}
			<div className='terminal-body'>
				{sessions.length === 0 && (
					<div className='terminal-empty'>
						<p>
							Open a <strong>device shell</strong> to run commands
							on {deviceName}, or open a{' '}
							<strong>project folder</strong> to build and run it
							on this device.
						</p>
						<p className='muted'>
							React Native and Expo projects start building right
							away. You can also drop a folder here.
						</p>
					</div>
				)}
				{sessions.map((s) => (
					<TerminalView
						key={s.id}
						session={s}
						hidden={s.id !== active}
						onRestart={() => restart(s)}
					/>
				))}
				{dragging && (
					<div className='drop-overlay'>
						Drop to open this folder and run it on {deviceName}
					</div>
				)}
			</div>
		</div>
	)
}
