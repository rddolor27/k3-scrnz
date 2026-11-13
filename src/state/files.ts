import { useEffect, useState } from 'react'

import {
	type FileEntry,
	type FileLocation,
	listDir,
	listPackages,
} from '../lib/ipc'

export interface FolderState {
	entries: FileEntry[] | null
	loading: boolean
	error: string | null
	hint: string | null
}

interface TreeState {
	key: string
	folders: ReadonlyMap<string, FolderState>
	expanded: ReadonlySet<string>
}

export interface FileTree {
	folders: ReadonlyMap<string, FolderState>
	expanded: ReadonlySet<string>
	toggle: (path: string) => void
	expand: (path: string) => void
	collapse: (path: string) => void
	collapseAll: () => void
	reload: (path: string) => void
	refresh: () => void
}

const LOADING: FolderState = {
	entries: null,
	loading: true,
	error: null,
	hint: null,
}
const APP_DATA = /^\/data\/(?:data|user\/\d+)\/([^/]+)/
const APP_LIST = /^\/data\/(?:data|user\/\d+)$/
const PERMISSION_DENIED = /permission denied/i

export const runAsFor = (
	path: string,
	rootRunAs: string | null,
): string | null => APP_DATA.exec(path)?.[1] ?? rootRunAs

const virtualFolder = (name: string): FileEntry => ({
	name,
	kind: 'dir',
	size: 0,
	modified: 0,
	mode: '',
})

// The shell user can pass through /data and /data/data but can't list them.
const reachableChildren = async (
	serial: string,
	path: string,
): Promise<FolderState | null> => {
	if (path === '/data') {
		return {
			entries: ['data', 'local'].map(virtualFolder),
			loading: false,
			error: null,
			hint: 'Android hides this folder from adb; these are the parts adb can reach.',
		}
	}
	if (APP_LIST.test(path)) {
		const packages = await listPackages(serial)
		return {
			entries: packages.map(virtualFolder),
			loading: false,
			error: null,
			hint: "Apps you installed. Debug builds open here, as in Android Studio; Android keeps other apps' folders closed.",
		}
	}
	return null
}

const fetchFolder = async (
	serial: string,
	path: string,
	rootRunAs: string | null,
): Promise<FolderState> => {
	const runAs = runAsFor(path, rootRunAs)
	try {
		const listing = await listDir(serial, { path, runAs })
		if (
			runAs === null &&
			listing.error !== null &&
			PERMISSION_DENIED.test(listing.error)
		) {
			const reachable = await reachableChildren(serial, path)
			if (reachable) return reachable
		}
		return {
			entries: listing.entries,
			loading: false,
			error: listing.error,
			hint: null,
		}
	} catch (e) {
		return { entries: null, loading: false, error: String(e), hint: null }
	}
}

const initialState = (key: string, rootPath: string): TreeState => ({
	key,
	folders: new Map([[rootPath, LOADING]]),
	expanded: new Set(),
})

export const useFileTree = (serial: string, root: FileLocation): FileTree => {
	const key = `${serial}|${root.runAs ?? ''}|${root.path}`
	const [state, setState] = useState<TreeState>(() =>
		initialState(key, root.path),
	)
	const current = state.key === key ? state : initialState(key, root.path)
	if (current !== state) setState(current)

	const apply = (forKey: string, path: string, folder: FolderState): void => {
		setState((prev) =>
			prev.key !== forKey
				? prev
				: { ...prev, folders: new Map(prev.folders).set(path, folder) },
		)
	}

	useEffect(() => {
		let live = true
		void fetchFolder(serial, root.path, root.runAs).then((folder) => {
			if (live) apply(key, root.path, folder)
		})
		return (): void => {
			live = false
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps -- `key` covers serial and root; `root` is a new object every render.
	}, [key])

	const reloadAll = (paths: string[]): void => {
		setState((prev) => {
			if (prev.key !== key) return prev
			const folders = new Map(prev.folders)
			for (const path of paths) {
				const known = folders.get(path)
				folders.set(path, {
					entries: known?.entries ?? null,
					loading: true,
					error: null,
					hint: known?.hint ?? null,
				})
			}
			return { ...prev, folders }
		})
		for (const path of paths) {
			void fetchFolder(serial, path, root.runAs).then((folder) =>
				apply(key, path, folder),
			)
		}
	}

	const expand = (path: string): void => {
		if (current.expanded.has(path)) return
		setState((prev) =>
			prev.key !== key
				? prev
				: { ...prev, expanded: new Set(prev.expanded).add(path) },
		)
		const known = current.folders.get(path)
		if (!known || known.error !== null) reloadAll([path])
	}

	const collapse = (path: string): void => {
		setState((prev) => {
			if (prev.key !== key || !prev.expanded.has(path)) return prev
			const expanded = new Set(prev.expanded)
			expanded.delete(path)
			return { ...prev, expanded }
		})
	}

	return {
		folders: current.folders,
		expanded: current.expanded,
		toggle: (path) =>
			current.expanded.has(path) ? collapse(path) : expand(path),
		expand,
		collapse,
		collapseAll: () =>
			setState((prev) =>
				prev.key !== key ? prev : { ...prev, expanded: new Set() },
			),
		reload: (path) => reloadAll([path]),
		refresh: () => reloadAll([root.path, ...current.expanded]),
	}
}
