import { getCurrentWebview } from '@tauri-apps/api/webview'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import {
	type JSX,
	type KeyboardEvent as ReactKeyboardEvent,
	useEffect,
	useRef,
	useState,
} from 'react'

import {
	deletePath,
	downloadFile,
	type FileEntry,
	type FileKind,
	type FileLocation,
	listDir,
	listPackages,
	makeDir,
	revealFile,
	uploadBytes,
	uploadPath,
} from '../lib/ipc'
import { error } from '../lib/log'
import {
	appDataRoot,
	formatSize,
	formatTime,
	joinPath,
	parentPath,
} from '../lib/paths'
import { useListing } from '../state/files'

const HOME: FileLocation = { path: '/sdcard', runAs: null }
const QUICK_PATHS = ['/', '/sdcard', '/data/local/tmp']
const ICON: Record<FileKind, string> = {
	dir: '📁',
	file: '📄',
	link: '🔗',
	other: '⚙️',
}

type Status =
	| { kind: 'busy' | 'info' | 'error'; text: string }
	| { kind: 'saved'; text: string; localPath: string }

// Names with line breaks can't be addressed safely: shown, not acted on.
const isActionable = (entry: FileEntry): boolean => !/[\n\r]/.test(entry.name)

const baseName = (localPath: string): string =>
	localPath.split(/[\\/]/).pop() ?? localPath

interface FileExplorerProps {
	serial: string
}

export const FileExplorer = ({ serial }: FileExplorerProps): JSX.Element => {
	const [location, setLocation] = useState<FileLocation>(HOME)
	const [reload, setReload] = useState(0)
	const { listing, listedAt, loading } = useListing(serial, location, reload)
	const [selected, setSelected] = useState<string | null>(null)
	const [status, setStatus] = useState<Status | null>(null)
	const [confirming, setConfirming] = useState<string | null>(null)
	const [creatingFolder, setCreatingFolder] = useState(false)
	const [dragging, setDragging] = useState(false)
	const fileInput = useRef<HTMLInputElement>(null)
	const listRef = useRef<HTMLDivElement>(null)
	const locationRef = useRef(location)

	useEffect(() => {
		locationRef.current = location
	}, [location])

	useEffect(() => {
		listRef.current
			?.querySelector('tr.selected')
			?.scrollIntoView({ block: 'nearest' })
	}, [selected])

	useEffect(() => {
		let live = true
		let unlisten: (() => void) | null = null
		const uploadDropped = async (paths: string[]): Promise<void> => {
			const dir = locationRef.current
			setStatus({
				kind: 'busy',
				text: `Uploading ${paths.length} file(s)…`,
			})
			const failed: string[] = []
			for (const path of paths) {
				try {
					await uploadPath(serial, path, dir)
				} catch (e) {
					failed.push(`${baseName(path)}: ${String(e)}`)
				}
			}
			setReload((n) => n + 1)
			const done = paths.length - failed.length
			setStatus(
				failed.length === 0
					? {
							kind: 'info',
							text: `Uploaded ${done} file(s) to ${dir.path}`,
						}
					: {
							kind: 'error',
							text: `Uploaded ${done} of ${paths.length}. ${failed.join(' · ')}`,
						},
			)
			if (failed.length > 0) {
				void error(
					`file explorer: drop upload failed: ${failed.join(' · ')}`,
				)
			}
		}
		getCurrentWebview()
			.onDragDropEvent((event) => {
				const drag = event.payload
				if (drag.type === 'enter') setDragging(true)
				else if (drag.type === 'leave') setDragging(false)
				else if (drag.type === 'drop') {
					setDragging(false)
					if (drag.paths.length > 0) void uploadDropped(drag.paths)
				}
			})
			.then((fn) => {
				if (live) unlisten = fn
				else fn()
			})
			.catch((e: unknown) => {
				void error(
					`file explorer: drag and drop unavailable: ${String(e)}`,
				)
			})
		return (): void => {
			live = false
			unlisten?.()
		}
	}, [serial])

	const busy = status?.kind === 'busy'
	const idle = !loading && !busy
	// Rows belong to the listed folder, which differs from `location` while loading.
	const rowsAt = listedAt ?? location
	const entryAt = (name: string): FileLocation => ({
		path: joinPath(rowsAt.path, name),
		runAs: rowsAt.runAs,
	})
	const selectedEntry =
		listing?.entries.find((e) => e.name === selected) ?? null
	const actionTarget =
		idle && selectedEntry && isActionable(selectedEntry)
			? selectedEntry
			: null
	const atAppRoot =
		location.runAs !== null && location.path === appDataRoot(location.runAs)
	const canGoUp = location.path !== '/' && !atAppRoot

	const refresh = (): void => setReload((n) => n + 1)
	const focusList = (): void => listRef.current?.focus()
	const go = (next: FileLocation): void => {
		setLocation(next)
		setSelected(null)
		setConfirming(null)
		setCreatingFolder(false)
	}
	const goUp = (): void => {
		if (canGoUp) {
			go({ path: parentPath(location.path), runAs: location.runAs })
		}
	}
	const submitPath = (raw: string): void => {
		const path = raw.trim().replace(/\/+$/, '') || '/'
		if (!path.startsWith('/') || path.split('/').includes('..')) {
			setStatus({
				kind: 'error',
				text: 'Enter an absolute device path without "..", e.g. /sdcard/Download',
			})
			return
		}
		go({ path, runAs: location.runAs })
	}

	const run = async (
		busyText: string,
		action: () => Promise<Status>,
	): Promise<void> => {
		setStatus({ kind: 'busy', text: busyText })
		try {
			setStatus(await action())
		} catch (e) {
			setStatus({ kind: 'error', text: String(e) })
			void error(`file explorer: ${busyText} failed: ${String(e)}`)
		}
	}

	const download = (entry: FileEntry): void => {
		const target = entryAt(entry.name)
		void run(`Downloading ${entry.name}…`, async () => {
			const localPath = await downloadFile(serial, target)
			return { kind: 'saved', text: `Saved ${entry.name}`, localPath }
		})
	}

	const open = (entry: FileEntry): void => {
		if (!isActionable(entry)) return
		const target = entryAt(entry.name)
		if (entry.kind === 'dir') go(target)
		else if (entry.kind === 'file') download(entry)
		else if (entry.kind === 'link') {
			listDir(serial, target)
				.then((probe) => {
					if (probe.error && /not a directory/i.test(probe.error)) {
						download(entry)
					} else go(target)
				})
				.catch((e: unknown) =>
					setStatus({ kind: 'error', text: String(e) }),
				)
		}
	}

	const remove = (entry: FileEntry): void => {
		const target = entryAt(entry.name)
		setConfirming(null)
		void run(`Deleting ${entry.name}…`, async () => {
			await deletePath(serial, target)
			setSelected(null)
			refresh()
			return { kind: 'info', text: `Deleted ${target.path}` }
		})
		focusList()
	}

	const createFolder = (name: string): void => {
		setCreatingFolder(false)
		const target = {
			path: joinPath(location.path, name),
			runAs: location.runAs,
		}
		void run(`Creating ${name}…`, async () => {
			await makeDir(serial, target)
			refresh()
			return { kind: 'info', text: `Created ${target.path}` }
		})
		focusList()
	}

	const uploadPicked = (files: File[]): void => {
		const dir = location
		void run(`Uploading ${files.length} file(s)…`, async () => {
			const failed: string[] = []
			for (const file of files) {
				try {
					const bytes = new Uint8Array(await file.arrayBuffer())
					await uploadBytes(serial, dir, file.name, bytes)
				} catch (e) {
					failed.push(`${file.name}: ${String(e)}`)
				}
			}
			refresh()
			const done = files.length - failed.length
			return failed.length === 0
				? {
						kind: 'info',
						text: `Uploaded ${done} file(s) to ${dir.path}`,
					}
				: {
						kind: 'error',
						text: `Uploaded ${done} of ${files.length}. ${failed.join(' · ')}`,
					}
		})
	}

	const copyPath = (entry: FileEntry): void => {
		const { path } = entryAt(entry.name)
		void run('Copying path…', async () => {
			await writeText(path)
			return { kind: 'info', text: `Copied ${path}` }
		})
	}

	const onListKey = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
		if (e.target !== e.currentTarget || !idle) return
		const entries = listing?.entries ?? []
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault()
			const index = entries.findIndex((x) => x.name === selected)
			const step = e.key === 'ArrowDown' ? 1 : -1
			const next =
				entries[Math.min(entries.length - 1, Math.max(0, index + step))]
			if (next) setSelected(next.name)
		} else if (e.key === 'Enter' && !e.repeat && selectedEntry) {
			open(selectedEntry)
		} else if (e.key === 'Backspace') {
			e.preventDefault()
			goUp()
		} else if (e.key === 'Delete' && actionTarget) {
			setConfirming(entryAt(actionTarget.name).path)
		} else if (e.key === 'Escape') {
			setConfirming(null)
		}
	}

	const confirmTarget =
		actionTarget && confirming === entryAt(actionTarget.name).path
			? actionTarget
			: null

	return (
		<div className='explorer'>
			<div className='explorer-bar'>
				<button
					onClick={goUp}
					disabled={!canGoUp}
					title='Up (Backspace)'
				>
					↑
				</button>
				<button onClick={refresh} title='Refresh'>
					⟳
				</button>
				<PathInput
					key={`${location.runAs ?? ''}:${location.path}`}
					path={location.path}
					onSubmit={submitPath}
				/>
				{location.runAs && (
					<>
						<span
							className='badge wait'
							title='Private app data, read through run-as'
						>
							run-as {location.runAs}
						</span>
						<button onClick={() => go(HOME)}>Leave app data</button>
					</>
				)}
			</div>
			<div className='explorer-bar'>
				{QUICK_PATHS.map((path) => (
					<button
						key={path}
						onClick={() => go({ path, runAs: null })}
					>
						{path}
					</button>
				))}
				<AppDataPicker
					serial={serial}
					onOpen={(pkg) => go({ path: appDataRoot(pkg), runAs: pkg })}
				/>
				<span className='spacer' />
				<button
					disabled={!idle}
					onClick={() => setCreatingFolder(true)}
				>
					New folder
				</button>
				<button
					disabled={!idle}
					onClick={() => fileInput.current?.click()}
				>
					Upload…
				</button>
				<button
					disabled={actionTarget?.kind !== 'file'}
					onClick={() => actionTarget && download(actionTarget)}
				>
					Download
				</button>
				<button
					disabled={!actionTarget}
					onClick={() =>
						actionTarget &&
						setConfirming(entryAt(actionTarget.name).path)
					}
				>
					Delete
				</button>
				<button
					disabled={!actionTarget}
					onClick={() => actionTarget && copyPath(actionTarget)}
				>
					Copy path
				</button>
				<input
					ref={fileInput}
					type='file'
					multiple
					hidden
					onChange={(e) => {
						const files = Array.from(e.target.files ?? [])
						e.target.value = ''
						if (files.length > 0) uploadPicked(files)
					}}
				/>
			</div>

			{confirmTarget && (
				<div
					className='confirm'
					onKeyDown={(e) => {
						if (e.key === 'Escape') {
							setConfirming(null)
							focusList()
						}
					}}
				>
					<span>
						Delete <code>{entryAt(confirmTarget.name).path}</code>
						{confirmTarget.kind === 'dir'
							? ' and everything in it'
							: ''}
						? This can't be undone.
					</span>
					<button
						className='danger'
						onClick={() => remove(confirmTarget)}
					>
						Delete
					</button>
					<button
						autoFocus
						onClick={() => {
							setConfirming(null)
							focusList()
						}}
					>
						Cancel
					</button>
				</div>
			)}
			{listing?.error && <p className='hint bad'>{listing.error}</p>}

			<div
				ref={listRef}
				className={loading ? 'file-list loading' : 'file-list'}
				tabIndex={0}
				onKeyDown={onListKey}
			>
				<table>
					<thead>
						<tr>
							<th>Name</th>
							<th className='num'>Size</th>
							<th>Modified</th>
							<th>Permissions</th>
						</tr>
					</thead>
					<tbody>
						{creatingFolder && (
							<tr>
								<td colSpan={4}>
									<FolderNameInput
										onDone={(name) => {
											if (name) createFolder(name)
											else {
												setCreatingFolder(false)
												focusList()
											}
										}}
									/>
								</td>
							</tr>
						)}
						{listing?.entries.map((entry) => (
							<tr
								key={entry.name}
								className={
									entry.name === selected
										? 'selected'
										: undefined
								}
								onClick={() => setSelected(entry.name)}
								onDoubleClick={() => open(entry)}
							>
								<td className='name'>
									<span className='icon'>
										{ICON[entry.kind]}
									</span>
									{entry.name}
								</td>
								<td className='num'>
									{entry.kind === 'file'
										? formatSize(entry.size)
										: ''}
								</td>
								<td>{formatTime(entry.modified)}</td>
								<td className='mode'>{entry.mode}</td>
							</tr>
						))}
					</tbody>
				</table>
				{!listing && <p className='muted list-note'>Loading…</p>}
				{listing && listing.entries.length === 0 && !listing.error && (
					<p className='muted list-note'>Empty folder</p>
				)}
				{dragging && (
					<div className='drop-overlay'>
						Drop to upload to {location.path}
					</div>
				)}
			</div>
			<StatusLine status={status} />
		</div>
	)
}

interface PathInputProps {
	path: string
	onSubmit: (path: string) => void
}

const PathInput = ({ path, onSubmit }: PathInputProps): JSX.Element => {
	const [value, setValue] = useState(path)
	return (
		<input
			className='path-input'
			aria-label='Device path'
			spellCheck={false}
			value={value}
			onChange={(e) => setValue(e.target.value)}
			onKeyDown={(e) => {
				if (e.key === 'Enter') onSubmit(value)
				if (e.key === 'Escape') setValue(path)
			}}
		/>
	)
}

interface FolderNameInputProps {
	onDone: (name: string | null) => void
}

const FolderNameInput = ({ onDone }: FolderNameInputProps): JSX.Element => {
	const [value, setValue] = useState('')
	const finished = useRef(false)
	const finish = (name: string | null): void => {
		if (finished.current) return
		finished.current = true
		const clean = name?.trim() ?? ''
		const valid =
			clean !== '' &&
			clean !== '.' &&
			clean !== '..' &&
			!clean.includes('/')
		onDone(valid ? clean : null)
	}
	return (
		<input
			className='path-input'
			aria-label='New folder name'
			autoFocus
			placeholder='New folder name, Enter to create, Escape to cancel'
			value={value}
			onChange={(e) => setValue(e.target.value)}
			onKeyDown={(e) => {
				if (e.key === 'Enter') finish(value)
				if (e.key === 'Escape') finish(null)
			}}
			onBlur={() => finish(null)}
		/>
	)
}

interface AppDataPickerProps {
	serial: string
	onOpen: (pkg: string) => void
}

const AppDataPicker = ({ serial, onOpen }: AppDataPickerProps): JSX.Element => {
	const [value, setValue] = useState('')
	const [packages, setPackages] = useState<string[] | null>(null)
	const listId = `packages-${serial}`

	const loadPackages = (): void => {
		if (packages !== null) return
		setPackages([])
		listPackages(serial)
			.then(setPackages)
			.catch((e: unknown) => {
				setPackages(null)
				void error(
					`file explorer: listing packages failed: ${String(e)}`,
				)
			})
	}
	const submit = (): void => {
		const pkg = value.trim()
		if (pkg) onOpen(pkg)
	}

	return (
		<span className='app-data'>
			<input
				list={listId}
				aria-label='App package'
				placeholder='App data: package'
				spellCheck={false}
				value={value}
				onFocus={loadPackages}
				onChange={(e) => setValue(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === 'Enter') submit()
				}}
			/>
			<datalist id={listId}>
				{packages?.map((pkg) => <option key={pkg} value={pkg} />)}
			</datalist>
			<button disabled={!value.trim()} onClick={submit}>
				Open app data
			</button>
		</span>
	)
}

interface StatusLineProps {
	status: Status | null
}

const StatusLine = ({ status }: StatusLineProps): JSX.Element => {
	if (!status) {
		return (
			<div className='explorer-status muted'>
				Double-click a folder to open it or a file to download it. Drop
				files here to upload them.
			</div>
		)
	}
	if (status.kind === 'saved') {
		const { localPath } = status
		return (
			<div className='explorer-status ok'>
				{status.text} to <code>{localPath}</code>
				<button
					className='link'
					onClick={() => {
						revealFile(localPath).catch((e: unknown) => {
							void error(
								`file explorer: reveal failed: ${String(e)}`,
							)
						})
					}}
				>
					Show in folder
				</button>
			</div>
		)
	}
	const tone =
		status.kind === 'error' ? 'err' : status.kind === 'busy' ? 'muted' : ''
	return <div className={`explorer-status ${tone}`}>{status.text}</div>
}
