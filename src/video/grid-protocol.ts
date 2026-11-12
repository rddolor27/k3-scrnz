export interface GridRecorderInit {
	type: 'init'
	port: number
	token: string
	recordingId: string
	width: number
	height: number
}

export interface GridRecorderAdd {
	type: 'add'
	key: string
	label: string
	port: MessagePort
}

export type GridRecorderRequest =
	| GridRecorderInit
	| GridRecorderAdd
	| { type: 'remove'; key: string }
	// Tile keys in grid order.
	| { type: 'order'; keys: string[] }
	| { type: 'stop' }

export type GridLogLevel = 'debug' | 'info' | 'warn' | 'error'

export type GridRecorderEvent =
	| { type: 'started' }
	| { type: 'error'; message: string }
	| { type: 'stopped' }
	| { type: 'log'; level: GridLogLevel; message: string }
