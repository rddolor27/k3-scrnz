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
	listPackages,
	makeDir,
	revealFile,
	uploadBytes,
	uploadPath,
} from '../lib/ipc'
import { error } from '../lib/log'
import { appDataRoot, formatSize, formatTime, joinPath } from '../lib/paths'
import { type FolderState, useFileTree } from '../state/files'
import { Icon, type IconName } from './Icon'
import { IconButton } from './IconButton'

const HOME: FileLocation = { path: '/sdcard', runAs: null }
const QUICK_PATHS = ['/sdcard', '/data/local/tmp', '/']
const INDENT_PX = 16
const NOTE_INDENT_PX = 24
const NOT_A_FOLDER = /not a directory/i
const KIND_ICON: Record<FileKind, IconName> = {
	dir: 'folder',
	file: 'file',
	link: 'link',
	other: 'special',
}
// Mirrors delete_path's refusals in files.rs so the button explains instead of failing.
const PROTECTED = new Set([
	'/sdcard/Android',
	'/storage/emulated',
	'/storage/emulated/0',
	'/storage/emulated/0/Android',
	'/storage/self',
	'/storage/self/primary',
	'/mnt/sdcard',
	'/data/local/tmp',
])
const APP_DATA_ROOT = /^\/data\/(data|user\/\d+)\/[^/]+$/
const PERMISSION_DENIED = /permission denied/i

const deleteRefusal = (path: string): string | null => {
	if (path.split('/').length - 1 < 2) {
		return 'Top-level folders are never deleted'
	}
	if (PROTECTED.has(path)) return 'This storage folder is never deleted'
	if (APP_DATA_ROOT.test(path)) return "An app's data folder is never deleted"
	return null
}

interface DeniedHelp {
	hint: string
	jump: string | null
}

const deniedHelp = (dir: string): DeniedHelp => {
	if (dir === '/storage' || dir === '/storage/emulated') {
		return {
			hint: 'Your files are in /storage/emulated/0, the same folder as /sdcard.',
			jump: '/storage/emulated/0',
		}
	}
	if (dir === '/data' || dir.startsWith('/data/')) {
		return {
			hint: "For an app's private files, use App data at the top (debug builds only).",
			jump: '/data/local/tmp',
		}
	}
	return {
		hint: 'If you know a folder inside it, type its path in the box at the top.',
		jump: null,
	}
}

type Status =
	| { kind: 'busy' | 'info' | 'error'; text: string }
	| { kind: 'saved'; text: string; localPath: string }

interface EntryRow {
	type: 'entry'
	key: string
	path: string
	parent: string
	depth: number
	entry: FileEntry
}

type Row =
	| EntryRow
	| {
			type: 'note'
			key: string
			dir: string
			depth: number
			text: string
			error: boolean
	  }
	| { type: 'create'; key: string; depth: number; parent: string }

// Names with line breaks can't be addressed safely: shown, not acted on.
const isActionable = (entry: FileEntry): boolean => !/[\n\r]/.test(entry.name)

const baseName = (localPath: string): string =>
	localPath.split(/[\\/]/).pop() ?? localPath

const pointsToFile = (folder: FolderState | undefined): boolean =>
	folder?.error != null && NOT_A_FOLDER.test(folder.error)

const isExpandable = (
	entry: FileEntry,
	folder: FolderState | undefined,
): boolean =>
	entry.kind === 'dir' || (entry.kind === 'link' && !pointsToFile(folder))

const isEntryRow = (row: Row): row is EntryRow => row.type === 'entry'

const flatten = (
	root: string,
	folders: ReadonlyMap<string, FolderState>,
	expanded: ReadonlySet<string>,
	creatingIn: string | null,
): Row[] => {
	const rows: Row[] = []
	const walk = (dir: string, depth: number): void => {
		if (creatingIn === dir) {
			rows.push({
				type: 'create',
				key: `${dir}#create`,
				depth,
				parent: dir,
			})
		}
		const folder = folders.get(dir)
		if (!folder || (folder.loading && folder.entries === null)) {
			rows.push({
				type: 'note',
				key: `${dir}#loading`,
				dir,
				depth,
				text: 'Loading…',
				error: false,
			})
			return
		}
		if (folder.error !== null && !pointsToFile(folder)) {
			rows.push({
				type: 'note',
				key: `${dir}#error`,
				dir,
				depth,
				text: folder.error,
				error: true,
			})
		}
		const entries = folder.entries ?? []
		if (folder.error === null && entries.length === 0) {
			rows.push({
				type: 'note',
				key: `${dir}#empty`,
				dir,
				depth,
				text: 'Empty folder',
				error: false,
			})
		}
		for (const entry of entries) {
			const path = joinPath(dir, entry.name)
			rows.push({
				type: 'entry',
				key: path,
				path,
				parent: dir,
				depth,
				entry,
			})
			if (expanded.has(path) && isExpandable(entry, folders.get(path))) {
				walk(path, depth + 1)
			}
		}
	}
	walk(root, 0)
	return rows
}

interface FileExplorerProps {
	serial: string
}

export const FileExplorer = ({ serial }: FileExplorerProps): JSX.Element => {
	const [root, setRoot] = useState<FileLocation>(HOME)
	const tree = useFileTree(serial, root)
	const [selected, setSelected] = useState<string | null>(null)
	const [status, setStatus] = useState<Status | null>(null)
	const [confirming, setConfirming] = useState<string | null>(null)
	const [creatingIn, setCreatingIn] = useState<string | null>(null)
	const [dragging, setDragging] = useState(false)
	const fileInput = useRef<HTMLInputElement>(null)
	const listRef = useRef<HTMLDivElement>(null)
	const dropTarget = useRef<FileLocation>(root)
	const reloadRef = useRef(tree.reload)

	const rows = flatten(root.path, tree.folders, tree.expanded, creatingIn)
	const entryRows = rows.filter(isEntryRow)
	const selectedRow = entryRows.find((r) => r.path === selected) ?? null
	const busy = status?.kind === 'busy'
	const actionRow =
		!busy && selectedRow && isActionable(selectedRow.entry)
			? selectedRow
			: null
	const targetDir = selectedRow
		? selectedRow.entry.kind === 'dir'
			? selectedRow.path
			: selectedRow.parent
		: root.path
	const at = (path: string): FileLocation => ({ path, runAs: root.runAs })

	useEffect(() => {
		dropTarget.current = { path: targetDir, runAs: root.runAs }
		reloadRef.current = tree.reload
	})

	useEffect(() => {
		listRef.current
			?.querySelector('tr.selected')
			?.scrollIntoView({ block: 'nearest' })
	}, [selected])

	useEffect(() => {
		let live = true
		let unlisten: (() => void) | null = null
		const uploadDropped = async (paths: string[]): Promise<void> => {
			const dir = dropTarget.current
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
			reloadRef.current(dir.path)
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

	const focusList = (): void => listRef.current?.focus()

	const changeRoot = (next: FileLocation): void => {
		setRoot(next)
		setSelected(null)
		setConfirming(null)
		setCreatingIn(null)
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
		changeRoot({ path, runAs: root.runAs })
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

	const download = (row: EntryRow): void => {
		void run(`Downloading ${row.entry.name}…`, async () => {
			const localPath = await downloadFile(serial, at(row.path))
			return { kind: 'saved', text: `Saved ${row.entry.name}`, localPath }
		})
	}

	const open = (row: EntryRow): void => {
		if (!isActionable(row.entry)) return
		const folder = tree.folders.get(row.path)
		if (row.entry.kind === 'file' || pointsToFile(folder)) download(row)
		else if (isExpandable(row.entry, folder)) tree.toggle(row.path)
	}

	const remove = (row: EntryRow): void => {
		setConfirming(null)
		void run(`Deleting ${row.entry.name}…`, async () => {
			await deletePath(serial, at(row.path))
			setSelected(null)
			tree.reload(row.parent)
			return { kind: 'info', text: `Deleted ${row.path}` }
		})
		focusList()
	}

	const startCreate = (): void => {
		setCreatingIn(targetDir)
		if (targetDir !== root.path) tree.expand(targetDir)
	}

	const createFolder = (dir: string, name: string): void => {
		setCreatingIn(null)
		const path = joinPath(dir, name)
		void run(`Creating ${name}…`, async () => {
			await makeDir(serial, at(path))
			tree.reload(dir)
			setSelected(path)
			return { kind: 'info', text: `Created ${path}` }
		})
		focusList()
	}

	const uploadPicked = (files: File[]): void => {
		const dir = targetDir
		void run(`Uploading ${files.length} file(s)…`, async () => {
			const failed: string[] = []
			for (const file of files) {
				try {
					const bytes = new Uint8Array(await file.arrayBuffer())
					await uploadBytes(serial, at(dir), file.name, bytes)
				} catch (e) {
					failed.push(`${file.name}: ${String(e)}`)
				}
			}
			tree.reload(dir)
			const done = files.length - failed.length
			return failed.length === 0
				? { kind: 'info', text: `Uploaded ${done} file(s) to ${dir}` }
				: {
						kind: 'error',
						text: `Uploaded ${done} of ${files.length}. ${failed.join(' · ')}`,
					}
		})
	}

	const copyPath = (row: EntryRow): void => {
		void run('Copying path…', async () => {
			await writeText(row.path)
			return { kind: 'info', text: `Copied ${row.path}` }
		})
	}

	const onListKey = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
		if (e.target !== e.currentTarget || busy) return
		const index = entryRows.findIndex((r) => r.path === selected)
		const select = (row: EntryRow | undefined): void => {
			if (row) setSelected(row.path)
		}
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault()
			const step = e.key === 'ArrowDown' ? 1 : -1
			select(
				entryRows[
					Math.min(entryRows.length - 1, Math.max(0, index + step))
				],
			)
		} else if (e.key === 'ArrowRight' && selectedRow) {
			e.preventDefault()
			const folder = tree.folders.get(selectedRow.path)
			if (!isExpandable(selectedRow.entry, folder)) return
			if (!tree.expanded.has(selectedRow.path))
				tree.expand(selectedRow.path)
			else select(entryRows.find((r) => r.parent === selectedRow.path))
		} else if (e.key === 'ArrowLeft' && selectedRow) {
			e.preventDefault()
			if (tree.expanded.has(selectedRow.path))
				tree.collapse(selectedRow.path)
			else select(entryRows.find((r) => r.path === selectedRow.parent))
		} else if (e.key === 'Enter' && !e.repeat && selectedRow) {
			open(selectedRow)
		} else if (e.key === 'Delete' && actionRow) {
			const refused = deleteRefusal(actionRow.path)
			if (refused) setStatus({ kind: 'error', text: refused })
			else setConfirming(actionRow.path)
		} else if (e.key === 'F5') {
			e.preventDefault()
			tree.refresh()
		} else if (e.key === 'Escape') {
			setConfirming(null)
			setCreatingIn(null)
		}
	}

	const confirmRow =
		actionRow && confirming === actionRow.path ? actionRow : null
	const refusal = actionRow ? deleteRefusal(actionRow.path) : null

	return (
		<div className='explorer'>
			<div className='explorer-bar'>
				<span
					className='tool-group'
					role='group'
					aria-label='Folder to browse'
				>
					{QUICK_PATHS.map((path) => (
						<button
							key={path}
							aria-pressed={
								root.runAs === null && root.path === path
							}
							onClick={() => changeRoot({ path, runAs: null })}
						>
							{path}
						</button>
					))}
				</span>
				<PathInput
					key={`${root.runAs ?? ''}:${root.path}`}
					path={root.path}
					onSubmit={submitPath}
				/>
				<AppDataPicker
					serial={serial}
					onOpen={(pkg) =>
						changeRoot({ path: appDataRoot(pkg), runAs: pkg })
					}
				/>
				{root.runAs && (
					<>
						<span
							className='badge wait'
							title='Private app data, read through run-as'
						>
							run-as {root.runAs}
						</span>
						<button onClick={() => changeRoot(HOME)}>
							Leave app data
						</button>
					</>
				)}
			</div>
			<div className='explorer-bar'>
				<span className='tool-group'>
					<IconButton
						icon='refresh'
						label='Refresh'
						hint='Refresh (F5)'
						onClick={tree.refresh}
					/>
					<IconButton
						icon='collapse'
						label='Collapse all'
						disabled={tree.expanded.size === 0}
						onClick={tree.collapseAll}
					/>
				</span>
				<span
					className='explorer-target'
					title='New folders, uploads and dropped files go here'
				>
					<Icon name='folderOpen' />
					<code>{targetDir}</code>
				</span>
				<span className='spacer' />
				<button disabled={busy} onClick={startCreate}>
					<Icon name='folderPlus' />
					New folder
				</button>
				<button
					disabled={busy}
					onClick={() => fileInput.current?.click()}
				>
					<Icon name='upload' />
					Upload…
				</button>
				<button
					disabled={actionRow?.entry.kind !== 'file'}
					onClick={() => actionRow && download(actionRow)}
				>
					<Icon name='download' />
					Download
				</button>
				<button
					disabled={!actionRow || refusal !== null}
					title={
						refusal ??
						(actionRow
							? 'Delete the selected item (Del)'
							: 'Select a file or folder to delete')
					}
					onClick={() => actionRow && setConfirming(actionRow.path)}
				>
					<Icon name='trash' />
					Delete
				</button>
				<button
					disabled={!actionRow}
					onClick={() => actionRow && copyPath(actionRow)}
				>
					<Icon name='copy' />
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

			{confirmRow && (
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
						Delete <code>{confirmRow.path}</code>
						{confirmRow.entry.kind === 'dir'
							? ' and everything in it'
							: ''}
						? This can't be undone.
					</span>
					<button
						className='danger'
						onClick={() => remove(confirmRow)}
					>
						<Icon name='trash' />
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

			<div
				ref={listRef}
				className='file-list'
				tabIndex={0}
				onKeyDown={onListKey}
			>
				<table role='treegrid' aria-label='Device files'>
					<thead>
						<tr>
							<th>Name</th>
							<th className='num'>Size</th>
							<th>Modified</th>
							<th>Permissions</th>
						</tr>
					</thead>
					<tbody>
						{rows.map((row) => {
							if (row.type === 'entry') {
								const folder = tree.folders.get(row.path)
								const expandable = isExpandable(
									row.entry,
									folder,
								)
								return (
									<TreeRow
										key={row.key}
										row={row}
										selected={row.path === selected}
										expandable={expandable}
										open={
											expandable &&
											tree.expanded.has(row.path)
										}
										onSelect={() => setSelected(row.path)}
										onToggle={() => tree.toggle(row.path)}
										onOpen={() => open(row)}
									/>
								)
							}
							const indent =
								row.depth * INDENT_PX + NOTE_INDENT_PX
							if (row.type === 'create') {
								return (
									<tr key={row.key}>
										<td colSpan={4}>
											<div
												className='tree-name'
												style={{ paddingLeft: indent }}
											>
												<Icon name='folderPlus' />
												<FolderNameInput
													onDone={(name) => {
														if (name) {
															createFolder(
																row.parent,
																name,
															)
														} else {
															setCreatingIn(null)
															focusList()
														}
													}}
												/>
											</div>
										</td>
									</tr>
								)
							}
							const denied =
								row.error && PERMISSION_DENIED.test(row.text)
							return (
								<tr
									key={row.key}
									className={
										row.error && !denied
											? 'tree-note err'
											: 'tree-note'
									}
								>
									<td
										colSpan={4}
										style={{ paddingLeft: indent + 10 }}
									>
										{denied ? (
											<DeniedNote
												help={deniedHelp(row.dir)}
												onJump={(path) =>
													changeRoot({
														path,
														runAs: null,
													})
												}
											/>
										) : (
											row.text
										)}
									</td>
								</tr>
							)
						})}
					</tbody>
				</table>
				{dragging && (
					<div className='drop-overlay'>
						Drop to upload into {targetDir}
					</div>
				)}
			</div>
			<StatusLine status={status} />
		</div>
	)
}

interface TreeRowProps {
	row: EntryRow
	selected: boolean
	expandable: boolean
	open: boolean
	onSelect: () => void
	onToggle: () => void
	onOpen: () => void
}

const TreeRow = ({
	row,
	selected,
	expandable,
	open,
	onSelect,
	onToggle,
	onOpen,
}: TreeRowProps): JSX.Element => (
	<tr
		className={selected ? 'selected' : undefined}
		aria-level={row.depth + 1}
		aria-expanded={expandable ? open : undefined}
		aria-selected={selected}
		onClick={onSelect}
		onDoubleClick={onOpen}
	>
		<td className='name'>
			<div
				className='tree-name'
				style={{ paddingLeft: row.depth * INDENT_PX }}
			>
				{expandable ? (
					<button
						className='tree-toggle'
						tabIndex={-1}
						aria-label={`${open ? 'Collapse' : 'Expand'} ${row.entry.name}`}
						onClick={(e) => {
							e.stopPropagation()
							onSelect()
							onToggle()
						}}
						onDoubleClick={(e) => e.stopPropagation()}
					>
						<Icon
							name={open ? 'chevronDown' : 'chevronRight'}
							size={14}
						/>
					</button>
				) : (
					<span className='tree-toggle' aria-hidden='true' />
				)}
				<Icon
					name={
						row.entry.kind === 'dir' && open
							? 'folderOpen'
							: KIND_ICON[row.entry.kind]
					}
				/>
				<span className='file-name'>{row.entry.name}</span>
			</div>
		</td>
		<td className='num'>
			{row.entry.kind === 'file' ? formatSize(row.entry.size) : ''}
		</td>
		<td>{formatTime(row.entry.modified)}</td>
		<td className='mode'>{row.entry.mode}</td>
	</tr>
)

interface DeniedNoteProps {
	help: DeniedHelp
	onJump: (path: string) => void
}

const DeniedNote = ({ help, onJump }: DeniedNoteProps): JSX.Element => {
	const { hint, jump } = help
	return (
		<span className='denied-note'>
			Android doesn't let adb open this folder. {hint}
			{jump !== null && (
				<button className='link' onClick={() => onJump(jump)}>
					Open {jump}
				</button>
			)}
		</span>
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
			aria-label='Folder to browse'
			title='Type a device path and press Enter'
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
				Click the arrow next to a folder to open it in place.
				Double-click a file to download it. Drop files here to upload
				them into the folder shown above the list.
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
