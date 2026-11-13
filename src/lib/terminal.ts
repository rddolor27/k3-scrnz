import { invoke } from '@tauri-apps/api/core'

export type TerminalKind = 'device' | 'project'

export type ProjectKind = 'reactNative' | 'expo' | 'other'

export interface ShellInfo {
	id: string
	label: string
}

export interface TerminalStarted {
	id: string
	serial: string
	title: string
	kind: TerminalKind
	project: ProjectKind | null
	command: string | null
	cwd: string | null
	shell: string | null
}

export type TerminalSpec =
	| { kind: 'device' }
	| { kind: 'project'; path: string; run: boolean; shell?: string }

export const listTerminalShells = (): Promise<ShellInfo[]> =>
	invoke<ShellInfo[]>('list_terminal_shells')

export const startTerminal = (
	serial: string,
	spec: TerminalSpec,
): Promise<TerminalStarted> =>
	invoke<TerminalStarted>('start_terminal', { serial, spec })

export const stopTerminal = (id: string): Promise<void> =>
	invoke<void>('stop_terminal', { id })
