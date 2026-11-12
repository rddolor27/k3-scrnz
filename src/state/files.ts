import { useEffect, useState } from 'react'

import { type FileLocation, listDir, type Listing } from '../lib/ipc'

export interface ListingState {
	listing: Listing | null
	/** Where `listing` came from. Actions on its rows must use this, not the
	 * location being loaded, or they would hit a same-named file elsewhere. */
	listedAt: FileLocation | null
	loading: boolean
}

/** Lists `location`; keeps the previous listing visible while loading. */
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
