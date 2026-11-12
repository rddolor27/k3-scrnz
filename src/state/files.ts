import { useEffect, useState } from 'react'

import { type FileLocation, listDir, type Listing } from '../lib/ipc'

export interface ListingState {
	listing: Listing | null
	listedAt: FileLocation | null
	loading: boolean
}

export const useListing = (
	serial: string,
	location: FileLocation,
	reload: number,
): ListingState => {
	const key = `${serial}|${location.runAs ?? ''}|${location.path}|${reload}`
	const [result, setResult] = useState<{
		key: string
		listedAt: FileLocation
		listing: Listing
	} | null>(null)

	useEffect(() => {
		let live = true
		listDir(serial, location)
			.then((listing) => {
				if (live) {
					setResult({
						key,
						listedAt: { path: listing.path, runAs: location.runAs },
						listing,
					})
				}
			})
			.catch((e: unknown) => {
				if (live) {
					setResult({
						key,
						listedAt: location,
						listing: {
							path: location.path,
							entries: [],
							error: String(e),
						},
					})
				}
			})
		return (): void => {
			live = false
		}
	}, [key, serial, location])

	return {
		listing: result?.listing ?? null,
		listedAt: result?.listedAt ?? null,
		loading: result?.key !== key,
	}
}
