import { invoke } from '@tauri-apps/api/core'

/** Loopback WebSocket endpoint for video and control streams (spec section 8.1). */
export interface Endpoint {
	port: number
	token: string
}

export const getEndpoint = (): Promise<Endpoint> =>
	invoke<Endpoint>('get_endpoint')
