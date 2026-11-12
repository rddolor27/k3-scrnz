import './LogcatPanel.css'

import { useVirtualizer } from '@tanstack/react-virtual'
import {
	type JSX,
	type UIEvent,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from 'react'

import {
	DEFAULT_LOG_FILTER,
	FOCUS_LOG_FILTER_EVENT,
	formatLogTime,
	levelClass,
	levelLetter,
	LOG_LEVELS,
	type LogFilter,
	type LogRow,
} from '../lib/logcat'
import { useLogcat } from '../state/logcat'

const ROW_H = 18
const OVERSCAN = 30
const DEBOUNCE_MS = 250
const FOLLOW_SLACK_PX = 8
const NEWLINES = /\r?\n/g
const TRAILING_NEWLINES = /[\r\n]+$/

interface FilterDraft {
	minLevel: number
	tag: string
	text: string
	regex: boolean
	onlyApp: boolean
}

const DEFAULT_DRAFT: FilterDraft = {
	minLevel: DEFAULT_LOG_FILTER.minLevel,
	tag: '',
	text: '',
	regex: DEFAULT_LOG_FILTER.regex,
	onlyApp: DEFAULT_LOG_FILTER.onlyApp,
}

const toFilter = (draft: FilterDraft): LogFilter => {
	const tag = draft.tag.trim()
	return {
		minLevel: draft.minLevel,
		tag: tag === '' ? null : tag,
		text: draft.text === '' ? null : draft.text,
		regex: draft.regex,
		onlyApp: draft.onlyApp,
	}
}

// The regex crate's message spans lines; the last `error:` line is the cause.
const shortError = (text: string): string => {
	const lines = text
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line !== '')
	const cause = lines.filter((line) => line.startsWith('error:')).pop()
	return cause?.slice('error:'.length).trim() ?? lines.join(' ')
}

const oneLine = (msg: string): string => {
	const text = msg.replace(TRAILING_NEWLINES, '')
	return text.includes('\n') ? text.replace(NEWLINES, ' ↵ ') : text
}

interface LogcatPanelProps {
	serial: string
}

export const LogcatPanel = ({ serial }: LogcatPanelProps): JSX.Element => {
	const logcat = useLogcat(serial)
	const { setFilter, setPaused } = logcat
	const [draft, setDraft] = useState(DEFAULT_DRAFT)
	const searchRef = useRef<HTMLInputElement>(null)
	const timer = useRef<number | undefined>(undefined)

	useEffect(() => {
		const focusSearch = (): void => {
			searchRef.current?.focus()
			searchRef.current?.select()
		}
		window.addEventListener(FOCUS_LOG_FILTER_EVENT, focusSearch)
		return (): void => {
			window.removeEventListener(FOCUS_LOG_FILTER_EVENT, focusSearch)
		}
	}, [])

	useEffect(
		() => (): void => {
			window.clearTimeout(timer.current)
		},
		[],
	)

	const edit = (next: FilterDraft, debounce: boolean): void => {
		setDraft(next)
		window.clearTimeout(timer.current)
		if (debounce) {
			timer.current = window.setTimeout(
				() => setFilter(toFilter(next)),
				DEBOUNCE_MS,
			)
		} else {
			setFilter(toFilter(next))
		}
	}

	const appName = logcat.info?.appPackage
	const notFound = logcat.info !== null && logcat.info.appUid === null

	return (
		<section className='logcat' aria-label='Logcat'>
			<div className='logcat-bar'>
				<span className='logcat-title'>Logcat</span>
				<select
					aria-label='Minimum level'
					title='Minimum level'
					value={draft.minLevel}
					onChange={(e) =>
						edit(
							{ ...draft, minLevel: Number(e.target.value) },
							false,
						)
					}
				>
					{LOG_LEVELS.map((level) => (
						<option key={level.value} value={level.value}>
							{level.letter} {level.label}
						</option>
					))}
				</select>
				<input
					className='logcat-tag'
					aria-label='Tag'
					placeholder='tag'
					spellCheck={false}
					value={draft.tag}
					onChange={(e) =>
						edit({ ...draft, tag: e.target.value }, true)
					}
				/>
				<input
					ref={searchRef}
					className={
						logcat.filterError
							? 'logcat-search invalid'
							: 'logcat-search'
					}
					aria-label='Search'
					aria-invalid={logcat.filterError !== null}
					placeholder='search'
					spellCheck={false}
					value={draft.text}
					onChange={(e) =>
						edit({ ...draft, text: e.target.value }, true)
					}
				/>
				<button
					className='logcat-regex'
					aria-pressed={draft.regex}
					title='Search with a regular expression'
					onClick={() =>
						edit({ ...draft, regex: !draft.regex }, false)
					}
				>
					.*
				</button>
				<label
					className='logcat-check'
					title={
						notFound
							? `${appName ?? 'The app'} wasn't found on this device`
							: undefined
					}
				>
					<input
						type='checkbox'
						checked={draft.onlyApp}
						onChange={(e) =>
							edit({ ...draft, onlyApp: e.target.checked }, false)
						}
					/>
					Only {appName ?? 'my app'}
				</label>
				<button
					aria-pressed={logcat.paused}
					title='Freeze the list; lines keep arriving behind it'
					onClick={() => setPaused(!logcat.paused)}
				>
					{logcat.paused ? 'Resume' : 'Pause'}
				</button>
				<button
					onClick={logcat.clear}
					title='Empty the list (the device log is untouched)'
				>
					Clear
				</button>
				<span className='logcat-spacer' />
				{logcat.skipped > 0 && (
					<span
						className='logcat-skipped'
						title='Dropped because the device logged faster than the panel can show'
					>
						{logcat.skipped.toLocaleString()} skipped
					</span>
				)}
				<span className='logcat-count'>
					{logcat.rows.length.toLocaleString()} lines
				</span>
			</div>
			{logcat.filterError && (
				<div className='logcat-note err' title={logcat.filterError}>
					Filter not applied: {shortError(logcat.filterError)}
				</div>
			)}
			{logcat.error ? (
				<div className='logcat-unavailable'>
					<p className='err'>Logcat unavailable: {logcat.error}</p>
					<button onClick={logcat.retry}>Retry</button>
				</div>
			) : (
				<LogList
					key={serial}
					rows={logcat.rows}
					version={logcat.version}
					trimmed={logcat.trimmed}
					epoch={logcat.epoch}
				/>
			)}
		</section>
	)
}

interface LogListProps {
	rows: readonly LogRow[]
	version: number
	trimmed: number
	epoch: number
}

const LogList = ({
	rows,
	version,
	trimmed,
	epoch,
}: LogListProps): JSX.Element => {
	const scrollRef = useRef<HTMLDivElement>(null)
	const appliedTrim = useRef(trimmed)
	const [following, setFollowing] = useState(true)
	const [seenEpoch, setSeenEpoch] = useState(epoch)
	const [selected, setSelected] = useState<LogRow | null>(null)

	if (epoch !== seenEpoch) {
		setSeenEpoch(epoch)
		setFollowing(true)
	}

	// Fine here: nothing from the virtualizer is passed to a memoised child.
	// eslint-disable-next-line react-hooks/incompatible-library
	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: () => ROW_H,
		overscan: OVERSCAN,
	})

	// Fixed rows make `trimmed * ROW_H` an exact scroll compensation.
	useLayoutEffect(() => {
		const el = scrollRef.current
		if (!el) return
		const dropped = Math.max(0, trimmed - appliedTrim.current)
		appliedTrim.current = trimmed
		if (following) {
			const end = el.scrollHeight - el.clientHeight
			if (Math.abs(el.scrollTop - end) > 1) el.scrollTop = end
		} else if (dropped > 0) {
			el.scrollTop -= dropped * ROW_H
		}
	}, [version, trimmed, following, selected])

	const onScroll = (e: UIEvent<HTMLDivElement>): void => {
		const el = e.currentTarget
		const fromEnd = el.scrollHeight - el.scrollTop - el.clientHeight
		setFollowing(fromEnd <= FOLLOW_SLACK_PX)
	}

	return (
		<div className='log-list'>
			<div className='log-body'>
				<div ref={scrollRef} className='log-scroll' onScroll={onScroll}>
					<div
						className='log-canvas'
						style={{ height: virtualizer.getTotalSize() }}
					>
						{virtualizer.getVirtualItems().map((item) => {
							const row = rows[item.index]
							return row ? (
								<LogLine
									key={item.key}
									row={row}
									top={item.start}
									selected={row === selected}
									onSelect={setSelected}
								/>
							) : null
						})}
					</div>
				</div>
				{rows.length === 0 && (
					<p className='log-empty muted'>No log lines</p>
				)}
				{!following && (
					<button
						className='log-jump'
						onClick={() => setFollowing(true)}
					>
						Jump to end
					</button>
				)}
			</div>
			{selected && (
				<LogDetail row={selected} onClose={() => setSelected(null)} />
			)}
		</div>
	)
}

interface LogLineProps {
	row: LogRow
	top: number
	selected: boolean
	onSelect: (row: LogRow) => void
}

const LogLine = ({
	row,
	top,
	selected,
	onSelect,
}: LogLineProps): JSX.Element => {
	const [, tsMs, pid, tid, level, tag, msg] = row
	return (
		<div
			className={`log-row ${levelClass(level)}${selected ? ' selected' : ''}`}
			style={{ transform: `translateY(${top}px)` }}
			onClick={() => onSelect(row)}
		>
			<span className='log-time'>{formatLogTime(tsMs)}</span>
			<span className='log-pid'>
				{pid}-{tid}
			</span>
			<span className='log-level'>{levelLetter(level)}</span>
			<span className='log-tag' title={tag}>
				{tag}
			</span>
			<span className='log-msg'>{oneLine(msg)}</span>
		</div>
	)
}

interface LogDetailProps {
	row: LogRow
	onClose: () => void
}

const LogDetail = ({ row, onClose }: LogDetailProps): JSX.Element => {
	const [, tsMs, pid, tid, level, tag, msg] = row
	return (
		<div className='log-detail'>
			<div className={`log-detail-head ${levelClass(level)}`}>
				<span>{formatLogTime(tsMs)}</span>
				<span>
					{pid}-{tid}
				</span>
				<span className='log-level'>{levelLetter(level)}</span>
				<span className='log-detail-tag'>{tag}</span>
				<button
					className='log-detail-close'
					aria-label='Close details'
					onClick={onClose}
				>
					Close
				</button>
			</div>
			<pre className='log-detail-msg'>{msg}</pre>
		</div>
	)
}
